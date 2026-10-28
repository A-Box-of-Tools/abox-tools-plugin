import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { Name, Parser, Ref, PdfStream, PdfString } from '../vendor/abox/shared/js/pdf-objects.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { decodeStream, filterNames } from '../vendor/abox/shared/js/pdf-filters.js';
import { PdfWriter, num } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { createPdfFilterScanner } from './pdf-csv.mjs';
import { withBrowser } from './browser.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PDF_REDACT_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_PDF_REDACT_OUTPUT_BYTES = 128 * 2 ** 20;
export const MAX_PDF_REDACT_CONFIG_BYTES = 64 * 1024;
export const MAX_PDF_REDACT_PAGES = 32;
export const MAX_PDF_REDACT_REGIONS = 256;
export const MAX_PDF_REDACT_SIDE = 8192;
export const MAX_PDF_REDACT_PAGE_PIXELS = 8_000_000;
export const MAX_PDF_REDACT_TOTAL_PIXELS = 64_000_000;
const MAX_STREAM = 32 * 2 ** 20, MAX_EXPANDED = 128 * 2 ** 20, MAX_NODES = 200000, MAX_OBJECTS = 20000;
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw new AdapterError('PDF_REDACT_INPUT', 'The PDF is incomplete, repaired, encrypted or outside the bounded rendering subset. No output was written.'); };
const limit = () => { throw new AdapterError('PDF_REDACT_LIMIT', 'The PDF exceeds the bounded file, object, stream, image, page or raster expansion policy. No output was written.'); };
const configError = () => { throw new AdapterError('PDF_REDACT_CONFIG', 'Supply every displayed page in order with exact positive width_pt/height_pt and bounded rectangles in top-left point coordinates. At least one region is required.'); };
const unsupported = () => { throw new AdapterError('PDF_REDACT_UNSUPPORTED', 'This renderer admits bounded unfiltered/Flate streams and checked JPEG images. Inline images, predictors, other image codecs, XFA, external streams and unsupported expansion structures are refused.'); };
const verify = () => { throw new AdapterError('VERIFICATION_FAILED', 'The new PDF did not contain only the expected opaque page images, exact masked RGB pixels and fresh page structure. No output was written.'); };
const drawing = () => { throw new AdapterError('PDF_REDACT_RENDER', 'The PDF contains incomplete or unsupported drawing instructions or missing named resources. No output was written.'); };

function keys(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) configError(); }
function regionsConfig(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { configError(); }
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '"') { for (at++; at < source.length; at++) { if (source[at] === '\\') at++; else if (source[at] === '"') break; } }
    else if ('[{'.includes(source[at])) { if (++depth > 6) configError(); }
    else if (']}'.includes(source[at])) depth = Math.max(0, depth - 1);
  }
  try {
    const pending = [parseJson(source)]; let nodes = 0;
    while (pending.length) {
      const node = pending.pop(); if (++nodes > 3000) configError();
      if (node.t === 'map') { const names = node.pairs.map(pair => pair.key); if (names.length !== new Set(names).size) configError(); pending.push(...node.pairs.map(pair => pair.value)); }
      else if (node.t === 'seq') pending.push(...node.items);
    }
    const value = JSON.parse(source); keys(value, ['pages']);
    if (!Array.isArray(value.pages) || !integer(value.pages.length, 1, MAX_PDF_REDACT_PAGES)) configError();
    let count = 0;
    for (const [index, page] of value.pages.entries()) {
      keys(page, ['page', 'width_pt', 'height_pt', 'regions']);
      if (page.page !== index + 1 || !finite(page.width_pt) || !finite(page.height_pt) || page.width_pt < 1 || page.height_pt < 1
          || page.width_pt > 14400 || page.height_pt > 14400 || !Array.isArray(page.regions)) configError();
      count += page.regions.length; if (count > MAX_PDF_REDACT_REGIONS) configError();
      for (const region of page.regions) {
        keys(region, ['x', 'y', 'width', 'height']);
        if (![region.x, region.y, region.width, region.height].every(finite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
            || region.x + region.width > page.width_pt || region.y + region.height > page.height_pt) configError();
      }
    }
    if (!count) configError(); return value.pages;
  } catch { configError(); }
}

// Walk every JPEG marker, including subsequent progressive scans. Admission
// checks the actual frame header before PDF.js's JPEG decoder allocates blocks.
function jpegAdmission(bytes, width, height, components) {
  if (bytes[0] !== 255 || bytes[1] !== 216) unsupported();
  let at = 2, frame = false, scans = 0, markers = 0;
  while (at < bytes.length) {
    if (++markers > 10000 || bytes[at++] !== 255) unsupported();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) { if (!frame || !scans || at !== bytes.length) unsupported(); return; }
    if ([0, 1, 216].includes(marker) || marker >= 208 && marker <= 215 || at + 2 > bytes.length) unsupported();
    const size = (bytes[at] << 8) | bytes[at + 1], end = at + size;
    if (size < 2 || end > bytes.length) unsupported();
    if ([192, 193, 194].includes(marker)) {
      const count = bytes[at + 7];
      if (frame || size !== 8 + count * 3 || bytes[at + 2] !== 8 || count !== components
          || ((bytes[at + 3] << 8) | bytes[at + 4]) !== height || ((bytes[at + 5] << 8) | bytes[at + 6]) !== width) unsupported();
      for (let component = 0; component < count; component++) {
        const sampling = bytes[at + 9 + component * 3];
        if (!integer(sampling >> 4, 1, 4) || !integer(sampling & 15, 1, 4)) unsupported();
      }
      frame = true;
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) || marker === 220 || marker === 200 || marker === 204) unsupported();
    at = end;
    if (marker === 218) {
      if (!frame || ++scans > 256) unsupported();
      let found = false;
      for (; at < bytes.length; at++) if (bytes[at] === 255) {
        let next = at + 1; while (bytes[next] === 255) next++;
        if (bytes[next] === 0 || bytes[next] >= 208 && bytes[next] <= 215) { at = next; continue; }
        found = true; break;
      }
      if (!found) unsupported();
    }
  }
  unsupported();
}

// PDF renderers intentionally recover by skipping unknown commands and missing
// resources. Redaction must refuse those pages instead of certifying an
// incomplete picture. This guard reuses the source object parser but never its
// forgiving content lexer, which deliberately steps over malformed tokens.
function admitDrawing(bytes, resources, doc) {
  const parser = new Parser(bytes), args = [];
  const numeric = new Map([['w', 1], ['J', 1], ['j', 1], ['M', 1], ['i', 1], ['cm', 6], ['m', 2], ['l', 2], ['c', 6], ['v', 4], ['y', 4], ['re', 4],
    ['Tc', 1], ['Tw', 1], ['Tz', 1], ['TL', 1], ['Tr', 1], ['Ts', 1], ['Td', 2], ['TD', 2], ['Tm', 6], ['d0', 2], ['d1', 6], ['G', 1], ['g', 1], ['RG', 3], ['rg', 3], ['K', 4], ['k', 4]]);
  const zero = new Set(['q', 'Q', 'h', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*', 'BT', 'ET', 'T*', 'EMC', 'BX', 'EX']);
  const numbers = values => values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e10);
  const arity = count => { if (args.length !== count) drawing(); };
  const named = value => { if (!(value instanceof Name)) drawing(); return value.value; };
  const resource = (category, value) => {
    const name = named(value), dict = resources instanceof Map ? doc.resolve(resources.get(category)) : null;
    if (!(dict instanceof Map) || !dict.has(name)) drawing();
    const found = doc.resolve(dict.get(name)); if (found === undefined || found === null) drawing(); return found;
  };
  let count = 0, states = 0, text = false, marked = 0, compatible = 0;
  const boundedOperand = value => {
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop(); if (++count > MAX_NODES || item.depth > 64) limit();
      if (item.value instanceof Ref || item.value instanceof PdfStream) drawing();
      if (typeof item.value === 'number' && !numbers([item.value])) drawing();
      if (Array.isArray(item.value) || item.value instanceof Map) {
        const children = item.value instanceof Map ? [...item.value.values()] : item.value;
        if (children.length > MAX_NODES) limit();
        for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  };
  for (;;) {
    parser.skip(); if (parser.pos >= bytes.length) break;
    const at = parser.pos, code = bytes[at], word = parser.peekKeyword();
    if ([47, 40, 91, 60, 43, 45, 46].includes(code) || code >= 48 && code <= 57 || ['true', 'false', 'null'].includes(word)) {
      let value; try { value = parser.parseValue(); } catch { drawing(); }
      if (parser.pos <= at || args.length >= 32) drawing(); boundedOperand(value); args.push(value); continue;
    }
    if (word === 'BI') unsupported();
    if (!word || word.length > 3 || ++count > MAX_NODES) drawing(); parser.pos += word.length;
    if (numeric.has(word)) { arity(numeric.get(word)); if (!numbers(args)) drawing(); }
    else if (zero.has(word)) {
      arity(0);
      if (word === 'q' && ++states > 64 || word === 'Q' && --states < 0) drawing();
      if (word === 'BT') { if (text) drawing(); text = true; }
      if (word === 'ET') { if (!text) drawing(); text = false; }
      if (word === 'EMC' && --marked < 0 || word === 'BX' && ++compatible > 64 || word === 'EX' && --compatible < 0) drawing();
    } else if (word === 'd') {
      arity(2); if (!Array.isArray(args[0]) || !numbers(args[0]) || !numbers([args[1]]) || args[1] < 0 || args[0].some(value => value < 0)) drawing();
    } else if (word === 'ri') { arity(1); named(args[0]); }
    else if (word === 'gs') { arity(1); if (!(resource('ExtGState', args[0]) instanceof Map)) drawing(); }
    else if (word === 'Do') {
      arity(1); const object = resource('XObject', args[0]);
      if (!(object instanceof PdfStream) || !['Image', 'Form'].includes(doc.resolve(object.dict.get('Subtype'))?.value)) drawing();
    } else if (word === 'Tf') {
      arity(2); if (!numbers([args[1]]) || !(resource('Font', args[0]) instanceof Map)) drawing();
    } else if (word === 'Tj' || word === "'") { arity(1); if (!text || !(args[0] instanceof PdfString)) drawing(); }
    else if (word === '"') { arity(3); if (!text || !numbers(args.slice(0, 2)) || !(args[2] instanceof PdfString)) drawing(); }
    else if (word === 'TJ') {
      arity(1); if (!text || !Array.isArray(args[0]) || args[0].some(value => !(value instanceof PdfString) && !numbers([value]))) drawing();
    } else if (word === 'CS' || word === 'cs') {
      arity(1); if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern'].includes(named(args[0]))) resource('ColorSpace', args[0]);
    } else if (['SC', 'sc', 'SCN', 'scn'].includes(word)) {
      if (!args.length) drawing();
      const pattern = args.at(-1) instanceof Name;
      if (pattern) { if (!['SCN', 'scn'].includes(word)) drawing(); resource('Pattern', args.at(-1)); }
      if (!numbers(pattern ? args.slice(0, -1) : args)) drawing();
    } else if (word === 'sh') { arity(1); resource('Shading', args[0]); }
    else if (word === 'MP' || word === 'BMC') { arity(1); named(args[0]); if (word === 'BMC' && ++marked > 64) drawing(); }
    else if (word === 'DP' || word === 'BDC') {
      arity(2); named(args[0]); if (args[1] instanceof Name) resource('Properties', args[1]); else if (!(args[1] instanceof Map)) drawing();
      if (word === 'BDC' && ++marked > 64) drawing();
    } else drawing();
    args.length = 0;
  }
  if (args.length || states || text || marked || compatible) drawing();
}

function boundStreams(budget) {
  const Native = globalThis.DecompressionStream;
  const check = () => { if (budget.exceeded) limit(); if (budget.unsupported) unsupported(); };
  const scan = data => { const scanner = createPdfFilterScanner(budget); scanner.write(data); scanner.finish(); check(); };
  globalThis.DecompressionStream = class {
    constructor(format) {
      const native = new Native(format), scanner = createPdfFilterScanner(budget); let size = 0;
      this.writable = native.writable;
      this.readable = native.readable.pipeThrough(new TransformStream({ transform(chunk, controller) {
        size += chunk.byteLength; budget.bytes += chunk.byteLength;
        if (size > MAX_STREAM || budget.bytes > MAX_EXPANDED) budget.exceeded = true;
        check(); scanner.write(chunk); check(); controller.enqueue(chunk);
      }, flush() { scanner.finish(); check(); } }));
    }
  };
  return { check, scan };
}

async function admitPdf(bytes) {
  const budget = { exceeded: false, unsupported: false, bytes: 0 }, guarded = boundStreams(budget); guarded.scan(bytes);
  let doc;
  try { doc = await PdfDocument.open(bytes); } finally { guarded.check(); }
  if (doc.repaired || doc.trailer.has('Encrypt') || doc.entries.size > MAX_OBJECTS || doc.objects.size > MAX_OBJECTS) invalid();
  const pageTree = [{ value: doc.get(doc.catalog, 'Pages'), depth: 0 }], seenPages = new Set(); let leaves = 0;
  while (pageTree.length) {
    const { value, depth } = pageTree.pop();
    if (!(value instanceof Map) || seenPages.has(value) || depth > 64) invalid(); seenPages.add(value);
    const kids = doc.get(value, 'Kids');
    if (Array.isArray(kids)) for (const kid of kids) pageTree.push({ value: doc.resolve(kid), depth: depth + 1 });
    else { if (value.get('Type')?.value !== 'Page') invalid(); if (++leaves > MAX_PDF_REDACT_PAGES) limit(); }
  }
  const pages = readPages(doc); if (!leaves || leaves !== pages.length || leaves !== doc.countPages()) invalid();
  const contentQueue = [], decodedStreams = new Map(), pageContents = [];
  for (const page of pages) {
    const value = doc.resolve(page.dict.get('Contents')), streams = [];
    for (const candidate of Array.isArray(value) ? value : [value]) { const stream = doc.resolve(candidate); if (stream instanceof PdfStream) streams.push(stream); else if (stream != null) invalid(); }
    pageContents.push({ streams, resources: doc.resolve(page.dict.get('Resources') ?? page.inherited.get('Resources')) });
  }
  const pending = [...doc.objects.values()].map(value => ({ value, depth: 0 })), visited = new Set(); let nodes = 0, imagePixels = 0, images = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > MAX_NODES || depth > 128) limit();
    if (value instanceof Ref) continue;
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e10)) limit();
    if (Array.isArray(value)) { if (value.length > MAX_NODES) limit(); for (const child of value) pending.push({ value: child, depth: depth + 1 }); continue; }
    if (!(value instanceof Map || value instanceof PdfStream) || visited.has(value)) continue;
    visited.add(value); const dict = value instanceof PdfStream ? value.dict : value;
    if (dict.has('XFA')) unsupported();
    if (dict.has('Predictor') && doc.resolve(dict.get('Predictor')) > 1) unsupported();
    if (doc.resolve(dict.get('FunctionType')) === 0) {
      const size = doc.resolve(dict.get('Size')), range = doc.resolve(dict.get('Range'));
      if (!Array.isArray(size) || !Array.isArray(range) || size.length > 8 || range.length > 16
          || size.some(n => !integer(n, 1, 65536)) || size.reduce((a, n) => a * n, 1) * range.length > 1_000_000) limit();
    }
    if (value instanceof PdfStream) {
      if (dict.has('F') || value.raw.length > MAX_STREAM) unsupported();
      const subtype = doc.resolve(dict.get('Subtype'))?.value, type = doc.resolve(dict.get('Type'))?.value;
      const rawFilter = doc.resolve(dict.get('Filter')), filterList = rawFilter == null ? [] : Array.isArray(rawFilter) ? rawFilter : [rawFilter];
      if (filterList.length > 2 || filterList.some(filter => !(doc.resolve(filter) instanceof Name))) unsupported();
      const filters = filterNames(dict, child => doc.resolve(child));
      let imageByteCount = null;
      if (subtype === 'Image') {
        const width = doc.resolve(dict.get('Width')), height = doc.resolve(dict.get('Height')), mask = doc.resolve(dict.get('ImageMask')) === true,
          bpc = doc.resolve(dict.get('BitsPerComponent')) ?? (mask ? 1 : null);
        if (!integer(width, 1, MAX_PDF_REDACT_SIDE) || !integer(height, 1, MAX_PDF_REDACT_SIDE) || width * height > MAX_PDF_REDACT_PAGE_PIXELS
            || ![1, 2, 4, 8, 16].includes(bpc) || (imagePixels += width * height) > 32_000_000 || ++images > 256) limit();
        const space = doc.resolve(dict.get('ColorSpace'));
        if (!mask && !(space instanceof Name && ['DeviceRGB', 'DeviceGray', 'DeviceCMYK'].includes(space.value))) unsupported();
        const components = mask || space?.value === 'DeviceGray' ? 1 : space?.value === 'DeviceRGB' ? 3 : 4;
        imageByteCount = Math.ceil(width * components * bpc / 8) * height;
        if (imageByteCount > MAX_STREAM) limit();
        if (filters.length === 1 && ['DCTDecode', 'DCT'].includes(filters[0])) { if (bpc !== 8) unsupported(); jpegAdmission(value.raw, width, height, components); }
        else if (filters.some(filter => !['FlateDecode', 'Fl'].includes(filter))) unsupported();
      } else if (filters.some(filter => !['FlateDecode', 'Fl'].includes(filter))) unsupported();
      if (!filters.some(filter => ['DCTDecode', 'DCT'].includes(filter))) {
        let decoded; try { decoded = await decodeStream(value, child => doc.resolve(child)); } finally { guarded.check(); }
        if (decoded.remaining.length || decoded.bytes.length > MAX_STREAM) unsupported();
        if (imageByteCount !== null && decoded.bytes.length !== imageByteCount) invalid();
        decodedStreams.set(value, decoded.bytes);
        if (subtype === 'Form' || type === 'Pattern') contentQueue.push({ streams: [value], resources: doc.resolve(dict.get('Resources')) });
      }
    }
    if (dict.has('CharProcs')) {
      const procs = doc.resolve(dict.get('CharProcs'));
      if (!(procs instanceof Map) || procs.size > 4096) limit();
      for (const ref of procs.values()) { const stream = doc.resolve(ref); if (!(stream instanceof PdfStream)) invalid();
        contentQueue.push({ streams: [stream], resources: doc.resolve(dict.get('Resources')) }); }
    }
    for (const child of dict.values()) pending.push({ value: child, depth: depth + 1 });
  }
  let drawingBytes = 0;
  for (const job of [...pageContents, ...contentQueue]) {
    const chunks = job.streams.map(stream => { const bytes = decodedStreams.get(stream); if (!bytes) invalid(); return bytes; });
    const size = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
    if (size > MAX_STREAM || (drawingBytes += size) > MAX_EXPANDED) limit();
    const combined = Buffer.concat(chunks.flatMap(chunk => [chunk, Buffer.from('\n')]));
    admitDrawing(combined, job.resources, doc);
  }
  return { page_count: pages.length, object_count: doc.objects.size, image_count: images };
}

async function admitIsolated(bytes, config, options) {
  const input = Uint8Array.from(bytes), regions = Uint8Array.from(config), worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'abox-pdf-raster-admit', input, regions }, transferList: [input.buffer, regions.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } }); worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); }); };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'PDF redaction admission exceeded two minutes.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('PDF_REDACT_LIMIT', 'The isolated PDF admission worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('PDF_REDACT_LIMIT', 'The isolated PDF admission worker stopped before returning a result.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

function pixelRegions(page, width, height, dpi) {
  const scaleX = dpi / 72, scaleY = dpi / 72;
  return page.regions.map(region => ({ x: Math.max(0, Math.floor(region.x * scaleX) - 1), y: Math.max(0, Math.floor(region.y * scaleY) - 1),
    right: Math.min(width, Math.ceil((region.x + region.width) * scaleX) + 1), bottom: Math.min(height, Math.ceil((region.y + region.height) * scaleY) + 1) }));
}
function blackPixels(rgb, width, regions) {
  for (const region of regions) for (let y = region.y; y < region.bottom; y++) for (let x = region.x; x < region.right; x++) {
    const at = (y * width + x) * 3; if (rgb[at] || rgb[at + 1] || rgb[at + 2]) verify();
  }
}
const exactKeys = (dict, expected) => dict instanceof Map && dict.size === expected.length && expected.every(key => dict.has(key));
async function verifyNewPdf(bytes, plans) {
  const doc = await PdfDocument.open(Uint8Array.from(bytes));
  if (doc.repaired || doc.trailer.has('Info') || doc.trailer.has('Encrypt') || doc.objects.size !== 2 + plans.length * 3
      || !exactKeys(doc.catalog, ['Type', 'Pages']) || doc.catalog.get('Type')?.value !== 'Catalog') verify();
  const root = doc.get(doc.catalog, 'Pages');
  if (!exactKeys(root, ['Type', 'Kids', 'Count']) || root.get('Type')?.value !== 'Pages' || root.get('Count') !== plans.length || root.get('Kids').length !== plans.length) verify();
  for (const [index, reference] of root.get('Kids').entries()) {
    const page = doc.resolve(reference), expected = plans[index], resource = page.get('Resources'), images = resource?.get('XObject'), image = doc.resolve(images?.get('Im0')),
      content = doc.resolve(page.get('Contents'));
    if (!exactKeys(page, ['Type', 'Parent', 'MediaBox', 'Resources', 'Contents']) || !exactKeys(resource, ['XObject']) || !exactKeys(images, ['Im0'])
        || page.get('Type')?.value !== 'Page' || !(image instanceof PdfStream) || !(content instanceof PdfStream) || !exactKeys(content.dict, ['Length'])
        || !exactKeys(image.dict, ['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'Length'])
        || image.dict.get('Type')?.value !== 'XObject' || image.dict.get('Subtype')?.value !== 'Image'
        || image.dict.get('Width') !== expected.width || image.dict.get('Height') !== expected.height || image.dict.get('ColorSpace')?.value !== 'DeviceRGB'
        || image.dict.get('BitsPerComponent') !== 8 || image.dict.get('Filter')?.value !== 'FlateDecode'
        || Math.abs(page.get('MediaBox')[2] - expected.width_pt) > 0.0001 || Math.abs(page.get('MediaBox')[3] - expected.height_pt) > 0.0001
        || Buffer.from(content.raw).toString('latin1') !== expected.content) verify();
    const rgb = inflateSync(image.raw, { maxOutputLength: expected.width * expected.height * 3 });
    if (rgb.length !== expected.width * expected.height * 3 || digest(rgb) !== expected.hash) verify();
    blackPixels(rgb, expected.width, expected.regions);
  }
}

export async function redactPdf(args, options = {}) {
  options.signal?.throwIfAborted(); const dpi = args.dpi === undefined ? 144 : args.dpi;
  if (!integer(dpi, 72, 300)) throw new AdapterError('INVALID_ARGUMENTS', 'PDF raster redaction DPI must be an integer from 72 to 300.');
  const output = await newOutput(args.output_path); if (path.extname(output).toLowerCase() !== '.pdf') throw new AdapterError('OUTPUT_EXTENSION', 'Use a new .pdf output file.');
  const input = await readInput(args.input_path, { max_bytes: MAX_PDF_REDACT_INPUT_BYTES }), configuration = await readInput(args.regions_path, { max_bytes: MAX_PDF_REDACT_CONFIG_BYTES });
  options.signal?.throwIfAborted(); const admitted = await admitIsolated(input.data, configuration.data, options), pages = admitted.pages;
  const made = await withBrowser(async page => {
    let warnings = 0; page.on('console', event => { if (['warning', 'error'].includes(event.type()) || /^(?:Warning|Error):/.test(event.text())) warnings++; });
    await page.locator('#input').setInputFiles({ name: 'source.pdf', mimeType: 'application/pdf', buffer: input.data });
    const initialized = await page.evaluate(async ({ pages, dpi, maxSide, maxPixels, maxTotal }) => {
      try {
        const library = await import('/pdfjs/legacy/build/pdf.mjs');
        library.GlobalWorkerOptions.workerSrc = '/pdfjs/legacy/build/pdf.worker.mjs';
        // Worker console forwarding varies between browser automation versions.
        // Report a fixed private boolean over its existing local message port;
        // neither document snippets nor resource names leave the worker.
        const workerModule = new URL('/pdfjs/legacy/build/pdf.worker.mjs', location.href).href;
        const workerCode = `const report=()=>postMessage({aboxPdfRendererWarning:true});console.warn=report;console.error=report;console.log=(...args)=>{if(typeof args[0]==='string'&&/^(?:Warning|Error):/.test(args[0]))report();};await import(${JSON.stringify(workerModule)});postMessage({aboxPdfWorkerReady:true});`;
        const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })), worker = new Worker(workerUrl, { type: 'module' });
        let workerWarnings = 0; worker.addEventListener('message', event => { if (event.data?.aboxPdfRendererWarning === true) workerWarnings++; });
        // A caller-supplied port skips PDF.js's worker-creation handshake. Do
        // not let its first protocol message race the module's async import.
        await new Promise((resolve, reject) => {
          const finish = error => { clearTimeout(timer); worker.removeEventListener('message', ready); worker.removeEventListener('error', failed); error ? reject(error) : resolve(); };
          const ready = event => { if (event.data?.aboxPdfWorkerReady === true) finish(); }, failed = () => finish(new Error('worker-start'));
          const timer = setTimeout(() => finish(new Error('worker-start-timeout')), 10000);
          worker.addEventListener('message', ready); worker.addEventListener('error', failed, { once: true });
        });
        library.GlobalWorkerOptions.workerPort = worker;
        let active = 0; const sizes = new Map();
        const dimensions = (width, height) => { if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1 || width > maxSide || height > maxSide || width * height > maxPixels) throw new Error('canvas-bound'); };
        class CanvasFactory {
          create(width, height) { const canvas = document.createElement('canvas'); const made = { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) }; this.reset(made, width, height); return made; }
          reset(made, width, height) { dimensions(width, height); active -= sizes.get(made.canvas) ?? 0;
            if (active + width * height > 32_000_000) throw new Error('canvas-bound'); active += width * height; sizes.set(made.canvas, width * height); made.canvas.width = width; made.canvas.height = height; }
          destroy(made) { active -= sizes.get(made.canvas) ?? 0; sizes.delete(made.canvas); made.canvas.width = made.canvas.height = 0; }
        }
        const data = new Uint8Array(await document.querySelector('#input').files[0].arrayBuffer());
        const task = library.getDocument({ data, isEvalSupported: false, stopAtErrors: true, disableFontFace: true, useSystemFonts: false, useWasm: false,
          isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: maxPixels, canvasMaxAreaInBytes: maxPixels * 4,
          standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.href).href, cMapUrl: new URL('/pdfjs/cmaps/', location.href).href, cMapPacked: true, useWorkerFetch: true,
          disableRange: true, disableStream: true, disableAutoFetch: true, enableXfa: false, verbosity: 1, CanvasFactory });
        const doc = await task.promise;
        if (doc.numPages !== pages.length) throw new Error('page-count');
        let total = 0; const geometry = [];
        for (const [index, expected] of pages.entries()) {
          const item = await doc.getPage(index + 1), shown = item.getViewport({ scale: 1 }), raster = item.getViewport({ scale: dpi / 72 });
          const width = Math.ceil(raster.width), height = Math.ceil(raster.height); dimensions(width, height);
          if (Math.abs(shown.width - expected.width_pt) > 0.01 || Math.abs(shown.height - expected.height_pt) > 0.01 || (total += width * height) > maxTotal) throw new Error('geometry');
          geometry.push({ width, height, width_pt: shown.width, height_pt: shown.height });
        }
        if (workerWarnings) throw new Error('renderer-warning');
        globalThis.aboxRedaction = { task, doc, library, geometry, dpi, worker, workerUrl, workerWarnings: () => workerWarnings };
        return { geometry, version: library.version };
      } catch { return { error: true }; }
    }, { pages, dpi, maxSide: MAX_PDF_REDACT_SIDE, maxPixels: MAX_PDF_REDACT_PAGE_PIXELS, maxTotal: MAX_PDF_REDACT_TOTAL_PIXELS });
    if (initialized.error || initialized.version !== '6.4.299') throw new AdapterError('PDF_REDACT_RENDER', 'The bundled renderer could not load this PDF at the exact declared page geometry and bounded resolution. No output was written.');
    const writer = new PdfWriter(), catalog = writer.reserve(), pageRoot = writer.reserve(), refs = [], plans = [];
    for (const [index, geometry] of initialized.geometry.entries()) {
      options.signal?.throwIfAborted(); const regions = pixelRegions(pages[index], geometry.width, geometry.height, dpi);
      const rendered = await page.evaluate(async ({ index, regions }) => {
        let canvas;
        try {
          const { doc, library, geometry, dpi } = globalThis.aboxRedaction, item = await doc.getPage(index + 1), size = geometry[index];
          canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
          await item.render({ canvasContext: context, viewport: item.getViewport({ scale: dpi / 72 }), background: '#ffffff', annotationMode: library.AnnotationMode.ENABLE }).promise;
          if (globalThis.aboxRedaction.workerWarnings()) throw new Error('renderer-warning');
          context.fillStyle = '#000000';
          for (const region of regions) context.fillRect(region.x, region.y, region.right - region.x, region.bottom - region.y);
          const rgba = context.getImageData(0, 0, size.width, size.height).data, rgb = new Uint8Array(size.width * size.height * 3);
          for (let pixel = 0; pixel < size.width * size.height; pixel++) {
            if (rgba[pixel * 4 + 3] !== 255) throw new Error('alpha'); rgb.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
          }
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(new Blob([rgb])); });
          await item.cleanup(); return { data };
        } catch { return { error: true }; }
        finally { if (canvas) canvas.width = canvas.height = 0; }
      }, { index, regions });
      if (rendered.error || warnings) throw new AdapterError('PDF_REDACT_RENDER', 'The bundled renderer could not render every page without warnings or missing resources. No output was written.');
      const rgb = Buffer.from(rendered.data, 'base64');
      if (rgb.length !== geometry.width * geometry.height * 3) verify(); blackPixels(rgb, geometry.width, regions);
      const packed = deflateSync(rgb), image = writer.reserve(), contentId = writer.reserve(), pageId = writer.reserve();
      const content = `q\n${num(geometry.width_pt)} 0 0 ${num(geometry.height_pt)} 0 0 cm\n/Im0 Do\nQ\n`;
      writer.stream(image, ` /Type /XObject /Subtype /Image /Width ${geometry.width} /Height ${geometry.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, packed);
      writer.stream(contentId, '', new TextEncoder().encode(content));
      writer.object(pageId, `<< /Type /Page /Parent ${pageRoot} 0 R /MediaBox [0 0 ${num(geometry.width_pt)} ${num(geometry.height_pt)}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contentId} 0 R >>`);
      if (writer.length + pages.length * 512 + 4096 > MAX_PDF_REDACT_OUTPUT_BYTES) limit();
      refs.push(pageId); plans.push({ ...geometry, regions, content, hash: digest(rgb) });
    }
    const workerWarnings = await page.evaluate(async () => {
      const job = globalThis.aboxRedaction, task = job.task; delete globalThis.aboxRedaction;
      try { await task.destroy(); } catch { /* The isolated browser is closed unconditionally after this job. */ }
      const warnings = job.workerWarnings(); job.worker.terminate(); URL.revokeObjectURL(job.workerUrl); return warnings;
    });
    if (warnings || workerWarnings) throw new AdapterError('PDF_REDACT_RENDER', 'Rendering produced warnings; the output was refused.');
    writer.object(catalog, `<< /Type /Catalog /Pages ${pageRoot} 0 R >>`);
    writer.object(pageRoot, `<< /Type /Pages /Count ${refs.length} /Kids [${refs.map(ref => `${ref} 0 R`).join(' ')}] >>`);
    const blob = writer.finish({ root: catalog }); if (blob.size > MAX_PDF_REDACT_OUTPUT_BYTES) limit();
    return { bytes: Buffer.from(await blob.arrayBuffer()), plans };
  }, { ...options, pdfjs: true });
  await verifyNewPdf(made.bytes, made.plans); options.signal?.throwIfAborted(); await writeNew(output, made.bytes);
  return { ok: true, operation: 'redact-pdf', input_path: input.path, output_path: output, regions_path: configuration.path,
    input_bytes: input.data.length, output_bytes: made.bytes.length, page_count: pages.length, region_count: pages.reduce((sum, item) => sum + item.regions.length, 0),
    dpi, flattened: true, searchable_text: false, renderer: 'pdfjs-dist 6.4.299', verified: true,
    verification: { all_pages_rasterized: true, opaque_black_masks: true, exact_stored_rgb_pixels: true, new_image_only_object_graph: true, original_objects_copied: false },
    warnings: ['Every page is flattened to opaque RGB pixels at the requested resolution. Searchable text, forms, links, tags, layers, signatures, attachments and original metadata are not carried into the new PDF.',
      'Only the explicitly supplied rectangles are masked, with one outward raster-pixel margin. This does not detect sensitive content; review every page and ensure every intended item lies inside a selected region.',
      'Rasterization can change font rendering, color, transparency, annotations and fine detail. The output has only the visible CropBox view with rotation baked in; content outside that view is discarded.'] };
}

if (!isMainThread && workerData?.kind === 'abox-pdf-raster-admit') {
  try {
    const pages = regionsConfig(workerData.regions), summary = await admitPdf(workerData.input);
    if (summary.page_count !== pages.length) configError(); parentPort.postMessage({ result: { ...summary, pages } });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'PDF_REDACT_INPUT', message: 'The bounded PDF admission could not read this complete supported input. Document contents are excluded from errors.' } });
  } finally { parentPort.close(); }
}
