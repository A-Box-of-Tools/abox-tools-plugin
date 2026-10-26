import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { inflate, inflateRaw } from 'node:zlib';
import { PRESETS } from '../vendor/abox/tools/compress-pdf/src/compress.js';
import { findImages } from '../vendor/abox/tools/compress-pdf/src/images.js';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { Name, PdfStream, PdfString } from '../vendor/abox/shared/js/pdf-objects.js';
import { filterNames } from '../vendor/abox/shared/js/pdf-filters.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { inspectJpeg } from '../vendor/abox/tools/images-to-pdf/src/jpeg.js';
import { withBrowser } from './browser.mjs';
import { MAX_INPUT_BYTES, newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_COMPRESS_PDF_PAGES = 5000;
export const MAX_COMPRESS_PDF_IMAGE_PIXELS = 80000000;
const METADATA_KEYS = ['Metadata', 'PieceInfo', 'LastModified', 'Thumb'];
const inflateBytes = promisify(inflate);
const inflateRawBytes = promisify(inflateRaw);
const REASONS = {
  'kept.jpx': 'JPEG 2000 images have no supported local browser decoder.',
  'kept.jbig2': 'JBIG2 images have no supported local browser decoder.',
  'kept.ccitt': 'Fax-coded images have no supported local browser decoder.',
  'kept.cmyk': 'CMYK images are preserved to avoid changing print colours.',
  'kept.mask': 'Stencil image masks are preserved.',
  'kept.tiny': 'Images smaller than 4 KiB are preserved.',
  'kept.colorspace': 'This image colour space is unsupported for recompression.',
  'kept.unreadable': 'This image could not be decoded safely.',
  'kept.unused': 'No page placement was found for this image.',
  'kept.noencoder': 'The local browser could not encode this image.',
  'kept.alreadysmall': 'Re-encoding did not make this image smaller; its original bytes were kept.',
};

function settingsFor(args) {
  const preset = args.preset ?? 'screen';
  if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'preset must be smallest, screen, print, or gentle.');
  }
  const settings = { preset, dpi: args.dpi ?? PRESETS[preset].dpi,
    quality: args.quality ?? PRESETS[preset].quality, stripMeta: args.strip_metadata ?? true };
  if (!Number.isFinite(settings.dpi) || settings.dpi < 0 || settings.dpi > 1200
      || !Number.isFinite(settings.quality) || settings.quality < 0.3 || settings.quality > 0.95
      || typeof settings.stripMeta !== 'boolean') {
    throw new AdapterError('INVALID_ARGUMENTS', 'dpi must be from 0 to 1200, quality from 0.30 to 0.95, and strip_metadata a boolean. A dpi of 0 keeps the original image resolution.');
  }
  return settings;
}

async function openInput(data) {
  try { return await PdfDocument.open(new Uint8Array(data)); }
  catch (error) {
    if (error instanceof EncryptedPdfError) {
      throw new AdapterError('ENCRYPTED_PDF', 'Encrypted PDFs are unsupported, including those with an empty password.');
    }
    throw new AdapterError('INVALID_PDF', `The PDF could not be read: ${error.message}`);
  }
}

async function boundedInflate(bytes, maximum, signal, failureCode) {
  signal?.throwIfAborted();
  let decoded;
  try { decoded = await inflateBytes(bytes, { maxOutputLength: Math.max(1, maximum), signal }); }
  catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new AdapterError(failureCode, 'A compressed PDF stream exceeds its verification limit. No output was written.');
    try { decoded = await inflateRawBytes(bytes, { maxOutputLength: Math.max(1, maximum), signal }); }
    catch { signal?.throwIfAborted(); throw new AdapterError(failureCode, 'A compressed PDF stream could not be verified within its size limit. No output was written.'); }
  }
  signal?.throwIfAborted();
  if (decoded.length > maximum) throw new AdapterError(failureCode, 'A compressed PDF stream exceeds its verification limit. No output was written.');
  return decoded;
}

function contentStreams(doc, page, failureCode) {
  const contents = doc.get(page.dict, 'Contents');
  const list = contents === null || contents === undefined ? [] : Array.isArray(contents) ? contents : [contents];
  return list.map(value => {
    const stream = doc.resolve(value);
    if (!(stream instanceof PdfStream)) throw new AdapterError(failureCode, 'A PDF page content entry was not a readable stream. No output was written.');
    return stream;
  });
}

function parameterSignature(doc, value) {
  const active = new Set();
  let entries = 0;
  const visit = (item, depth = 0) => {
    entries++;
    if (depth > 16 || entries > 1024) throw new AdapterError('VERIFICATION_FAILED', 'PDF stream parameters exceed the supported verification depth. No output was written.');
    item = doc.resolve(item);
    if (item === null || item === undefined) return null;
    if (typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return Number(item.toFixed(6));
    if (item instanceof Name) return { name: item.value };
    if (item instanceof PdfString) return { string_hash: createHash('sha256').update(item.bytes).digest('hex') };
    if (!(item instanceof Map) && !Array.isArray(item) || active.has(item)) {
      throw new AdapterError('VERIFICATION_FAILED', 'PDF stream parameters cannot be verified safely. No output was written.');
    }
    active.add(item);
    const result = Array.isArray(item) ? { array: item.map(value => visit(value, depth + 1)) }
      : { dictionary: [...item].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, visit(value, depth + 1)]) };
    active.delete(item);
    return result;
  };
  return JSON.stringify(visit(value));
}

function decodeParameters(doc, stream) {
  return doc.resolve(stream.dict.get('DecodeParms') ?? stream.dict.get('DP'));
}

function identityPredictor(doc, parameters) {
  const first = doc.resolve(Array.isArray(parameters) ? parameters[0] : parameters);
  return first === null || first === undefined || first instanceof Map && doc.resolve(first.get('Predictor') ?? 1) === 1;
}

async function checkJpegDimensions(doc, images, signal) {
  for (const image of images) {
    signal?.throwIfAborted();
    if (image.skip || image.kind !== 'jpeg') continue;
    const filters = filterNames(image.stream.dict, value => doc.resolve(value));
    let bytes = image.stream.raw;
    if (filters.length === 2 && ['FlateDecode', 'Fl'].includes(filters[0])
        && ['DCTDecode', 'DCT'].includes(filters[1]) && identityPredictor(doc, decodeParameters(doc, image.stream))) {
      bytes = await boundedInflate(bytes, MAX_INPUT_BYTES, signal, 'PDF_JPEG_STREAM_LIMIT');
    } else if (filters.length !== 1 || !['DCTDecode', 'DCT'].includes(filters[0])) {
      throw new AdapterError('UNSUPPORTED_PDF_JPEG_ENCODING', 'JPEG images must use DCTDecode alone or one FlateDecode wrapper so their actual dimensions can be checked safely.');
    }
    const actual = inspectJpeg(bytes);
    if (!actual) throw new AdapterError('INVALID_PDF_IMAGE', 'A JPEG frame header could not be verified. No output was written.');
    if (actual.width * actual.height > MAX_COMPRESS_PDF_IMAGE_PIXELS) {
      throw new AdapterError('PDF_IMAGE_PIXEL_LIMIT', 'Each PDF image must contain at most 80 megapixels, including its actual JPEG frame dimensions.');
    }
    if (actual.width !== image.width || actual.height !== image.height) {
      throw new AdapterError('INVALID_PDF_IMAGE', 'A PDF image dictionary disagrees with its actual JPEG frame dimensions. No output was written.');
    }
    if (actual.orientation !== 1) {
      throw new AdapterError('UNSUPPORTED_PDF_JPEG_ORIENTATION', 'A JPEG image carries a rotation or reflection that the current browser engine would apply during recompression. This PDF is refused to preserve its page appearance.');
    }
  }
}

async function verifyContents(original, originalStreams, checked, pages, signal) {
  const verified = new WeakMap();
  const hashes = new WeakMap();
  const hash = stream => {
    if (!hashes.has(stream)) hashes.set(stream, createHash('sha256').update(stream.raw).digest('hex'));
    return hashes.get(stream);
  };
  for (const [index, page] of pages.entries()) {
    signal?.throwIfAborted();
    const outputs = contentStreams(checked, page, 'VERIFICATION_FAILED');
    const inputs = originalStreams[index];
    if (inputs.length !== outputs.length) throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF changed its page content streams. No output was written.');
    for (const [at, source] of inputs.entries()) {
      const result = outputs[at];
      if (verified.get(source)?.has(result)) continue;
      const before = filterNames(source.dict, value => original.resolve(value));
      const after = filterNames(result.dict, value => checked.resolve(value));
      let same;
      if (before.length) {
        // The unchanged writer preserves already-filtered streams. Equal bytes and decoding parameters prove equal operators without expanding them.
        same = hash(source) === hash(result) && JSON.stringify(before) === JSON.stringify(after)
          && parameterSignature(original, decodeParameters(original, source)) === parameterSignature(checked, decodeParameters(checked, result));
      } else if (!after.length) same = hash(source) === hash(result);
      else if (after.length === 1 && ['FlateDecode', 'Fl'].includes(after[0]) && identityPredictor(checked, decodeParameters(checked, result))) {
        const bytes = await boundedInflate(result.raw, source.raw.length, signal, 'VERIFICATION_FAILED');
        same = Buffer.from(source.raw).equals(bytes);
      }
      if (!same) throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF changed its page content or stream decoding parameters. No output was written.');
      if (!verified.has(source)) verified.set(source, new WeakSet());
      verified.get(source).add(result);
    }
  }
}

function imageReport(image) {
  return {
    object_number: image.num, action: image.action, input_bytes: image.before, output_bytes: image.after,
    width: image.width, height: image.height, dpi_before: image.dpiBefore, dpi_after: image.dpiAfter,
    ...(image.note ? { reason_code: image.note, reason: REASONS[image.note] ?? 'The source engine left this image unchanged.' } : {}),
  };
}

export async function compressPdf(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.pdf') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .pdf.');
  const input = await readInput(args.input_path);
  const original = await openInput(input.data);
  const pages = readPages(original);
  if (!pages.length || pages.length > MAX_COMPRESS_PDF_PAGES || original.countPages() !== pages.length) {
    throw new AdapterError('PDF_PAGE_LIMIT', `PDFs must have 1 to ${MAX_COMPRESS_PDF_PAGES} readable pages.`);
  }
  // The source engine bounds raw image decoding; apply the same bound before its JPEG decoder allocates pixels.
  const images = findImages(original);
  if (images.some(image => image.width * image.height > MAX_COMPRESS_PDF_IMAGE_PIXELS)) {
    throw new AdapterError('PDF_IMAGE_PIXEL_LIMIT', 'Each PDF image must contain at most 80 megapixels.');
  }
  await checkJpegDimensions(original, images, options.signal);
  const originalStreams = pages.map(page => contentStreams(original, page, 'INVALID_PDF_CONTENT'));
  const hadInformationDictionary = original.trailer.has('Info');
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: path.basename(input.path), mimeType: 'application/pdf', buffer: input.data });
    return page.evaluate(async plan => {
      const { compressDocument } = await import('/vendor/abox/tools/compress-pdf/src/compress.js');
      const file = document.querySelector('#input').files[0];
      const result = await compressDocument(new Uint8Array(await file.arrayBuffer()), plan);
      if (!result.check?.ok) return { error: true };
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('The compressed PDF could not be read.'));
        reader.readAsDataURL(result.blob);
      });
      return { data, before: result.before, after: result.after, images: result.images,
        inventory: result.inventory, metadataRemoved: result.metadataRemoved,
        repaired: Boolean(result.repaired), incremental: Boolean(result.incremental) };
    }, settings);
  }, options);
  if (made.error) throw new AdapterError('VERIFICATION_FAILED', 'The source engine could not verify the compressed PDF. No output was written.');
  const data = Buffer.from(made.data, 'base64');
  let checked;
  let outputPages;
  try {
    checked = await PdfDocument.open(new Uint8Array(data));
    outputPages = readPages(checked);
  } catch { throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF could not be reopened. No output was written.'); }
  if (checked.repaired || checked.countPages() !== pages.length || outputPages.length !== pages.length
      || made.inventory.pages !== pages.length || made.before !== input.data.length || made.after !== data.length) {
    throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF had unexpected page counts or file sizes. No output was written.');
  }
  if (outputPages.some((page, index) => page.rotate !== pages[index].rotate
      || ['box', 'visibleBox'].some(key => page[key].some((value, at) => Math.abs(value - pages[index][key][at]) > 0.000001)))) {
    throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF changed page content, order, dimensions, or rotation. No output was written.');
  }
  await verifyContents(original, originalStreams, checked, outputPages, options.signal);
  if (settings.stripMeta && (checked.trailer.has('Info') || [...checked.objects.values()].some(value => {
    const dict = value instanceof PdfStream ? value.dict : value;
    return dict instanceof Map && METADATA_KEYS.some(key => dict.has(key));
  }))) {
    throw new AdapterError('VERIFICATION_FAILED', 'The compressed PDF retained metadata entries selected for removal. No output was written.');
  }
  const changed = made.images.filter(image => image.action !== 'kept');
  const keptReasons = new Map();
  for (const image of made.images) {
    if (image.action === 'kept' && image.note) keptReasons.set(image.note, (keptReasons.get(image.note) ?? 0) + 1);
  }
  const saved = input.data.length - data.length;
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: 'compress-pdf', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, saved_bytes: saved,
    saved_percent: Math.round(saved / input.data.length * 10000) / 100, smaller: saved > 0,
    input_pages: pages.length, page_count: pages.length,
    preset: settings.preset, dpi: settings.dpi, quality: settings.quality, strip_metadata: settings.stripMeta,
    image_count: made.images.length, images_changed: changed.length,
    images_downsampled: changed.filter(image => image.action === 'downsampled').length,
    images_kept: made.images.length - changed.length,
    images: made.images.slice(0, 20).map(imageReport), images_truncated: made.images.length > 20,
    kept_image_reasons: [...keptReasons].map(([reason_code, count]) => ({ reason_code, count,
      reason: REASONS[reason_code] ?? 'The source engine left these images unchanged.' })),
    inventory: made.inventory.groups.map(({ id, bytes, count }) => ({ id, bytes, count })),
    metadata_entries_removed: made.metadataRemoved + Number(settings.stripMeta && hadInformationDictionary),
    repaired_input: made.repaired, incremental_input: made.incremental, content_verified: true, verified: true,
    warnings: [
      ...(saved <= 0 ? ['The rewritten PDF is not smaller. This document did not benefit from the chosen compression settings.'] : []),
      ...(changed.length ? ['Image recompression can lose detail. Compare the saved pages with the original, especially small text within scanned images.'] : []),
      ...(settings.stripMeta ? ['Standard PDF metadata entries were removed. Images, attachments, annotations, and visible content can still contain personal information.'] : []),
      'Rewriting invalidates digital signatures and removes linearisation and document identifiers.',
      'Page content and geometry were checked; this does not establish visual equivalence of recompressed images.',
      'JPEG image streams support DCTDecode directly or with one FlateDecode wrapper and identity EXIF orientation; other JPEG filter chains or rotated/reflected EXIF orientations are refused.',
    ],
  };
}
