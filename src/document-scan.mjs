import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { edgeLengths, isConvex, sharpestCorner, homography, outputSize, pageAspect } from '../vendor/abox/shared/js/document-geometry.js';
import { layoutPage } from '../vendor/abox/tools/document-scanner/src/document.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { MAX_INPUT_BYTES, localPath, readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_SCAN_CONFIG_BYTES = 64 * 1024;
export const MAX_SCAN_PAGES = 16;
export const MAX_SCAN_INPUT_SIDE = 8192;
export const MAX_SCAN_INPUT_PIXELS = 16_000_000;
export const MAX_SCAN_SIDE = 4096;
export const MAX_SCAN_PAGE_PIXELS = 8_000_000;
export const MAX_SCAN_TOTAL_PIXELS = 32_000_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const get = (args, key, fallback) => args[key] === undefined ? fallback : args[key];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const inRange = (value, low, high) => finite(value) && value >= low && value <= high;
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new AdapterError('INVALID_SCAN_CONFIG', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function onlyKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('The local scan JSON contains an unsupported shape or field.');
}

function settingsFor(args) {
  const settings = { format: get(args, 'format', 'pdf'), mode: get(args, 'mode', 'colour'), strength: get(args, 'strength', 50),
    maxSide: get(args, 'max_side', 2800), pageSize: get(args, 'page_size', 'fit'), dpi: get(args, 'dpi', 200),
    margin: get(args, 'margin_mm', 0), quality: get(args, 'quality', 0.82), title: '' };
  if (!Array.isArray(args.input_paths) || !integer(args.input_paths.length, 1, MAX_SCAN_PAGES)
      || !['pdf', 'png'].includes(settings.format) || settings.format === 'png' && args.input_paths.length !== 1
      || !['photo', 'colour', 'grey', 'mono'].includes(settings.mode) || !inRange(settings.strength, 0, 100)
      || !integer(settings.maxSide, 64, MAX_SCAN_SIDE) || !['fit', 'a4', 'a5', 'letter', 'legal'].includes(settings.pageSize)
      || !inRange(settings.dpi, 36, 1200) || !inRange(settings.margin, 0, 50) || !inRange(settings.quality, 0.3, 1)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose 1–16 local images, PDF or single-page PNG, supported cleanup/page settings, strength 0–100 and max_side 64–4096.');
  }
  if (settings.format === 'png' && ['page_size', 'dpi', 'margin_mm', 'quality'].some(key => args[key] !== undefined)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'PDF page size, DPI, margins and JPEG quality do not apply to lossless PNG output.');
  }
  return settings;
}

async function scanConfig(filename, count) {
  const input = await readInput(filename, { max_bytes: MAX_SCAN_CONFIG_BYTES });
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.data); }
  catch { throw new AdapterError('INVALID_UTF8', 'Scan configuration must contain valid UTF-8 JSON.'); }
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '"') {
      for (at++; at < text.length; at++) { if (text[at] === '\\') at++; else if (text[at] === '"') break; }
    } else if (text[at] === '[' || text[at] === '{') { if (++depth > 8) invalid('Scan configuration supports at most eight nested containers.'); }
    else if (text[at] === ']' || text[at] === '}') depth = Math.max(0, depth - 1);
  }
  let tree;
  try { tree = parseJson(text); } catch { invalid('Scan configuration must contain valid JSON. Its contents are omitted from errors.'); }
  const plain = node => {
    if (node.t === 'map') {
      const result = Object.create(null);
      for (const pair of node.pairs) { if (Object.hasOwn(result, pair.key)) invalid('Duplicate scan configuration keys are unsupported.'); result[pair.key] = plain(pair.value); }
      return result;
    }
    if (node.t === 'seq') return node.items.map(plain);
    if (node.t === 'num') return Number(node.raw);
    return node.t === 'null' ? null : node.value;
  };
  const config = plain(tree); onlyKeys(config, ['pages']);
  if (!Array.isArray(config.pages) || config.pages.length !== count) invalid('Provide exactly one ordered page configuration per input image.');
  for (const page of config.pages) {
    onlyKeys(page, ['image_width', 'image_height', 'corners']);
    if (!integer(page.image_width, 1, MAX_SCAN_INPUT_SIDE) || !integer(page.image_height, 1, MAX_SCAN_INPUT_SIDE)
        || page.image_width * page.image_height > MAX_SCAN_INPUT_PIXELS || !Array.isArray(page.corners) || page.corners.length !== 4) {
      invalid('Each scan page needs exact decoded dimensions within 8192 pixels per side and 16 megapixels, and four clockwise corners.');
    }
    for (const point of page.corners) {
      onlyKeys(point, ['x', 'y']);
      if (!inRange(point.x, 0, page.image_width) || !inRange(point.y, 0, page.image_height)) invalid('Every corner must lie inside its declared full-resolution image; corners are never clipped.');
    }
    const quad = page.corners, edges = edgeLengths(quad);
    const signedArea = quad.reduce((sum, point, index) => sum + point.x * quad[(index + 1) % 4].y - quad[(index + 1) % 4].x * point.y, 0);
    const center = { x: quad.reduce((sum, point) => sum + point.x, 0) / 4, y: quad.reduce((sum, point) => sum + point.y, 0) / 4 };
    const clearance = quad.map((point, index) => {
      const next = quad[(index + 1) % 4];
      return Math.abs((next.x - point.x) * (center.y - point.y) - (next.y - point.y) * (center.x - point.x)) / edges[index];
    });
    if (!isConvex(quad) || signedArea <= 0 || edges.some(edge => edge < 64) || sharpestCorner(quad) < 30 || clearance.some(value => value < 12)) {
      invalid('Corners must form a clockwise convex page with edges at least 64 pixels, angles at least 30 degrees and centroid clearance of 12 pixels, to leave room for the source edge inset.');
    }
    const matrix = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], quad);
    if (!matrix || matrix.some(value => !Number.isFinite(value))) invalid('The selected page does not define a finite perspective transform.');
  }
  return { path: input.path, pages: config.pages };
}

function planPages(pages, settings) {
  let pixels = 0;
  return pages.map(page => {
    const shape = pageAspect(page.corners, page.image_width, page.image_height), size = outputSize(page.corners, shape.aspect, settings.maxSide);
    pixels += size.width * size.height;
    if (!integer(size.width, 1, MAX_SCAN_SIDE) || !integer(size.height, 1, MAX_SCAN_SIDE)
        || size.width * size.height > MAX_SCAN_PAGE_PIXELS || pixels > MAX_SCAN_TOTAL_PIXELS) {
      throw new AdapterError('SCAN_PIXEL_LIMIT', 'Scan output supports 4096 pixels per side, 8 megapixels per page and 32 megapixels across all pages. Reduce max_side or the page count.');
    }
    const edges = edgeLengths(page.corners), samples = Math.min(2, Math.max(1, Math.round(Math.max(Math.max(edges[0], edges[2]) / size.width, Math.max(edges[1], edges[3]) / size.height))));
    return { ...size, aspect_method: shape.method, inset_source_pixels: samples * 3, sheet: layoutPage(size, settings) };
  });
}

async function readImages(paths, signal) {
  const checkedPaths = []; let declared = 0;
  for (const value of paths) {
    signal?.throwIfAborted(); const filename = localPath(await realpath(localPath(value))), info = await stat(filename);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Every scan input must be a regular local image file.');
    declared += info.size;
    if (!info.size || declared > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'Combined scan images must contain 1 byte to 128 MiB.');
    checkedPaths.push(filename);
  }
  const images = []; let total = 0;
  for (const filename of checkedPaths) {
    signal?.throwIfAborted(); const input = await readInput(filename); total += input.data.length;
    if (total > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'Combined scan images grew beyond 128 MiB.');
    const image = await supportedImage(input.data), size = rasterInputDimensions(image);
    if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) throw new AdapterError('ANIMATED_IMAGE', 'Scanning accepts still JPEG, PNG and WebP images; animations are refused.');
    if (!size || !integer(size.width, 1, MAX_SCAN_INPUT_SIDE) || !integer(size.height, 1, MAX_SCAN_INPUT_SIDE)
        || size.width * size.height > MAX_SCAN_INPUT_PIXELS) throw new AdapterError('IMAGE_DIMENSIONS', 'Each scan image must fit within 8192 pixels per side and 16 megapixels before decoding.');
    images.push({ ...input, kind: image.kind });
  }
  return { images, total };
}

function verifyPdf(data, records, plans) {
  return PdfDocument.open(new Uint8Array(data)).then(doc => {
    const pages = readSource(doc, 'scan.pdf').pages;
    if (pages.length !== plans.length || doc.countPages() !== plans.length) throw new Error('page count');
    const near = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= 0.0001;
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index], record = records[index], plan = plans[index], sheet = plan.sheet;
      if (page.box.length !== 4 || !page.box.every((value, at) => near(value, [0, 0, sheet.width, sheet.height][at]))) throw new Error('geometry');
      const resources = doc.get(page.dict, 'Resources'), images = doc.get(resources, 'XObject');
      const image = images instanceof Map && images.size === 1 ? doc.resolve(images.get('Im0')) : null;
      if (!(image instanceof PdfStream) || doc.get(image.dict, 'Subtype')?.value !== 'Image'
          || doc.get(image.dict, 'Width') !== plan.width || doc.get(image.dict, 'Height') !== plan.height
          || doc.get(image.dict, 'BitsPerComponent') !== (record.kind === 'flate1' ? 1 : 8)
          || doc.get(image.dict, 'ColorSpace')?.value !== (record.kind === 'flate1' ? 'DeviceGray' : 'DeviceRGB')
          || doc.get(image.dict, 'Filter')?.value !== (record.kind === 'flate1' ? 'FlateDecode' : 'DCTDecode')
          || hash(image.raw) !== record.stream_hash) throw new Error('image stream');
      if (record.kind === 'flate1') {
        const expected = Math.ceil(plan.width / 8) * plan.height;
        const packed = inflateSync(image.raw, { maxOutputLength: expected });
        if (packed.length !== expected || hash(packed) !== record.packed_hash) throw new Error('mono pixels');
      }
      const content = doc.get(page.dict, 'Contents');
      if (!(content instanceof PdfStream) || content.dict.has('Filter') || content.raw.length > 512) throw new Error('content');
      const tokens = new TextDecoder().decode(content.raw).trim().split(/\s+/), rect = sheet.rect;
      const wanted = ['q', '1', '1', '1', 'rg', '0', '0', sheet.width, sheet.height, 're', 'f', rect.width, '0', '0', rect.height, rect.x, rect.y, 'cm', '/Im0', 'Do', 'Q'];
      if (tokens.length !== wanted.length || wanted.some((value, at) => typeof value === 'number' ? !near(Number(tokens[at]), value) : tokens[at] !== value)) throw new Error('placement');
    }
  });
}

export async function scanDocument(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== `.${settings.format}`) throw new AdapterError('OUTPUT_EXTENSION', 'Use the matching .pdf or .png output filename.');
  const config = await scanConfig(args.config_path, args.input_paths.length), plans = planPages(config.pages, settings);
  const { images, total } = await readImages(args.input_paths, options.signal);
  const made = await withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(images.map((image, index) => ({ name: `source-${index}.${image.kind}`, mimeType: MIME[image.kind], buffer: image.data })));
    return page.evaluate(async ({ settings, configured, plans, maxBytes }) => {
      const { writeScan } = await import('/vendor/abox/tools/document-scanner/src/write-scan.js');
      const { warpPage } = await import('/vendor/abox/tools/document-scanner/src/warp.js');
      const { cleanPage } = await import('/vendor/abox/tools/document-scanner/src/clean.js');
      const { encodePage, packMono } = await import('/vendor/abox/tools/document-scanner/src/encode.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const files = Array.from(document.querySelector('#input').files), records = [];
      const renderPage = async item => {
        const config = configured[item.index], plan = plans[item.index]; let source, canvas;
        try {
          source = await codecs.decode(files[item.index]);
          if (source.width !== config.image_width || source.height !== config.image_height) throw new Error('dimension mismatch');
          canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source.bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          return cleanPage(warpPage(pixels, config.corners, plan), settings);
        } finally { codecs.release(source?.bitmap); if (canvas) { canvas.width = 0; canvas.height = 0; } }
      };
      try {
        const result = await writeScan(files.map((file, index) => ({ name: 'scan', index })), settings, {
          kind: settings.format === 'pdf' ? 'pdf' : 'images', renderPage,
          encodePdfPage: async (cleaned, chosen, signal) => {
            const encoded = await encodePage(cleaned, chosen, signal);
            if (encoded.data.length > maxBytes) throw new Error('encoded size');
            const record = { kind: encoded.kind, stream_hash: await digest(encoded.data) };
            if (encoded.kind === 'flate1') record.packed_hash = await digest(packMono(cleaned));
            else {
              const checked = await codecs.decode(new Blob([encoded.data], { type: 'image/jpeg' }));
              try { if (checked.width !== cleaned.width || checked.height !== cleaned.height) throw new Error('jpeg dimensions'); }
              finally { codecs.release(checked.bitmap); }
            }
            records.push(record); return encoded;
          },
          encodeImagePage: async cleaned => {
            const canvas = document.createElement('canvas'); let checked, sample;
            try {
              canvas.width = cleaned.width; canvas.height = cleaned.height;
              canvas.getContext('2d').putImageData(new ImageData(cleaned.data, cleaned.width, cleaned.height), 0, 0);
              const blob = await codecs.encode(canvas, { width: cleaned.width, height: cleaned.height, mime: 'image/png' });
              if (!blob.size || blob.size > maxBytes) throw new Error('PNG size');
              checked = await codecs.decode(blob);
              if (checked.width !== cleaned.width || checked.height !== cleaned.height) throw new Error('PNG dimensions');
              sample = document.createElement('canvas'); sample.width = checked.width; sample.height = checked.height;
              const context = sample.getContext('2d', { willReadFrequently: true }); context.drawImage(checked.bitmap, 0, 0);
              const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
              if (pixels.length !== cleaned.data.length) throw new Error('PNG pixels');
              for (let at = 0; at < pixels.length; at++) if (pixels[at] !== cleaned.data[at]) throw new Error('PNG pixels');
              return { blob, extension: 'png' };
            } finally {
              codecs.release(checked?.bitmap); canvas.width = 0; canvas.height = 0;
              if (sample) { sample.width = 0; sample.height = 0; }
            }
          },
        });
        if (!result.blob.size || result.blob.size > maxBytes) throw new Error('output size');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('read')); reader.readAsDataURL(result.blob);
        });
        return { data, records };
      } catch { return { error: { code: 'SCAN_PROCESSING_FAILED', message: 'The local scanner could not decode, straighten, clean or verify these images. Check exact display dimensions and page corners. No output was written.' } }; }
    }, { settings, configured: config.pages, plans, maxBytes: MAX_INPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  if (!data.length || data.length > MAX_INPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The scan exceeds the 128 MiB output limit.');
  try {
    if (settings.format === 'pdf') {
      if (made.records.length !== plans.length) throw new Error('image count');
      await verifyPdf(data, made.records, plans);
    } else {
      const checked = await supportedImage(data), size = rasterInputDimensions(checked);
      const allowed = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'cICP']);
      if (checked.kind !== 'png' || size?.width !== plans[0].width || size?.height !== plans[0].height
          || checked.doc.chunks.some(chunk => !allowed.has(chunk.type))) throw new Error('PNG structure');
    }
  } catch { throw new AdapterError('VERIFICATION_FAILED', 'The saved scan did not retain its page geometry, image data or verified output format. No output was written.'); }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'scan-document', input_paths: images.map(image => image.path), config_path: config.path, output_path: output,
    input_bytes: total, output_bytes: data.length, format: settings.format, page_count: plans.length, mode: settings.mode, strength: settings.strength,
    pages: plans.map(plan => ({ width: plan.width, height: plan.height, aspect_method: plan.aspect_method, inset_source_pixels: plan.inset_source_pixels,
      ...(settings.format === 'pdf' ? { width_pt: plan.sheet.width, height_pt: plan.sheet.height } : {}) })),
    verified: true, verification: { page_geometry: true, png_all_pixels: settings.format === 'png', pdf_image_streams: settings.format === 'pdf',
      pdf_mono_packed_pixels: settings.format === 'pdf' && settings.mode === 'mono' }, source_metadata_copied: false,
    warnings: ['The source engine crops 3–6 source pixels inward from the supplied page edges. Review margins, signatures and page coverage before sharing.',
      'Perspective and cleanup create new 8-bit SDR pixels. Transparency is composited over white; colors, fine marks and precision can change.',
      'This is an image scan without OCR or a searchable text layer.',
      ...(settings.format === 'pdf' && settings.mode !== 'mono' ? ['PDF photo/colour/grey pages use lossy JPEG images.'] : [])] };
}
