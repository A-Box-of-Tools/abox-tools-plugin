import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderDicom } from '../src/dicom.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const digest = value => createHash('sha256').update(value).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-dicom-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const longVr = new Set(['OB', 'OW']);
function element(group, tag, vr, value, explicit, little) {
  let data = Buffer.isBuffer(value) ? value : Buffer.from(value); if (data.length % 2) data = Buffer.concat([data, Buffer.from([['UI', 'OB', 'OW'].includes(vr) ? 0 : 32])]);
  const bytes = Buffer.alloc(explicit && longVr.has(vr) ? 12 : 8);
  little ? bytes.writeUInt16LE(group) : bytes.writeUInt16BE(group); little ? bytes.writeUInt16LE(tag, 2) : bytes.writeUInt16BE(tag, 2);
  if (explicit) {
    bytes.write(vr, 4, 'latin1'); const offset = longVr.has(vr) ? 8 : 6;
    if (longVr.has(vr)) little ? bytes.writeUInt32LE(data.length, offset) : bytes.writeUInt32BE(data.length, offset);
    else little ? bytes.writeUInt16LE(data.length, offset) : bytes.writeUInt16BE(data.length, offset);
  } else little ? bytes.writeUInt32LE(data.length, 4) : bytes.writeUInt32BE(data.length, 4);
  return Buffer.concat([bytes, data]);
}
function fixture({ uid = '1.2.840.10008.1.2.1', width = 2, height = 2, frames = 1, bits = 16, stored = bits, signed = true,
  photo = 'MONOCHROME2', samples = 1, planar = 0, values = [-100, 0, 100, 200], slope = 1, intercept = 0 } = {}) {
  const explicit = uid !== '1.2.840.10008.1.2', little = uid !== '1.2.840.10008.1.2.2';
  const e = (group, tag, vr, value) => element(group, tag, vr, value, explicit, little);
  const us = value => { const data = Buffer.alloc(2); little ? data.writeUInt16LE(value) : data.writeUInt16BE(value); return data; };
  const meta = element(2, 0x10, 'UI', uid, true, true), length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const raw = Buffer.alloc(values.length * bits / 8), mask = (1 << stored) - 1;
  values.forEach((value, at) => { if (bits === 8) raw[at] = value & mask; else little ? raw.writeUInt16LE(value & mask, at * 2) : raw.writeUInt16BE(value & mask, at * 2); });
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', length, true, true), meta,
    e(0x10, 0x10, 'PN', 'PRIVATE^PATIENT'), e(0x28, 0x10, 'US', us(height)), e(0x28, 0x11, 'US', us(width)),
    e(0x28, 2, 'US', us(samples)), e(0x28, 4, 'CS', photo), e(0x28, 8, 'IS', String(frames)), e(0x28, 6, 'US', us(planar)),
    e(0x28, 0x100, 'US', us(bits)), e(0x28, 0x101, 'US', us(stored)), e(0x28, 0x102, 'US', us(stored - 1)),
    e(0x28, 0x103, 'US', us(signed ? 1 : 0)), e(0x28, 0x1053, 'DS', String(slope)), e(0x28, 0x1052, 'DS', String(intercept)),
    e(0x7fe0, 0x10, bits === 8 ? 'OB' : 'OW', raw)]);
}
async function pixels(filename) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: await readFile(filename) });
    return page.evaluate(async () => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]), canvas = document.createElement('canvas');
      try { canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, pixels: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally { bitmap.close(); canvas.width = canvas.height = 0; }
    });
  });
}
const grey = values => values.flatMap(value => [value, value, value, 255]);
function rleFixture(settings) {
  const values = settings.values, bits = settings.bits ?? 16, samples = settings.samples ?? 1, stored = settings.stored ?? bits,
    mask = (1 << stored) - 1, perSample = bits / 8, count = values.length / samples, header = Buffer.alloc(64), segments = [];
  header.writeUInt32LE(samples * perSample); let offset = 64;
  for (let sample = 0; sample < samples; sample++) for (let byte = perSample - 1; byte >= 0; byte--) {
    const plane = Array.from({ length: count }, (_, pixel) => ((values[pixel * samples + sample] & mask) >>> (byte * 8)) & 255);
    let data = plane.every(value => value === plane[0]) ? Buffer.from([257 - count, plane[0]]) : Buffer.from([count - 1, ...plane]);
    if (data.length % 2) data = Buffer.concat([data, Buffer.from([0])]);
    header.writeUInt32LE(offset, 4 + segments.length * 4); offset += data.length; segments.push(data);
  }
  const fragment = Buffer.concat([header, ...segments]), source = fixture({ ...settings, uid: '1.2.840.10008.1.2.5' }),
    start = source.lastIndexOf(Buffer.from([0xe0, 0x7f, 0x10, 0])), pixelHeader = Buffer.alloc(12);
  pixelHeader.writeUInt16LE(0x7fe0); pixelHeader.writeUInt16LE(0x10, 2); pixelHeader.write('OB', 4); pixelHeader.writeUInt32LE(0xffffffff, 8);
  const item = (tag, bytes) => { const out = Buffer.alloc(8); out.writeUInt16LE(0xfffe); out.writeUInt16LE(tag, 2); out.writeUInt32LE(bytes.length, 4); return Buffer.concat([out, bytes]); };
  return Buffer.concat([source.subarray(0, start), pixelHeader, item(0xe000, Buffer.alloc(0)), item(0xe000, fragment), item(0xe0dd, Buffer.alloc(0))]);
}

test('DICOM technical PNG retains signed/endian samples and applies modality then custom linear window and inversion', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm');
  for (const [at, uid] of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'].entries()) {
    const source = fixture({ uid, slope: 2, intercept: -100 }); await writeFile(input, source);
    const output = path.join(directory, `preview-${at}.png`);
    const result = await renderDicom({ input_path: input, output_path: output, window_center: 0, window_width: 401 });
    // Stored -100/0/100/200 become -300/-100/100/300 before the window.
    assert.deepEqual((await pixels(output)).pixels, grey([0, 64, 192, 255]));
    assert.equal(result.verification.native_samples_checked, 4); assert.equal(result.verification.png_pixels_checked, 4);
    assert.equal(result.window_source, 'custom'); assert.equal(result.verified, true); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(digest(await readFile(input)), digest(source));
  }
  await writeFile(input, fixture({ photo: 'MONOCHROME1', bits: 8, signed: false, values: [0, 64, 128, 255] }));
  const inverted = path.join(directory, 'mono1.png'), twice = path.join(directory, 'mono1-inverted.png');
  await renderDicom({ input_path: input, output_path: inverted, window_center: 128, window_width: 256 });
  await renderDicom({ input_path: input, output_path: twice, window_center: 128, window_width: 256, invert: true });
  assert.deepEqual((await pixels(inverted)).pixels, grey([255, 191, 127, 0]));
  assert.deepEqual((await pixels(twice)).pixels, grey([0, 64, 128, 255]));
});

test('DICOM multiframe and planar/interleaved RGB previews retain exact frame positions and color samples', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm');
  await writeFile(input, fixture({ frames: 2, bits: 16, stored: 12, values: [-2048, -1, 0, 2047, 0, 1, 2, 3] }));
  const output = path.join(directory, 'frame2.png'); const result = await renderDicom({ input_path: input, output_path: output, frame: 2 });
  assert.equal(result.selected_frame, 2); assert.equal(result.frame_count, 2); assert.equal(result.window_source, 'full-range');
  assert.deepEqual((await pixels(output)).pixels, grey([0, 128, 255, 255]));
  const colors = [255, 0, 0, 0, 255, 0, 0, 0, 255, 20, 40, 60];
  for (const planar of [0, 1]) {
    const values = planar ? [255, 0, 0, 20, 0, 255, 0, 40, 0, 0, 255, 60] : colors;
    await writeFile(input, fixture({ photo: 'RGB', samples: 3, bits: 8, signed: false, planar, values }));
    const filename = path.join(directory, `rgb-${planar}.png`); const color = await renderDicom({ input_path: input, output_path: filename });
    assert.deepEqual((await pixels(filename)).pixels, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 20, 40, 60, 255]);
    assert.equal(color.verification.native_samples_checked, 12);
    await assert.rejects(renderDicom({ input_path: input, output_path: path.join(directory, 'invalid-window.png'), invert: true }), { code: 'DICOM_WINDOW' });
  }
});

test('DICOM cancellation during preview leaves the output absent and source unchanged', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.dcm'), output = path.join(directory, 'cancelled.png');
  const source = fixture(); await writeFile(input, source); const controller = new AbortController();
  const pending = renderDicom({ input_path: input, output_path: output }, { signal: controller.signal }); const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(digest(await readFile(input)), digest(source));
});

test('strict RLE decoding preserves signed/bit-depth values, literal/repeated byte planes and RGB order before exact PNG verification', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'compressed.dcm');
  const cases = [
    [{ bits: 16, signed: true, values: [-100, 0, 100, 200], slope: 2, intercept: -100 }, { window_center: 0, window_width: 401 }, grey([0, 64, 192, 255])],
    [{ bits: 16, stored: 12, signed: true, values: [-2048, -1, 0, 2047] }, { window_center: 0, window_width: 4096 }, grey([0, 127, 128, 255])],
    [{ bits: 8, signed: false, photo: 'MONOCHROME1', values: [0, 64, 128, 255] }, { window_center: 128, window_width: 256 }, grey([255, 191, 127, 0])],
  ];
  for (const planar of [0, 1]) cases.push([{ bits: 8, signed: false, photo: 'RGB', samples: 3, planar,
    values: [255, 0, 0, 0, 255, 0, 0, 0, 255, 20, 40, 60] }, {}, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 20, 40, 60, 255]]);
  for (const [index, [settings, window, expected]] of cases.entries()) {
    const source = rleFixture(settings), output = path.join(directory, `rle-${index}.png`); await writeFile(input, source);
    const result = await renderDicom({ input_path: input, output_path: output, ...window });
    assert.deepEqual((await pixels(output)).pixels, expected); assert.equal(result.compression, 'rle-lossless');
    assert.equal(result.verified, true); assert.equal(result.verification.compressed_stream, true);
    assert.equal(result.verification.native_samples_checked, 0); assert.equal(result.verification.stored_samples_checked, settings.values.length);
    assert.equal(result.verification.png_pixels_checked, 4); assert.equal(result.decoded_sample_layout, 'interleaved');
    assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(digest(await readFile(input)), digest(source));
  }
});
