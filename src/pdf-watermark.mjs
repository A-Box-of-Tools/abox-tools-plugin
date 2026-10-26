import path from 'node:path';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { writeDocument } from '../vendor/abox/shared/js/pdf-writer.js';
import { carriesStamp, stampDocument } from '../vendor/abox/tools/watermark-pdf/src/apply.js';
import { formatNumber, placementMatrix, placements, SIZES, visibleSize } from '../vendor/abox/tools/watermark-pdf/src/stamp.js';
import { withBrowser } from './browser.mjs';
import { newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_WATERMARK_PAGES = 5000;
export const MAX_WATERMARK_TEXT = 200;
export const MAX_WATERMARK_STAMPS = 100000;

function watermarkSettings(args) {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const settings = {
    size: args.size ?? 'medium', color: args.color ?? 'grey', opacity: args.opacity ?? 0.2,
    diagonal: args.diagonal ?? true, tiled: args.tiled ?? false,
    firstPageOnly: args.first_page_only ?? false,
  };
  if (!text || text.length > MAX_WATERMARK_TEXT || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)
      || !['small', 'medium', 'large'].includes(settings.size) || !['grey', 'red', 'blue'].includes(settings.color)
      || !Number.isFinite(settings.opacity) || settings.opacity < 0.05 || settings.opacity > 1
      || ['diagonal', 'tiled', 'firstPageOnly'].some(key => typeof settings[key] !== 'boolean')) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Provide one line of 1 to 200 characters and supported watermark size, color, opacity, and placement settings.');
  }
  return { text, settings };
}

async function renderImage(text, color, options) {
  const made = await withBrowser(page => page.evaluate(async ({ words, chosenColor }) => {
    const { renderStamp, COLOURS } = await import('/vendor/abox/tools/watermark-pdf/src/render.js');
    const image = renderStamp(words, COLOURS[chosenColor]);
    const encode = bytes => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('The watermark image could not be read.'));
      reader.readAsDataURL(new Blob([bytes]));
    });
    return { width: image.width, height: image.height,
      rgb: await encode(image.rgb), alpha: await encode(image.alpha) };
  }, { words: text, chosenColor: color }), options);
  const image = { width: made.width, height: made.height,
    rgb: new Uint8Array(Buffer.from(made.rgb, 'base64')), alpha: new Uint8Array(Buffer.from(made.alpha, 'base64')) };
  if (!Number.isInteger(image.width) || image.width < 1 || image.width > 2400
      || !Number.isInteger(image.height) || image.height < 1 || image.height > 1200
      || image.rgb.length !== image.width * image.height * 3 || image.alpha.length !== image.width * image.height) {
    throw new AdapterError('VERIFICATION_FAILED', 'The local browser returned an invalid watermark image.');
  }
  if (!image.alpha.some(value => value > 0)) {
    throw new AdapterError('EMPTY_WATERMARK', 'The installed fonts did not produce a visible watermark. Choose visible text supported by this computer.');
  }
  return image;
}

function chosenPages(pages, settings) {
  return settings.firstPageOnly ? pages.slice(0, 1) : pages;
}

function placementCounts(pages, image, settings) {
  const counts = [];
  let total = 0;
  const aspect = image.width / image.height;
  for (const page of chosenPages(pages, settings)) {
    const visible = visibleSize(page.rotate, page.visibleBox);
    if (![...page.box, ...page.visibleBox, visible.width, visible.height].every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)
        || visible.width <= 0 || visible.height <= 0) {
      throw new AdapterError('UNSUPPORTED_PDF_GEOMETRY', 'A PDF page has unsupported coordinates or visible dimensions.');
    }
    if (settings.tiled) {
      // Check a conservative grid bound before the unchanged engine allocates its placements.
      const reach = settings.diagonal ? Math.hypot(visible.width, visible.height) : Math.min(visible.width, visible.height * aspect);
      const width = Math.min(reach * SIZES[settings.size], visible.height * 0.9 * aspect, visible.width * 0.5);
      const stepX = width * 1.6;
      const stepY = Math.max(width / aspect * 3, width * 0.75);
      const upperBound = Math.ceil(visible.height / stepY) * (Math.ceil(visible.width / stepX) + 3);
      if (!Number.isFinite(upperBound) || upperBound + total > MAX_WATERMARK_STAMPS) {
        throw new AdapterError('WATERMARK_LIMIT', `The selected layout exceeds ${MAX_WATERMARK_STAMPS} watermark placements. Use a centered stamp or fewer pages.`);
      }
    }
    const spots = placements(visible, aspect, settings);
    if (spots.some(spot => {
      const [a, b, c, d] = placementMatrix(spot).map(value => Number(formatNumber(value)));
      return !Number.isFinite(a * d - b * c) || a * d - b * c === 0;
    })) {
      throw new AdapterError('UNSUPPORTED_PDF_GEOMETRY', 'A visible page crop is too small to retain a nonzero watermark transform.');
    }
    const count = spots.length;
    total += count;
    if (!count || total > MAX_WATERMARK_STAMPS) {
      throw new AdapterError('WATERMARK_LIMIT', `The selected layout must contain 1 to ${MAX_WATERMARK_STAMPS} watermark placements.`);
    }
    counts.push(count);
  }
  return { counts, total };
}

async function verifyOutput(data, before, image, settings, done, counts, signal) {
  let doc;
  let pages;
  try {
    doc = await PdfDocument.open(data);
    pages = readPages(doc);
  } catch {
    throw new AdapterError('VERIFICATION_FAILED', 'The watermarked PDF could not be reopened.');
  }
  if (pages.length !== before.length || doc.countPages() !== before.length
      || pages.some((page, index) => page.rotate !== before[index].rotate
        || ['box', 'visibleBox'].some(key => page[key].some((value, at) => Math.abs(value - before[index][key][at]) > 0.0001)))) {
    throw new AdapterError('VERIFICATION_FAILED', 'The watermarked PDF had unexpected page counts, dimensions, or rotations.');
  }
  const decode = async stream => Buffer.from((await decodeStream(stream, value => doc.resolve(value))).bytes).toString('latin1');
  for (const [index, page] of chosenPages(pages, settings).entries()) {
    signal?.throwIfAborted();
    const names = done.names[index];
    if (!(await carriesStamp(doc, page, decode, names))) {
      throw new AdapterError('VERIFICATION_FAILED', 'A selected page did not carry its watermark.');
    }
    const contents = doc.resolve(page.dict.get('Contents'));
    const last = Array.isArray(contents) ? doc.resolve(contents.at(-1)) : contents;
    const drawing = await decode(last);
    const count = drawing.split(`/${names.image} Do`).length - 1;
    const resources = doc.resolve(page.dict.get('Resources') ?? page.inherited.get('Resources'));
    const state = doc.get(doc.get(resources, 'ExtGState'), names.state);
    if (count !== counts[index] || !(state instanceof Map)
        || !Number.isFinite(doc.get(state, 'ca')) || !Number.isFinite(doc.get(state, 'CA'))
        || Math.abs(doc.get(state, 'ca') - settings.opacity) > 0.000001
        || Math.abs(doc.get(state, 'CA') - settings.opacity) > 0.000001) {
      throw new AdapterError('VERIFICATION_FAILED', 'The output had unexpected watermark placements or opacity.');
    }
    if (index === 0) {
      const picture = doc.get(doc.get(resources, 'XObject'), names.image);
      const mask = picture instanceof PdfStream ? doc.get(picture.dict, 'SMask') : null;
      if (!(picture instanceof PdfStream) || !(mask instanceof PdfStream)
          || doc.get(picture.dict, 'Width') !== image.width || doc.get(picture.dict, 'Height') !== image.height
          || doc.get(mask.dict, 'Width') !== image.width || doc.get(mask.dict, 'Height') !== image.height
          || !Buffer.from((await decodeStream(picture, value => doc.resolve(value))).bytes).equals(Buffer.from(image.rgb))
          || !Buffer.from((await decodeStream(mask, value => doc.resolve(value))).bytes).equals(Buffer.from(image.alpha))) {
        throw new AdapterError('VERIFICATION_FAILED', 'The output did not retain the rendered watermark image and transparency.');
      }
    }
  }
}

export async function watermarkPdf(args, options = {}) {
  options.signal?.throwIfAborted();
  const { text, settings } = watermarkSettings(args);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.pdf') {
    throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .pdf.');
  }
  const input = await readInput(args.input_path);
  options.signal?.throwIfAborted();
  let doc;
  let pages;
  try {
    doc = await PdfDocument.open(new Uint8Array(input.data));
    pages = readPages(doc);
  } catch (error) {
    if (error instanceof EncryptedPdfError) {
      throw new AdapterError('ENCRYPTED_PDF', 'Encrypted PDFs are unsupported, including those with an empty password.');
    }
    throw new AdapterError('INVALID_PDF', `The PDF could not be read: ${error.message}`);
  }
  if (!pages.length || pages.length > MAX_WATERMARK_PAGES) {
    throw new AdapterError('PDF_PAGE_LIMIT', `PDFs must have 1 to ${MAX_WATERMARK_PAGES} pages.`);
  }
  const before = pages.map(page => ({ box: [...page.box], visibleBox: [...page.visibleBox], rotate: page.rotate }));
  options.signal?.throwIfAborted();
  const image = await renderImage(text, settings.color, options);
  options.signal?.throwIfAborted();
  const plan = placementCounts(pages, image, settings);
  const done = stampDocument(doc, image, settings);
  if (done.pages !== plan.counts.length || done.stamps !== plan.total || done.names.length !== plan.counts.length) {
    throw new AdapterError('VERIFICATION_FAILED', 'The source engine produced an unexpected watermark count.');
  }
  const blob = await writeDocument(doc, { signal: options.signal, onProgress: options.onProgress });
  options.signal?.throwIfAborted();
  const data = new Uint8Array(await blob.arrayBuffer());
  await verifyOutput(data, before, image, settings, done, plan.counts, options.signal);
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: 'watermark-pdf', input_path: input.path, input_bytes: input.data.length,
    output_path: output, output_bytes: data.length, input_pages: pages.length, page_count: pages.length,
    stamped_page_count: done.pages, stamp_count: done.stamps, stamp_width: image.width, stamp_height: image.height,
    size: settings.size, color: settings.color, opacity: settings.opacity,
    diagonal: settings.diagonal, tiled: settings.tiled, first_page_only: settings.firstPageOnly,
    rasterized: true, stamps_verified: true, verified: true, repaired_input: Boolean(doc.repaired),
    warnings: [
      'The watermark is a raster image drawn with locally installed fonts; it is not selectable or searchable text.',
      'A watermark can be removed with a PDF editor. It does not redact, encrypt, or protect the existing content.',
      'Rewriting changes the PDF, removes prior incremental revisions and the original trailer ID, and invalidates digital signatures.',
      'Existing document metadata, attachments, links, forms, and actions may remain; watermarking does not sanitize the document.',
    ],
  };
}
