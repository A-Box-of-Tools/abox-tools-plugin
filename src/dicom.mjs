import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseFile, parseDataset, PIXEL_DATA } from '../vendor/abox/tools/dicom-viewer/src/dicom.js';
import { describe } from '../vendor/abox/tools/dicom-viewer/src/dictionary.js';
import { imageInfo, decodeFrame } from '../vendor/abox/tools/dicom-viewer/src/pixels.js';
import { fullRange, render } from '../vendor/abox/tools/dicom-viewer/src/window.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_DICOM_INPUT_BYTES = 64 * 2 ** 20;
export const MAX_DICOM_OUTPUT_BYTES = 32 * 2 ** 20;
export const MAX_DICOM_SIDE = 4096;
export const MAX_DICOM_PIXELS = 4_000_000;
export const MAX_DICOM_FRAMES = 128;
export const MAX_DICOM_TAGS = 10_000;
export const MAX_DICOM_SEQUENCE_DEPTH = 0;
export const MAX_DICOM_RLE_FRAMES = 1;
export const MAX_DICOM_RLE_FRAGMENTS = 1;
const TIMEOUT_MS = 120_000;
const SYNTAXES = Object.freeze({ '1.2.840.10008.1.2': { explicit: false, little: true },
  '1.2.840.10008.1.2.1': { explicit: true, little: true }, '1.2.840.10008.1.2.2': { explicit: true, little: false },
  '1.2.840.10008.1.2.5': { explicit: true, little: true, rle: true } });
const LONG = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);
const VRS = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW',
  'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'TM', 'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT']);
const decoder = new TextDecoder('utf-8');
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const invalid = () => { throw new AdapterError('INVALID_DICOM', 'The DICOM wrapper or flat dataset is incomplete, ambiguous or malformed. No output was written.'); };
const unsupported = () => { throw new AdapterError('DICOM_UNSUPPORTED', 'This bounded adapter supports flat PS3.10 native integer data or the admitted single-frame RLE subset. Sequences, other undefined lengths, guessed encodings and other compressed pixels are unsupported.'); };
const imageUnsupported = () => { throw new AdapterError('DICOM_IMAGE_UNSUPPORTED', 'Preview supports complete 8/16-bit MONOCHROME1/2 integer data or unsigned 8-bit RGB, without unsupported palette, LUT, enhanced-frame or presentation transforms.'); };
const invalidRle = () => { throw new AdapterError('DICOM_RLE_UNSUPPORTED', 'RLE requires one complete frame in one fragment with an empty offset table, exact byte planes and complete bounded PackBits runs. No output was written.'); };

function ascii(bytes) {
  if (bytes.some(value => value > 127)) invalid(); return Buffer.from(bytes).toString('latin1').replace(/[\0 ]+$/, '');
}

function encapsulatedAdmission(bytes, at) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const item = (offset, tag) => {
    if (offset + 8 > bytes.length || view.getUint16(offset, true) !== 0xfffe || view.getUint16(offset + 2, true) !== tag) invalidRle();
    return view.getUint32(offset + 4, true);
  };
  if (item(at, 0xe000) !== 0) invalidRle(); at += 8;
  const length = item(at, 0xe000), offset = at + 8;
  if (length < 64 || length % 2 || offset + length > bytes.length) invalidRle();
  const end = offset + length;
  if (item(end, 0xe0dd) !== 0) invalidRle();
  return { end: end + 8, fragment: { offset, length } };
}

// This is an admission walk over lengths, not another DICOM value reader. It
// refuses recursion before the unchanged dataset parser sees any sequence.
function flat(bytes, start, end, syntax, meta = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), seen = new Set(); let at = start, privateTags = 0;
  while (at < end) {
    if (at + 8 > end) invalid();
    const group = view.getUint16(at, syntax.little), element = view.getUint16(at + 2, syntax.little);
    const tag = group.toString(16).padStart(4, '0') + element.toString(16).padStart(4, '0');
    if (meta && group !== 2 || group === 0xfffe || seen.has(tag)) invalid();
    seen.add(tag); if (seen.size > MAX_DICOM_TAGS) throw new AdapterError('DICOM_LIMIT', 'The DICOM file exceeds 10000 flat elements.');
    if (group & 1) privateTags++;
    let vr, length, header;
    if (syntax.explicit) {
      vr = String.fromCharCode(bytes[at + 4], bytes[at + 5]); if (!VRS.has(vr)) unsupported();
      header = LONG.has(vr) ? 12 : 8;
      if (at + header > end) invalid();
      if (header === 12 && (bytes[at + 6] || bytes[at + 7])) invalid();
      length = header === 12 ? view.getUint32(at + 8, syntax.little) : view.getUint16(at + 6, syntax.little);
    } else { vr = describe(tag).vr; header = 8; length = view.getUint32(at + 4, syntax.little); }
    if (vr === 'SQ') unsupported();
    if (length === 0xffffffff) {
      if (!syntax.rle || tag !== PIXEL_DATA || vr !== 'OB') unsupported();
      at = encapsulatedAdmission(bytes, at + header).end; continue;
    }
    if (length % 2 || at + header + length > end) invalid();
    at += header + length;
  }
  if (at !== end) invalid(); return { count: seen.size, private_tags: privateTags };
}

function admission(bytes) {
  if (bytes.length < 144 || !Buffer.from(bytes.subarray(128, 132)).equals(Buffer.from('DICM'))) unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(132, true) !== 2 || view.getUint16(134, true) !== 0 || bytes[136] !== 85 || bytes[137] !== 76
      || view.getUint16(138, true) !== 4) invalid();
  const end = 144 + view.getUint32(140, true);
  if (end <= 144 || end > bytes.length) invalid();
  const meta = flat(bytes, 132, end, { little: true, explicit: true }, true);
  // Meta elements are now known to be flat, bounded and complete.
  const wrapped = parseFile(bytes);
  if (!wrapped.hasPreamble || wrapped.datasetStart !== end || wrapped.warnings.length
      || !Object.hasOwn(SYNTAXES, wrapped.syntax.uid) || wrapped.syntax.deflated
      || wrapped.syntax.encapsulated && !SYNTAXES[wrapped.syntax.uid].rle) unsupported();
  const body = flat(bytes, end, bytes.length, SYNTAXES[wrapped.syntax.uid]);
  if (meta.count + body.count > MAX_DICOM_TAGS) throw new AdapterError('DICOM_LIMIT', 'The DICOM file exceeds 10000 flat elements.');
  return { wrapped, tags: meta.count + body.count, private_tags: body.private_tags };
}

function unsigned(dataset, tag, fallback) {
  const element = dataset.byTag.get(tag);
  if (!element) { if (fallback !== undefined) return fallback; imageUnsupported(); }
  if (element.vr !== 'US' || element.value?.length !== 2) imageUnsupported();
  return new DataView(element.value.buffer, element.value.byteOffset, 2).getUint16(0, element.little);
}
function stringValue(dataset, tag, fallback, vr) {
  const element = dataset.byTag.get(tag);
  if (!element) return fallback;
  if (element.vr !== vr || !element.value || element.value.length > 128) imageUnsupported(); return ascii(element.value);
}
function decimal(dataset, tag, fallback) {
  const text = stringValue(dataset, tag, null, 'DS');
  if (text === null) return fallback;
  if (!/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?$/.test(text)) imageUnsupported();
  const value = Number(text); if (!Number.isFinite(value)) imageUnsupported(); return value;
}

// The source RLE decoder deliberately clips overruns and pads short frames.
// Prove complete runs first, then use this same non-allocating walk to check
// each decoded byte; the unchanged decoder remains the processing engine.
function walkRle(fragment, info, visit) {
  if (fragment.length < 64) invalidRle();
  const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength), perSample = info.bitsAllocated / 8,
    wanted = info.samplesPerPixel * perSample, count = info.rows * info.columns;
  if (view.getUint32(0, true) !== wanted) invalidRle();
  const offsets = [];
  for (let segment = 0; segment < 15; segment++) {
    const offset = view.getUint32(4 + segment * 4, true);
    if (segment >= wanted) { if (offset) invalidRle(); }
    else { if (offset < 64 || offset % 2 || offset >= fragment.length || segment === 0 && offset !== 64 || segment && offset <= offsets.at(-1)) invalidRle(); offsets.push(offset); }
  }
  for (let segment = 0; segment < wanted; segment++) {
    const from = offsets[segment], to = offsets[segment + 1] ?? fragment.length; let at = from, written = 0;
    while (written < count) {
      if (at >= to) invalidRle();
      const control = fragment[at++]; if (control === 128) continue;
      const run = control < 128 ? control + 1 : 257 - control;
      if (written + run > count || at + (control < 128 ? run : 1) > to) invalidRle();
      if (visit) {
        if (control < 128) for (let index = 0; index < run; index++) visit(segment, written + index, fragment[at + index]);
        else for (let index = 0; index < run; index++) visit(segment, written + index, fragment[at]);
      }
      at += control < 128 ? run : 1; written += run;
    }
    if (at !== to && !(to - at === 1 && (at - from) % 2 && fragment[at] === 0)) invalidRle();
  }
}

function imagePlan(bytes, dataset, syntax) {
  const pixel = dataset.byTag.get(PIXEL_DATA);
  if (!pixel) return null;
  const rows = unsigned(dataset, '00280010'), columns = unsigned(dataset, '00280011'), samples = unsigned(dataset, '00280002');
  const allocated = unsigned(dataset, '00280100'), stored = unsigned(dataset, '00280101'), high = unsigned(dataset, '00280102'), representation = unsigned(dataset, '00280103');
  const photo = stringValue(dataset, '00280004', '', 'CS'), frameText = stringValue(dataset, '00280008', '1', 'IS');
  if (!/^\d{1,5}$/.test(frameText)) imageUnsupported(); const frames = Number(frameText);
  if (!integer(rows, 1, MAX_DICOM_SIDE) || !integer(columns, 1, MAX_DICOM_SIDE) || rows * columns > MAX_DICOM_PIXELS
      || !integer(frames, 1, MAX_DICOM_FRAMES)) throw new AdapterError('DICOM_LIMIT', 'DICOM preview supports 4096 pixels per side, 4 megapixels per frame and at most 128 frames.');
  const rgb = photo === 'RGB', mono = photo === 'MONOCHROME1' || photo === 'MONOCHROME2', planar = unsigned(dataset, '00280006', 0);
  if (rgb ? samples !== 3 || allocated !== 8 || stored !== 8 || high !== 7 || representation !== 0 || ![0, 1].includes(planar)
    : !mono || samples !== 1 || ![8, 16].includes(allocated) || !integer(stored, 1, allocated) || high !== stored - 1 || ![0, 1].includes(representation) || planar !== 0) imageUnsupported();
  for (const tag of ['00281101', '00281102', '00281103', '00281201', '00281202', '00281203', '00280121', '7fe00008', '7fe00009']) {
    if (dataset.byTag.has(tag)) imageUnsupported();
  }
  const presentation = stringValue(dataset, '20500020', 'IDENTITY', 'CS');
  if (presentation !== 'IDENTITY') imageUnsupported();
  const slope = decimal(dataset, '00281053', 1), intercept = decimal(dataset, '00281052', 0);
  if (!(slope > 0 && slope <= 1e9) || Math.abs(intercept) > 1e12 || rgb && (slope !== 1 || intercept !== 0)) imageUnsupported();
  const padding = dataset.byTag.get('00280120');
  if (padding && (!['US', 'SS'].includes(padding.vr) || padding.value?.length !== 2)) imageUnsupported();
  const rle = syntax.pixels === 'rle'; let fragment = null;
  if (rle) {
    if (frames !== 1 || pixel.vr !== 'OB' || pixel.length !== 0xffffffff || pixel.fragments?.length !== 1 || pixel.offsetTable?.length !== 0) invalidRle();
    const admitted = encapsulatedAdmission(bytes, pixel.offset), source = pixel.fragments[0];
    if (source.offset !== admitted.fragment.offset || source.length !== admitted.fragment.length) invalidRle();
    fragment = bytes.subarray(source.offset, source.offset + source.length);
  } else if (!['OB', 'OW'].includes(pixel.vr) || allocated === 16 && pixel.vr !== 'OW' || pixel.fragments || pixel.length === 0xffffffff) imageUnsupported();
  // The source byte decoder does not swap pairs for 8-bit OW data in the
  // retired big-endian syntax. Refuse that ambiguous route; OB is byte ordered.
  if (!syntax.little && allocated === 8 && pixel.vr === 'OW') imageUnsupported();
  const expected = rows * columns * samples * allocated / 8 * frames, padded = expected + expected % 2;
  if (!rle && (!Number.isSafeInteger(expected) || pixel.length !== padded || pixel.offset + pixel.length > bytes.length
      || padded !== expected && bytes[pixel.offset + expected] !== 0)) {
    throw new AdapterError('DICOM_PIXEL_LENGTH', 'Pixel Data must contain every declared frame exactly, with only the required final even-byte padding. Truncated frames are never padded by this adapter.');
  }
  const info = imageInfo(dataset, decoder);
  if (info.rows !== rows || info.columns !== columns || info.frames !== frames || info.bitsAllocated !== allocated || info.bitsStored !== stored
      || info.highBit !== high || info.samplesPerPixel !== samples || info.photometric !== photo || info.slope !== slope || info.intercept !== intercept || info.palette) imageUnsupported();
  const low = representation ? -(2 ** (stored - 1)) : 0, highValue = representation ? 2 ** (stored - 1) - 1 : 2 ** stored - 1;
  if (info.padding !== null && (!Number.isSafeInteger(info.padding) || info.padding < low || info.padding > highValue)) imageUnsupported();
  if (rle) walkRle(fragment, info);
  return { pixel, info, fragment, summary: { width: columns, height: rows, frame_count: frames, samples_per_pixel: samples,
    compression: rle ? 'rle-lossless' : 'native', compressed_stream_verified: rle,
    bits_allocated: allocated, bits_stored: stored, signed: representation === 1, planar: planar === 1, photometric: photo } };
}

function requestSettings(args) {
  const settings = { frame: args.frame === undefined ? 1 : args.frame, invert: args.invert === undefined ? false : args.invert,
    window_center: args.window_center === undefined ? null : args.window_center, window_width: args.window_width === undefined ? null : args.window_width };
  const explicit = args.window_center !== undefined || args.window_width !== undefined;
  if (!integer(settings.frame, 1, MAX_DICOM_FRAMES) || typeof settings.invert !== 'boolean'
      || explicit && (!(typeof settings.window_center === 'number' && Number.isFinite(settings.window_center) && Math.abs(settings.window_center) <= 1e15)
        || !(typeof settings.window_width === 'number' && Number.isFinite(settings.window_width) && settings.window_width >= 1 && settings.window_width <= 1e15))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Use a one-based frame from 1 to 128, boolean invert, and both finite window_center/window_width together (width at least 1).');
  }
  return settings;
}

function verifyStored(bytes, plan, frame, index, syntax) {
  const { info, pixel } = plan, count = info.rows * info.columns, channels = info.samplesPerPixel;
  if (frame.width !== info.columns || frame.height !== info.rows || frame.samples !== channels || frame.values.length !== count * channels) imageUnsupported();
  if (plan.fragment) {
    const perSample = info.bitsAllocated / 8, low = info.signed ? -(2 ** (info.bitsStored - 1)) : 0,
      high = info.signed ? 2 ** (info.bitsStored - 1) - 1 : 2 ** info.bitsStored - 1;
    for (const value of frame.values) if (!integer(value, low, high)) imageUnsupported();
    walkRle(plan.fragment, info, (segment, pixel, byte) => {
      const sample = Math.floor(segment / perSample), shift = (perSample - 1 - segment % perSample) * 8,
        mask = shift >= info.bitsStored ? 0 : (1 << Math.min(8, info.bitsStored - shift)) - 1;
      if ((byte & mask) !== ((frame.values[pixel * channels + sample] >>> shift) & mask)) {
        throw new AdapterError('VERIFICATION_FAILED', 'The decoded DICOM RLE stored samples did not match every admitted compressed byte plane.');
      }
    });
    return count * channels;
  }
  const perSample = info.bitsAllocated / 8, start = pixel.offset + index * count * channels * perSample;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), mask = (1 << info.bitsStored) - 1, sign = 1 << (info.bitsStored - 1);
  for (let at = 0; at < count; at++) for (let channel = 0; channel < channels; channel++) {
    const sample = info.planar ? channel * count + at : at * channels + channel, offset = start + sample * perSample;
    let expected = perSample === 1 ? bytes[offset] : view.getUint16(offset, syntax.little);
    expected &= mask; if (info.signed && expected & sign) expected -= mask + 1;
    if (frame.values[at * channels + channel] !== expected) throw new AdapterError('VERIFICATION_FAILED', 'The decoded DICOM sample values did not match the declared native sample layout.');
  }
  return count * channels;
}

function processDicom(bytes, job, settings) {
  const admitted = admission(bytes), { wrapped } = admitted;
  const dataset = parseDataset(bytes, { start: wrapped.datasetStart, syntax: wrapped.syntax });
  if (dataset.warnings.length || dataset.end !== bytes.length) invalid();
  const plan = imagePlan(bytes, dataset, wrapped.syntax), summary = { has_preamble: true, transfer_syntax: wrapped.syntax.name,
    explicit_vr: wrapped.syntax.explicit, little_endian: wrapped.syntax.little, element_count: admitted.tags,
    private_element_count: admitted.private_tags, sequence_depth: 0, pixel_data_present: Boolean(plan),
    render_supported: Boolean(plan), ...(plan?.summary ?? {}), header_verified: true };
  if (job === 'inspect') return { summary };
  if (!plan) throw new AdapterError('DICOM_NO_PIXELS', 'This DICOM dataset has no supported integer Pixel Data element.');
  if (settings.frame > plan.info.frames) throw new AdapterError('DICOM_FRAME', 'The requested frame does not exist in this DICOM file.');
  if (plan.info.samplesPerPixel === 3 && (settings.window_center !== null || settings.invert)) {
    throw new AdapterError('DICOM_WINDOW', 'RGB previews use the stored color samples; grayscale window and invert controls apply only to MONOCHROME1/2.');
  }
  const frame = decodeFrame(bytes, plan.pixel, plan.info, wrapped.syntax, settings.frame - 1);
  const samplesChecked = verifyStored(bytes, plan, frame, settings.frame - 1, wrapped.syntax);
  const window = settings.window_center === null ? fullRange(frame, plan.info) : { center: settings.window_center, width: settings.window_width };
  const pixels = render(frame, plan.info, { center: window.center, width: window.width, invert: settings.invert, voiFunction: 'LINEAR' });
  if (pixels.width !== plan.info.columns || pixels.height !== plan.info.rows || pixels.data.length !== pixels.width * pixels.height * 4) imageUnsupported();
  for (let at = 3; at < pixels.data.length; at += 4) if (pixels.data[at] !== 255) imageUnsupported();
  return { pixels: pixels.data, summary: { ...summary, selected_frame: settings.frame,
    native_samples_checked: plan.fragment ? 0 : samplesChecked, stored_samples_checked: samplesChecked,
    decoded_sample_layout: 'interleaved',
    window_source: settings.window_center === null ? 'full-range' : 'custom', inverted: settings.invert } };
}

function publicFailure(error) {
  return error instanceof AdapterError ? { code: error.code, message: error.message }
    : { code: 'INVALID_DICOM', message: 'The existing DICOM parser or renderer could not process this bounded subset. Patient fields are excluded from errors.' };
}
async function runWorker(input, job, settings, options) {
  const bytes = Uint8Array.from(input), worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-dicom', bytes, job, settings },
    transferList: [bytes.buffer], execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'DICOM processing exceeded the two-minute worker limit.')), TIMEOUT_MS);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('DICOM_LIMIT', 'The isolated DICOM worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('DICOM_LIMIT', 'The isolated DICOM worker stopped before returning a result.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

const warnings = ['Technical preview only; no diagnosis, medical measurement, authenticity check or clinical interpretation is provided.',
  'Names, dates, patient IDs and instance UIDs are omitted from the summary. This is not anonymization: burned-in labels may remain in the pixels.'];

export async function inspectDicom(args, options = {}) {
  options.signal?.throwIfAborted(); const input = await readInput(args.input_path, { max_bytes: MAX_DICOM_INPUT_BYTES });
  options.signal?.throwIfAborted(); const made = await runWorker(input.data, 'inspect', {}, options); options.signal?.throwIfAborted();
  return { ok: true, operation: 'dicom-inspect', input_path: input.path, input_bytes: input.data.length, ...made.summary,
    verified: false, verification: { header_structure: true, decoded_pixels: false }, warnings };
}

export async function renderDicom(args, options = {}) {
  options.signal?.throwIfAborted(); const settings = requestSettings(args), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.png') throw new AdapterError('OUTPUT_EXTENSION', 'DICOM technical previews use a new .png output file.');
  const input = await readInput(args.input_path, { max_bytes: MAX_DICOM_INPUT_BYTES }); options.signal?.throwIfAborted();
  const made = await runWorker(input.data, 'render', settings, options), pixels = Buffer.from(made.pixels), { width, height } = made.summary;
  const encoded = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'preview.rgba', mimeType: 'application/octet-stream', buffer: pixels });
    return page.evaluate(async ({ width, height, maxBytes }) => {
      const { encodePng } = await import('/vendor/abox/tools/split-gif/src/frames.js');
      let bitmap, canvas;
      try {
        const pixels = new Uint8ClampedArray(await document.querySelector('#input').files[0].arrayBuffer());
        if (pixels.length !== width * height * 4) return { error: true };
        const blob = await encodePng(pixels, width, height);
        if (blob.type !== 'image/png' || !blob.size || blob.size > maxBytes) return { error: true };
        bitmap = await createImageBitmap(blob); if (bitmap.width !== width || bitmap.height !== height) return { error: true };
        canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        for (let row = 0; row < height; row++) {
          context.clearRect(0, 0, width, 1); context.drawImage(bitmap, 0, row, width, 1, 0, 0, width, 1);
          const actual = context.getImageData(0, 0, width, 1).data, start = row * width * 4;
          for (let at = 0; at < actual.length; at++) if (actual[at] !== pixels[start + at]) return { error: true };
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        return { data, pixels_checked: width * height };
      } catch { return { error: true }; }
      finally { bitmap?.close(); if (canvas) canvas.width = canvas.height = 0; }
    }, { width, height, maxBytes: MAX_DICOM_OUTPUT_BYTES });
  }, options);
  if (encoded.error) throw new AdapterError('VERIFICATION_FAILED', 'The PNG did not retain the exact rendered technical preview pixels. No output was written.');
  const data = Buffer.from(encoded.data, 'base64');
  if (data.length < 33 || data.length > MAX_DICOM_OUTPUT_BYTES
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || data.toString('latin1', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height
      || encoded.pixels_checked !== width * height) throw new AdapterError('VERIFICATION_FAILED', 'The returned preview PNG did not match the verified format and dimensions.');
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'dicom-render', input_path: input.path, input_bytes: input.data.length, output_path: output,
    output_bytes: data.length, format: 'png', ...made.summary, verified: true,
    verification: { header_structure: true, native_samples_checked: made.summary.native_samples_checked,
      stored_samples_checked: made.summary.stored_samples_checked, compressed_stream: made.summary.compressed_stream_verified,
      png_pixels_checked: encoded.pixels_checked }, warnings };
}

if (!isMainThread && workerData?.kind === 'abox-dicom') {
  try {
    const result = processDicom(workerData.bytes, workerData.job, workerData.settings);
    parentPort.postMessage({ result }, result.pixels ? [result.pixels.buffer] : []);
  } catch (error) { parentPort.postMessage({ error: publicFailure(error) }); }
  finally { parentPort.close(); }
}
