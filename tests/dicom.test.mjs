import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectDicom, renderDicom, MAX_DICOM_INPUT_BYTES, MAX_DICOM_TAGS } from '../src/dicom.mjs';
import { losslessJpeg, evenJpeg, encapsulatedDicom } from './fixtures/dicom-lossless.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-dicom-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const longVr = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);
function element(group, tag, vr, value, { explicit = true, little = true, length = null } = {}) {
  let data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (data.length % 2) data = Buffer.concat([data, Buffer.from([['UI', 'OB', 'OW', 'UN'].includes(vr) ? 0 : 32])]);
  const header = Buffer.alloc(explicit && longVr.has(vr) ? 12 : 8);
  header.writeUInt16LE(group); header.writeUInt16LE(tag, 2);
  if (!little) { header.writeUInt16BE(group); header.writeUInt16BE(tag, 2); }
  if (explicit) {
    header.write(vr, 4, 'latin1');
    if (longVr.has(vr)) little ? header.writeUInt32LE(length ?? data.length, 8) : header.writeUInt32BE(length ?? data.length, 8);
    else little ? header.writeUInt16LE(length ?? data.length, 6) : header.writeUInt16BE(length ?? data.length, 6);
  } else little ? header.writeUInt32LE(length ?? data.length, 4) : header.writeUInt32BE(length ?? data.length, 4);
  return Buffer.concat([header, data]);
}
function fixture({ uid = '1.2.840.10008.1.2.1', width = 2, height = 2, frames = 1, bits = 16, stored = bits,
  samples = 1, photo = 'MONOCHROME2', signed = false, pixels = [0, 1, 2, 3], pixelBytes = null,
  extra = [], includePixels = true } = {}) {
  const syntax = { explicit: uid !== '1.2.840.10008.1.2', little: uid !== '1.2.840.10008.1.2.2' };
  const us = value => { const data = Buffer.alloc(2); syntax.little ? data.writeUInt16LE(value) : data.writeUInt16BE(value); return data; };
  const meta = element(2, 0x10, 'UI', uid), length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const parts = [Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', length), meta,
    element(0x10, 0x10, 'PN', 'PRIVATE^PATIENT', syntax), element(0x10, 0x20, 'LO', 'PRIVATE-PATIENT-ID', syntax),
    element(8, 0x20, 'DA', '20011231', syntax), element(8, 0x80, 'LO', 'PRIVATE INSTITUTION', syntax),
    element(0x20, 0x0d, 'UI', '1.2.3.987654321.12345', syntax), element(0x11, 0x10, 'LO', 'PRIVATE-CREATOR', syntax),
    element(0x28, 0x10, 'US', us(height), syntax), element(0x28, 0x11, 'US', us(width), syntax),
    element(0x28, 2, 'US', us(samples), syntax), element(0x28, 4, 'CS', photo, syntax),
    element(0x28, 8, 'IS', String(frames), syntax), element(0x28, 0x100, 'US', us(bits), syntax),
    element(0x28, 0x101, 'US', us(stored), syntax), element(0x28, 0x102, 'US', us(stored - 1), syntax),
    element(0x28, 0x103, 'US', us(signed ? 1 : 0), syntax), ...extra];
  if (includePixels) {
    const data = pixelBytes ?? Buffer.alloc(pixels.length * bits / 8);
    if (!pixelBytes) for (const [at, value] of pixels.entries()) {
      if (bits === 8) data[at] = value & 255;
      else if (bits === 16) syntax.little ? data.writeUInt16LE(value & 65535, at * 2) : data.writeUInt16BE(value & 65535, at * 2);
    }
    parts.push(element(0x7fe0, 0x10, bits === 8 ? 'OB' : 'OW', data, syntax));
  }
  return Buffer.concat(parts);
}
function rleFrame(segments = [Buffer.from([253, 0]), Buffer.from([3, 0, 1, 2, 3])]) {
  const header = Buffer.alloc(64), bodies = []; header.writeUInt32LE(segments.length); let offset = 64;
  for (const [index, segment] of segments.entries()) {
    const data = segment.length % 2 ? Buffer.concat([segment, Buffer.from([0])]) : segment;
    header.writeUInt32LE(offset, 4 + index * 4); offset += data.length; bodies.push(data);
  }
  return Buffer.concat([header, ...bodies]);
}
function rleFile(fragment, { bot = Buffer.alloc(0), multiple = false, delimiter = true, delimiterLength = 0, uid = '1.2.840.10008.1.2.5', ...settings } = {}) {
  const native = fixture({ uid, ...settings }), tag = native.lastIndexOf(Buffer.from([0xe0, 0x7f, 0x10, 0])); assert.ok(tag > 0);
  const header = Buffer.alloc(12); header.writeUInt16LE(0x7fe0); header.writeUInt16LE(0x10, 2); header.write('OB', 4); header.writeUInt32LE(0xffffffff, 8);
  const item = (code, data, length = data.length) => { const out = Buffer.alloc(8); out.writeUInt16LE(0xfffe); out.writeUInt16LE(code, 2); out.writeUInt32LE(length, 4); return Buffer.concat([out, data]); };
  return Buffer.concat([native.subarray(0, tag), header, item(0xe000, bot), item(0xe000, fragment),
    ...(multiple ? [item(0xe000, fragment)] : []), ...(delimiter ? [item(0xe0dd, Buffer.alloc(0), delimiterLength)] : [])]);
}

test('DICOM inspection returns technical shape and safe enums without patient values, UIDs or pixel content', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm');
  for (const uid of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    const source = fixture({ uid }); await writeFile(input, source); const result = await inspectDicom({ input_path: input });
    assert.equal(result.width, 2); assert.equal(result.height, 2); assert.equal(result.frame_count, 1); assert.equal(result.bits_allocated, 16);
    assert.equal(result.samples_per_pixel, 1); assert.equal(result.photometric, 'MONOCHROME2'); assert.equal(result.private_element_count, 1);
    assert.equal(result.render_supported, true); assert.equal(result.sequence_depth, 0); assert.equal(result.header_verified, true);
    assert.equal(result.verified, false); assert.equal(result.verification.decoded_pixels, false);
    assert.equal(result.little_endian, uid !== '1.2.840.10008.1.2.2');
    assert.equal(result.explicit_vr, uid !== '1.2.840.10008.1.2');
    for (const secret of ['PRIVATE^PATIENT', 'PRIVATE-PATIENT-ID', '20011231', 'PRIVATE INSTITUTION', '987654321', 'PRIVATE-CREATOR']) {
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    assert.equal(digest(await readFile(input)), digest(source));
  }
  await writeFile(input, fixture({ includePixels: false })); const header = await inspectDicom({ input_path: input });
  assert.equal(header.pixel_data_present, false); assert.equal(header.render_supported, false);
  await assert.rejects(renderDicom({ input_path: input, output_path: path.join(directory, 'missing.png') }), { code: 'DICOM_NO_PIXELS' });
});

test('DICOM admission refuses unsupported compression, sequence recursion, undefined lengths and duplicate tags before rendering', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm');
  const cases = [
    [fixture({ uid: '1.2.840.10008.1.2.4.50' }), 'DICOM_UNSUPPORTED'],
    [fixture({ uid: '1.2.840.10008.1.2.1.99' }), 'DICOM_UNSUPPORTED'],
    [fixture({ extra: [element(8, 0x1110, 'SQ', Buffer.alloc(0))] }), 'DICOM_UNSUPPORTED'],
    [fixture({ extra: [element(0x11, 0x1000, 'UN', Buffer.alloc(0), { length: 0xffffffff })] }), 'DICOM_UNSUPPORTED'],
    [fixture({ extra: [element(0x28, 0x10, 'US', Buffer.from([2, 0]))] }), 'INVALID_DICOM'],
    [Buffer.concat([fixture(), Buffer.from([1])]), 'INVALID_DICOM'],
  ];
  const deep = element(8, 0x1110, 'SQ', Buffer.alloc(0), { length: 0xffffffff });
  cases.push([fixture({ extra: [Buffer.concat(Array(1000).fill(deep))] }), 'DICOM_UNSUPPORTED']);
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `refused-${index}.png`); await writeFile(input, source);
    await assert.rejects(inspectDicom({ input_path: input }), error => { assert.equal(error.code, code); assert.ok(!String(error).includes('PRIVATE')); return true; });
    await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await writeFile(input, fixture().subarray(160)); await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_UNSUPPORTED' });
});

test('DICOM image bounds and exact Pixel Data admission reject silent source-engine padding and unsupported transforms', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm');
  const cases = [[fixture({ width: 4097 }), 'DICOM_LIMIT'], [fixture({ width: 3000, height: 3000 }), 'DICOM_LIMIT'],
    [fixture({ frames: 129 }), 'DICOM_LIMIT'], [fixture({ bits: 32, pixelBytes: Buffer.alloc(16) }), 'DICOM_IMAGE_UNSUPPORTED'],
    [fixture({ photo: 'YBR_FULL' }), 'DICOM_IMAGE_UNSUPPORTED'], [fixture({ samples: 2 }), 'DICOM_IMAGE_UNSUPPORTED'],
    [fixture({ pixelBytes: Buffer.alloc(2) }), 'DICOM_PIXEL_LENGTH'], [fixture({ pixelBytes: Buffer.alloc(10) }), 'DICOM_PIXEL_LENGTH'],
    [fixture({ extra: [element(0x28, 0x1053, 'DS', '0')] }), 'DICOM_IMAGE_UNSUPPORTED'],
    [fixture({ extra: [element(0x28, 0x1053, 'DS', '-1')] }), 'DICOM_IMAGE_UNSUPPORTED'],
    [fixture({ extra: [element(0x28, 0x1101, 'US', Buffer.from([1, 0, 0, 0, 8, 0]))] }), 'DICOM_IMAGE_UNSUPPORTED'],
    [fixture({ extra: [element(0x2050, 0x20, 'CS', 'INVERSE')] }), 'DICOM_IMAGE_UNSUPPORTED']];
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `invalid-${index}.png`); await writeFile(input, source);
    await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code });
    await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(digest(await readFile(input)), digest(source));
  }
  const extras = Array.from({ length: MAX_DICOM_TAGS }, (_, at) => element(0x30, at, 'LO', ''));
  await writeFile(input, fixture({ extra: extras })); await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_LIMIT' });
});

test('DICOM argument, output and cancellation contracts retain local sources and existing files', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm'), output = path.join(directory, 'preview.png');
  const source = fixture(); await writeFile(input, source);
  for (const extra of [{ frame: 0 }, { frame: 129 }, { frame: 1.5 }, { frame: null }, { invert: null }, { invert: 'yes' },
    { window_center: null, window_width: null }, { window_center: 0 },
    { window_width: 20 }, { window_center: 0, window_width: 0 }, { window_center: Infinity, window_width: 20 }]) {
    await assert.rejects(renderDicom({ input_path: input, output_path: output, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(renderDicom({ input_path: input, output_path: output, frame: 2 }), { code: 'DICOM_FRAME' });
  await assert.rejects(renderDicom({ input_path: input, output_path: path.join(directory, 'wrong.jpg') }), { code: 'OUTPUT_EXTENSION' });
  await writeFile(output, 'keep'); await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep');
  await assert.rejects(inspectDicom({ input_path: 'relative.dcm' }), { code: 'LOCAL_PATH_REQUIRED' });
  for (const operation of [inspectDicom, renderDicom]) await assert.rejects(operation({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), pending = inspectDicom({ input_path: input }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  assert.equal(digest(await readFile(input)), digest(source));
  const large = path.join(directory, 'large.dcm'), file = await open(large, 'w'); await file.truncate(MAX_DICOM_INPUT_BYTES + 1); await file.close();
  await assert.rejects(inspectDicom({ input_path: large }), { code: 'INPUT_SIZE' });
});

test('single-frame RLE inspection admits exact byte planes before decoding and excludes patient data', async t => {
  const directory = await workspace(t), input = path.join(directory, 'rle.dcm'), source = rleFile(rleFrame()); await writeFile(input, source);
  const result = await inspectDicom({ input_path: input });
  assert.equal(result.compression, 'rle-lossless'); assert.equal(result.compressed_stream_verified, true); assert.equal(result.render_supported, true);
  assert.equal(result.frame_count, 1); assert.equal(result.verified, false); assert.equal(result.verification.decoded_pixels, false);
  assert.equal(result.width, 2); assert.equal(result.height, 2); assert.equal(result.bits_allocated, 16);
  for (const secret of ['PRIVATE', 'PATIENT', '987654321']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(digest(await readFile(input)), digest(source));
});

test('RLE preflight refuses ambiguous encapsulation, byte-plane counts, truncated/overflowed runs and extra trailing codes', async t => {
  const directory = await workspace(t), input = path.join(directory, 'invalid-rle.dcm'), base = rleFrame();
  const count = Buffer.from(base); count.writeUInt32LE(1);
  const unused = Buffer.from(base); unused.writeUInt32LE(64, 12);
  const outside = Buffer.from(base); outside.writeUInt32LE(0xfffffff0, 4);
  const reversed = Buffer.from(base); reversed.writeUInt32LE(64, 8);
  const odd = Buffer.from(base); odd.writeUInt32LE(67, 8);
  const malformed = [count, unused, outside, reversed, odd,
    rleFrame([Buffer.from([0, 0]), Buffer.from([3, 0, 1, 2, 3])]),
    rleFrame([Buffer.from([4, 0, 0, 0, 0, 0]), Buffer.from([3, 0, 1, 2, 3])]),
    rleFrame([Buffer.from([128, 253]), Buffer.from([3, 0, 1, 2, 3])]),
    rleFrame([Buffer.from([253, 0, 128, 128]), Buffer.from([3, 0, 1, 2, 3])]),
    rleFrame([Buffer.from([253, 0]), Buffer.from([3, 0, 1, 2, 3, 9])]),
  ].map(fragment => rleFile(fragment));
  malformed.push(rleFile(base, { bot: Buffer.alloc(4) }), rleFile(base, { multiple: true }), rleFile(base, { delimiter: false }),
    rleFile(base, { delimiterLength: 4 }), rleFile(base, { frames: 2 }));
  for (const [index, source] of malformed.entries()) {
    const output = path.join(directory, `refused-rle-${index}.png`); await writeFile(input, source);
    await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_RLE_UNSUPPORTED' });
    await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code: 'DICOM_RLE_UNSUPPORTED' });
    await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(digest(await readFile(input)), digest(source));
  }
  for (const uid of ['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']) {
    await writeFile(input, rleFile(base, { uid })); await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_JPEG_UNSUPPORTED' });
  }
});

test('JPEG-lossless admission proves exact entropy completion and actual geometry before the source decoder can allocate a frame', async t => {
  const directory = await workspace(t), input = path.join(directory, 'lossless.dcm'), values = [0, 100, 200, 300];
  for (const uid of ['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']) {
    const source = encapsulatedDicom(fixture({ uid, pixels: values }), losslessJpeg(values)); await writeFile(input, source);
    const result = await inspectDicom({ input_path: input }); assert.equal(result.compression, 'jpeg-lossless');
    assert.equal(result.compressed_stream_verified, true); assert.equal(result.render_supported, true); assert.equal(result.verified, false);
    assert.equal(result.verification.decoded_pixels, false); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(digest(await readFile(input)), digest(source));
  }
});

test('JPEG-lossless preflight refuses missing/end markers, incomplete/extra entropy, bad padding, huge SOF and ambiguous Huffman/sampling/scan headers', async t => {
  const directory = await workspace(t), input = path.join(directory, 'bad-lossless.dcm'), base = losslessJpeg([0, 100, 200, 300]),
    end = base.lastIndexOf(Buffer.from([255, 217])), frame = base.indexOf(Buffer.from([255, 195])), huff = base.indexOf(Buffer.from([255, 196])), scan = base.indexOf(Buffer.from([255, 218]));
  const strip = base.subarray(0, end + 2), cases = [strip.subarray(0, -2), Buffer.concat([strip.subarray(0, end - 1), strip.subarray(end)]),
    Buffer.concat([strip.subarray(0, end), Buffer.from([0]), strip.subarray(end)])];
  const padding = Buffer.from(strip); padding[end - 1] &= 254; cases.push(padding);
  const huge = Buffer.from(strip); huge.writeUInt16BE(65535, frame + 7); cases.push(huge);
  const precision = Buffer.from(strip); precision[frame + 4] = 12; cases.push(precision);
  const sampling = Buffer.from(strip); sampling[frame + 11] = 0x22; cases.push(sampling);
  const ac = Buffer.from(strip); ac[huff + 4] = 0x10; cases.push(ac);
  const oversubscribed = Buffer.from(strip); oversubscribed[huff + 5] = 2; oversubscribed[huff + 9] = 15; cases.push(oversubscribed);
  const symbol = Buffer.from(strip); symbol[huff + 21] = 17; cases.push(symbol);
  const unknown = Buffer.from(strip); unknown[scan + 5] = 99; cases.push(unknown);
  const restart = Buffer.concat([strip.subarray(0, scan), Buffer.from([255, 221, 0, 4, 0, 1]), strip.subarray(scan)]); cases.push(restart);
  for (const [index, bytes] of cases.entries()) {
    const source = encapsulatedDicom(fixture({ uid: '1.2.840.10008.1.2.4.70' }), evenJpeg(bytes)), output = path.join(directory, `missing-${index}.png`); await writeFile(input, source);
    await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_JPEG_UNSUPPORTED' });
    await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code: 'DICOM_JPEG_UNSUPPORTED' });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  const mode = encapsulatedDicom(fixture({ uid: '1.2.840.10008.1.2.4.70' }), losslessJpeg([0, 1, 2, 3], { predictor: 2 }));
  await writeFile(input, mode); await assert.rejects(inspectDicom({ input_path: input }), { code: 'DICOM_JPEG_UNSUPPORTED' });
});

test('independent JPEG predictor verification refuses a source-decoder low-precision wrap discrepancy before any PNG is written', async t => {
  const directory = await workspace(t), input = path.join(directory, 'wrapped.dcm'), output = path.join(directory, 'refused.png'), values = [0, 4095, 0, 0],
    source = encapsulatedDicom(fixture({ uid: '1.2.840.10008.1.2.4.57', bits: 16, stored: 12, pixels: values }), losslessJpeg(values, { precision: 12, predictor: 7 }));
  await writeFile(input, source); await assert.rejects(renderDicom({ input_path: input, output_path: output }), { code: 'VERIFICATION_FAILED' });
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(digest(await readFile(input)), digest(source));
});
