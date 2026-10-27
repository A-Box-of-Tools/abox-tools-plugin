import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readBytes, serialize, outputType } from '../vendor/abox/tools/exif-editor/src/container.js';
import { GROUP_ORDER, createEntry, setEntryValue, serializeExif } from '../vendor/abox/tools/exif-editor/src/tiff.js';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { crc32 } from '../vendor/abox/shared/js/crc32.js';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_EXIF_EDIT_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_EXIF_EDIT_OUTPUT_BYTES = MAX_EXIF_EDIT_INPUT_BYTES + 128 * 1024;
export const MAX_EXIF_EDIT_CONFIG_BYTES = 64 * 1024;
export const MAX_EXIF_EDIT_BYTES = 65527;
export const MAX_EXIF_EDIT_TAGS = 2048;
export const MAX_EXIF_EDIT_CHANGES = 64;
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const STRUCTURAL = new Set([0x8769, 0x8825, 0xa005, 0x0201, 0x0202]);
const XP = new Set([0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f]);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const text = bytes => Buffer.from(bytes).toString('latin1');
const equal = (one, two) => Buffer.from(one).equals(Buffer.from(two));
const invalid = () => { throw new AdapterError('INVALID_EXIF_IMAGE', 'The image or EXIF structure is incomplete, ambiguous or unsupported. No output was written.'); };
const configError = () => { throw new AdapterError('EXIF_EDIT_CONFIG', 'Use distinct supported set/remove tag instructions in a bounded local JSON configuration. Values are excluded from errors.'); };
const limit = () => { throw new AdapterError('EXIF_EDIT_LIMIT', 'EXIF editing supports 32 MiB images, 65527-byte EXIF blocks, 2048 tags, five standard directories and bounded metadata text.'); };
const verification = () => { throw new AdapterError('VERIFICATION_FAILED', 'The edited image did not preserve its expected raw tags, thumbnail, picture payload or other container blocks. No output was written.'); };

function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) configError();
}
function editConfig(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, ''); } catch { configError(); }
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '"') { for (at++; at < source.length; at++) { if (source[at] === '\\') at++; else if (source[at] === '"') break; } }
    else if (source[at] === '{' || source[at] === '[') { if (++depth > 4) configError(); }
    else if (source[at] === '}' || source[at] === ']') depth = Math.max(0, depth - 1);
  }
  try {
    const pending = [parseJson(source)]; let count = 0;
    while (pending.length) {
      const node = pending.pop(); if (++count > 1000) configError();
      if (node.t === 'map') {
        const keys = node.pairs.map(pair => pair.key); if (keys.length !== new Set(keys).size) configError();
        pending.push(...node.pairs.map(pair => pair.value));
      } else if (node.t === 'seq') pending.push(...node.items);
    }
    const value = JSON.parse(source); object(value, ['set', 'remove']);
    const set = value.set === undefined ? [] : value.set, remove = value.remove === undefined ? [] : value.remove;
    if (!Array.isArray(set) || !Array.isArray(remove) || !integer(set.length + remove.length, 1, MAX_EXIF_EDIT_CHANGES)) configError();
    const seen = new Set();
    for (const [items, setting] of [[set, true], [remove, false]]) for (const item of items) {
      object(item, setting ? ['group', 'tag', 'type', 'value'] : ['group', 'tag'], setting ? ['group', 'tag', 'value'] : ['group', 'tag']);
      if (!GROUP_ORDER.includes(item.group) || !integer(item.tag, 1, 65535) || STRUCTURAL.has(item.tag)
          || item.type !== undefined && !integer(item.type, 1, 12)
          || setting && (typeof item.value !== 'string' || !item.value.isWellFormed() || item.value.includes('\0') || Buffer.byteLength(item.value) > 4096)) configError();
      const key = `${item.group}:${item.tag}`; if (seen.has(key)) configError(); seen.add(key);
    }
    return { set, remove };
  } catch { configError(); }
}

// This length walk precedes the recursive source reader. It admits only the
// five standard IFDs, so a cycle or an unexpected pointer never reaches it.
function exifAdmission(bytes) {
  if (!bytes) return;
  if (bytes.length > MAX_EXIF_EDIT_BYTES) limit();
  if (bytes.length < 8 || !['II', 'MM'].includes(text(bytes.subarray(0, 2)))) invalid();
  const little = bytes[0] === 73, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) invalid();
  const queue = [{ offset: view.getUint32(4, little), group: 'ifd0' }], seen = new Set(), groups = new Set();
  let count = 0, retained = 0;
  while (queue.length) {
    const { offset, group } = queue.pop();
    if (groups.has(group) || seen.has(offset) || offset < 8 || offset + 2 > bytes.length) invalid();
    groups.add(group); seen.add(offset); if (seen.size > 5) limit();
    const entries = view.getUint16(offset, little), end = offset + 2 + entries * 12;
    if (end + 4 > bytes.length) invalid();
    count += entries; if (count > MAX_EXIF_EDIT_TAGS) limit();
    const tags = new Set(); let thumbAt, thumbLength;
    for (let at = offset + 2; at < end; at += 12) {
      const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little), n = view.getUint32(at + 4, little), size = SIZES[type] * n;
      if (tags.has(tag) || !integer(type, 1, 12) || !n || !Number.isSafeInteger(size) || size > bytes.length) invalid();
      tags.add(tag); retained += size; if (retained > MAX_EXIF_EDIT_BYTES) limit();
      const start = size <= 4 ? at + 8 : view.getUint32(at + 8, little);
      if (start < 8 || start + size > bytes.length) invalid();
      if (STRUCTURAL.has(tag)) {
        if (type !== 4 || n !== 1) invalid();
        const target = view.getUint32(start, little);
        const sub = tag === 0x8769 && group === 'ifd0' ? 'exif' : tag === 0x8825 && group === 'ifd0' ? 'gps'
          : tag === 0xa005 && group === 'exif' ? 'interop' : null;
        if (sub) queue.push({ offset: target, group: sub });
        else if (group === 'ifd1' && tag === 0x0201) thumbAt = target;
        else if (group === 'ifd1' && tag === 0x0202) thumbLength = target;
        else invalid();
      }
    }
    if ((thumbAt === undefined) !== (thumbLength === undefined) || thumbAt !== undefined
        && (!thumbLength || thumbAt < 8 || thumbAt + thumbLength > bytes.length)) invalid();
    const next = view.getUint32(end, little);
    if (next) { if (group !== 'ifd0') invalid(); queue.push({ offset: next, group: 'ifd1' }); }
  }
}

function unwrap(bytes) { return text(bytes.subarray(0, 6)) === 'Exif\0\0' ? bytes.subarray(6) : bytes; }
function containerAdmission(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let raw = null, blocks = 0;
  const record = value => { if (raw !== null) invalid(); raw = unwrap(value); exifAdmission(raw); };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at < bytes.length) {
      if (++blocks > 8192 || bytes[at] !== 255) invalid();
      while (bytes[at + 1] === 255 && at + 2 < bytes.length) at++;
      const marker = bytes[at + 1];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) { at += 2; continue; }
      if (at + 4 > bytes.length) invalid();
      const length = view.getUint16(at + 2);
      if (length < 2 || at + length + 2 > bytes.length) invalid();
      if (marker === 218) {
        if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) invalid();
        return { kind: 'jpeg', raw };
      }
      if (marker === 225 && text(bytes.subarray(at + 4, at + 10)) === 'Exif\0\0') record(bytes.subarray(at + 4, at + 2 + length));
      at += length + 2;
    }
    invalid();
  }
  if (bytes.length >= 8 && equal(bytes.subarray(0, 8), [137, 80, 78, 71, 13, 10, 26, 10])) {
    let at = 8, idat = 0, inflated = 0;
    while (at + 12 <= bytes.length) {
      if (++blocks > 8192) limit();
      const length = view.getUint32(at), type = text(bytes.subarray(at + 4, at + 8)), end = at + 12 + length;
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)
          || crc32([bytes.subarray(at + 4, at + 8 + length)]) !== view.getUint32(at + 8 + length)) invalid();
      const data = bytes.subarray(at + 8, end - 4);
      if (blocks === 1 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') invalid();
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new AdapterError('ANIMATED_IMAGE', 'EXIF editing accepts still JPEG, PNG and WebP images.');
      if (type === 'eXIf') record(data);
      if (type === 'IDAT') idat++;
      if (type === 'zTXt' || type === 'iTXt') {
        const nul = data.indexOf(0); if (nul < 1) invalid(); let compressed;
        if (type === 'zTXt') { if (data[nul + 1] !== 0) invalid(); compressed = data.subarray(nul + 2); }
        else if (data[nul + 1] === 1) {
          const language = data.indexOf(0, nul + 3), translated = data.indexOf(0, language + 1);
          if (data[nul + 2] !== 0 || language < 0 || translated < 0) invalid(); compressed = data.subarray(translated + 1);
        }
        if (compressed) {
          try { inflated += inflateSync(compressed, { maxOutputLength: 64 * 1024 }).length; } catch { limit(); }
          if (inflated > 256 * 1024) limit();
        }
      }
      at = end;
      if (type === 'IEND') { if (length || !idat || at !== bytes.length) invalid(); return { kind: 'png', raw }; }
    }
    invalid();
  }
  if (bytes.length >= 20 && text(bytes.subarray(0, 4)) === 'RIFF' && text(bytes.subarray(8, 12)) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== bytes.length) invalid(); let at = 12, image = 0, extended = 0;
    while (at + 8 <= bytes.length) {
      if (++blocks > 8192) limit();
      const type = text(bytes.subarray(at, at + 4)), size = view.getUint32(at + 4, true), end = at + 8 + size;
      if (end + size % 2 > bytes.length) invalid();
      if (type === 'ANIM' || type === 'ANMF') throw new AdapterError('ANIMATED_IMAGE', 'EXIF editing accepts still JPEG, PNG and WebP images.');
      if (type === 'VP8 ' || type === 'VP8L') image++;
      if (type === 'VP8X' && (++extended > 1 || size !== 10)) invalid();
      if (type === 'EXIF') record(bytes.subarray(at + 8, end)); at = end + size % 2;
    }
    if (at !== bytes.length || image !== 1) invalid(); return { kind: 'webp', raw };
  }
  throw new AdapterError('UNSUPPORTED_IMAGE', 'EXIF editing supports JPEG, PNG and WebP containers.');
}

function snapshot(model) {
  const groups = GROUP_ORDER.map(group => [group, (model?.groups[group] ?? []).map(entry => [entry.tag, entry.type, entry.count, Buffer.from(entry.raw).toString('base64')]).sort((a, b) => a[0] - b[0])]);
  const thumbnail = Buffer.from(model?.thumbnail ?? []).toString('base64'), populated = thumbnail || groups.some(([, entries]) => entries.length);
  return JSON.stringify([populated ? model?.littleEndian !== false : true, groups, thumbnail]);
}
function containerSnapshot(item) {
  const hash = createHash('sha256'), add = (type, data) => { hash.update(`${type}:${data.length}:`); hash.update(data); };
  if (item.kind === 'jpeg') {
    for (const segment of item.doc.segments) if (!(segment.marker === 225 && text(segment.payload.subarray(0, 6)) === 'Exif\0\0')) add(segment.marker, segment.payload);
    add('scan', item.doc.scan);
  } else {
    const chunks = item.doc.chunks.filter(chunk => (chunk.type ?? chunk.fourcc) !== (item.kind === 'png' ? 'eXIf' : 'EXIF'));
    // The unchanged WebP writer sorts chunks and updates only metadata flags.
    if (item.kind === 'webp') chunks.sort((a, b) => a.fourcc.localeCompare(b.fourcc));
    for (const chunk of chunks) {
      const type = chunk.type ?? chunk.fourcc;
      if (type !== 'VP8X') add(type, chunk.data);
    }
  }
  return hash.digest('hex');
}
function inventory(item) {
  return { exif_tags: GROUP_ORDER.reduce((sum, group) => sum + (item.exif?.groups[group].length ?? 0), 0), exif_present: Boolean(item.meta.exif),
    thumbnail_present: Boolean(item.exif?.thumbnail?.length), icc_present: Boolean(item.meta.icc), xmp_present: Boolean(item.meta.xmp),
    iptc_present: Boolean(item.meta.iptc), comments: item.meta.comments.length, text_chunks: item.meta.text.length, extra_blocks: item.meta.extras.length };
}
function admissibleValue(item, type) {
  if (item.group === 'ifd0' && item.tag === 0x0112 && (type !== 3 || !/^[1-8]$/.test(item.value))) configError();
  if (XP.has(item.tag)) { if (item.group !== 'ifd0' || type !== 1) configError(); return; }
  if (item.tag === 0x9286) { if (item.group !== 'exif' || type !== 7) configError(); return; }
  if (type === 2) { if (!/^[\x01-\x7f]*$/.test(item.value)) configError(); return; }
  if (type === 7) configError();
  const values = item.value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (!integer(values.length, 1, 256) || values.some(value => !Number.isFinite(value))) configError();
  const bounds = { 1: [0, 255], 3: [0, 65535], 4: [0, 4294967295], 6: [-128, 127], 8: [-32768, 32767], 9: [-2147483648, 2147483647] };
  if (bounds[type] && values.some(value => !integer(value, ...bounds[type]))) configError();
  if (type === 5 && values.some(value => value < 0 || value > 4294967295)
      || type === 10 && values.some(value => value < -2147483648 || value > 2147483647)
      || type === 11 && values.some(value => !Number.isFinite(Math.fround(value)))) configError();
}

async function processEdit(bytes, configBytes) {
  const config = editConfig(configBytes), admitted = containerAdmission(bytes), item = await readBytes(bytes);
  if (!item.ok || item.kind !== admitted.kind || admitted.raw && !item.exif?.ok) invalid();
  const model = item.exif ?? { ok: true, littleEndian: true, groups: Object.fromEntries(GROUP_ORDER.map(group => [group, []])), thumbnail: null };
  const before = inventory(item), picture = containerSnapshot(item), originalDimensions = rasterInputDimensions(item);
  if (item.kind === 'webp') {
    const dimensions = rasterInputDimensions(item);
    if (!dimensions || !integer(dimensions.width, 1, 16383) || !integer(dimensions.height, 1, 16383)) invalid();
    item.doc.canvas = dimensions;
  }
  for (const change of config.remove) {
    const entries = model.groups[change.group], index = entries.findIndex(entry => entry.tag === change.tag);
    if (index < 0) throw new AdapterError('EXIF_TAG_MISSING', 'A requested removal tag was not present. No output was written.');
    entries.splice(index, 1);
  }
  let rounded = 0;
  for (const change of config.set) {
    const entries = model.groups[change.group], entry = entries.find(entry => entry.tag === change.tag), type = entry?.type ?? change.type;
    if (!type || entry && change.type !== undefined && change.type !== type) configError();
    admissibleValue(change, type);
    if ([5, 10, 11].includes(type)) rounded++;
    if (entry) { if (!setEntryValue(entry, change.value, model.littleEndian)) configError(); }
    else { const created = createEntry(change.tag, type, change.value, model.littleEndian); if (!created) configError(); entries.push(created); }
  }
  if (GROUP_ORDER.reduce((sum, group) => sum + model.groups[group].length, 0) > MAX_EXIF_EDIT_TAGS - 5) limit();
  const expected = snapshot(model), exif = serializeExif(model); exifAdmission(exif);
  const data = serialize(item, { exif });
  if (data.length > MAX_EXIF_EDIT_OUTPUT_BYTES) limit();
  containerAdmission(data); const checked = await readBytes(data);
  if (!checked.ok || checked.kind !== item.kind || exif && !checked.exif?.ok || snapshot(checked.exif) !== expected
      || containerSnapshot(checked) !== picture || JSON.stringify(rasterInputDimensions(checked)) !== JSON.stringify(originalDimensions)) verification();
  if (item.kind === 'webp') {
    const oldHeader = item.doc.chunks.find(chunk => chunk.fourcc === 'VP8X')?.data;
    const header = checked.doc.chunks.find(chunk => chunk.fourcc === 'VP8X')?.data;
    if (oldHeader && (!header || !equal(oldHeader.subarray(1), header.subarray(1)) || (oldHeader[0] & ~8) !== (header[0] & ~8))) verification();
    if (header) {
      const has = type => checked.doc.chunks.some(chunk => chunk.fourcc === type), lossless = checked.doc.chunks.find(chunk => chunk.fourcc === 'VP8L');
      const alpha = has('ALPH') || Boolean(lossless?.data[4] & 16);
      if (Boolean(header[0] & 16) !== alpha || Boolean(header[0] & 8) !== Boolean(exif)
          || Boolean(header[0] & 32) !== has('ICCP') || Boolean(header[0] & 4) !== has('XMP ')) verification();
    }
  }
  return { data, kind: item.kind, before, after: inventory(checked), set_count: config.set.length, removed_count: config.remove.length,
    rounded_numeric_tags: rounded, verification: { raw_tags: true, thumbnail: true, compressed_picture_bytes: true, other_container_blocks: true, decoded_pixels: false } };
}

async function runWorker(bytes, edits, { signal } = {}) {
  const source = Uint8Array.from(bytes), config = Uint8Array.from(edits), worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'abox-exif-edit', source, config }, transferList: [source.buffer, config.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'EXIF editing exceeded its two-minute worker limit.')), 120_000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('EXIF_EDIT_LIMIT', 'The isolated EXIF worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('EXIF_EDIT_LIMIT', 'The isolated EXIF worker stopped before returning a verified result.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

export async function editExif(args, options = {}) {
  options.signal?.throwIfAborted(); const output = await newOutput(args.output_path);
  const input = await readInput(args.input_path, { max_bytes: MAX_EXIF_EDIT_INPUT_BYTES }), edits = await readInput(args.edits_path, { max_bytes: MAX_EXIF_EDIT_CONFIG_BYTES });
  options.signal?.throwIfAborted(); const made = await runWorker(input.data, edits.data, options), data = Buffer.from(made.data); delete made.data;
  requireExtension(output, outputType(made.kind).mime); options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'edit-exif', input_path: input.path, output_path: output, edits_path: edits.path,
    input_bytes: input.data.length, output_bytes: data.length, format: made.kind, verified: true, ...made,
    warnings: ['Only requested EXIF tags are changed. Other metadata and the compressed picture remain; this operation is not anonymization.',
      'The embedded thumbnail is retained. Maker-note bytes are retained unless explicitly removed; undocumented offsets inside them may become invalid when EXIF is rebuilt.',
      'Numeric rational and Float32 values can be rounded by the existing encoder. Orientation and other interpretation tags may change how viewers display the unchanged picture.',
      'Verification checks container and raw metadata preservation; it does not decode the picture or prove that the source image is visually valid.'] };
}

if (!isMainThread && workerData?.kind === 'abox-exif-edit') {
  try {
    const result = await processEdit(workerData.source, workerData.config);
    parentPort.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'EXIF_EDIT_FAILED', message: 'The existing image metadata engine could not finish this edit. No output was written; metadata values are excluded from errors.' } });
  } finally { parentPort.close(); }
}
