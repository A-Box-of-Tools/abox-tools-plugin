import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { findBrowser } from '../src/browser.mjs';
import { scanDocument } from '../src/document-scan.mjs';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';

const browser = await findBrowser(), browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pageConfig = (width = 128, height = 96) => ({ image_width: width, image_height: height,
  corners: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }] });
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-scan-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function fixture(kind = 'gradient') {
  const width = 128, height = 96, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color;
    if (kind === 'gradient') color = [x, y, 40, 255];
    else if (kind === 'alpha') color = [0, 0, 0, 0];
    else {
      const ink = x >= (kind === 'left' ? 20 : 80) && x < (kind === 'left' ? 50 : 110) && y >= 20 && y < 65;
      color = ink ? [0, 0, 0, 255] : [190 + Math.floor(x / 4), 190 + Math.floor(x / 4), 190 + Math.floor(x / 4), 255];
    }
    rows.set(color, y * (width * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('private-note\0private document metadata')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function readPng(bytes) {
  const parts = [], types = []; let width, height, channels;
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, at + 8 + size);
    types.push(type);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : null; assert.ok(channels); assert.equal(data[12], 0); }
    if (type === 'IDAT') parts.push(data); at += 12 + size;
  }
  const stride = width * channels, raw = inflateSync(Buffer.concat(parts), { maxOutputLength: height * (stride + 1) }), rows = Buffer.alloc(stride * height), pixels = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0, above = y ? rows[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const add = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, corner);
      rows[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * channels; pixels.set([rows[at], rows[at + 1], rows[at + 2], channels === 4 ? rows[at + 3] : 255], (y * width + x) * 4);
    }
  }
  return { width, height, pixels, types };
}
async function setup(directory, bytes, chosen = pageConfig()) {
  const input = path.join(directory, 'source.png'), config = path.join(directory, 'corners.json');
  await writeFile(input, bytes); await writeFile(config, JSON.stringify({ pages: [chosen] })); return { input, config };
}

test('photo scan PNG follows independently derived inset geometry and drops source metadata without changing inputs', browserOptions, async t => {
  const directory = await workspace(t), source = fixture(), { input, config } = await setup(directory, source), output = path.join(directory, 'scan.png');
  const originalConfig = await readFile(config), result = await scanDocument({ input_paths: [input], config_path: config, output_path: output, format: 'png', mode: 'photo' });
  const bytes = await readFile(output), checked = readPng(bytes);
  assert.equal(checked.width, 128); assert.equal(checked.height, 96);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    const at = (y * 128 + x) * 4;
    // The source rectangle is inset by three pixels, then sampled at output
    // pixel centers; source pixels are centered half a pixel inside its edges.
    const wanted = new Uint8ClampedArray([3 + (x + 0.5) * 122 / 128 - 0.5, 3 + (y + 0.5) * 90 / 96 - 0.5, 40, 255]);
    for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(checked.pixels[at + channel] - wanted[channel]) <= 1);
  }
  assert.equal(result.page_count, 1); assert.equal(result.pages[0].inset_source_pixels, 3);
  assert.equal(result.verification.png_all_pixels, true); assert.equal(result.verified, true);
  assert.ok(!checked.types.includes('tEXt')); assert.ok(!bytes.includes(Buffer.from('private document metadata')));
  assert.ok(!JSON.stringify(result).includes('private document metadata')); assert.ok(!Object.hasOwn(result.pages[0], 'corners'));
  assert.equal(hash(await readFile(input)), hash(source)); assert.deepEqual(await readFile(config), originalConfig);
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: output, format: 'png' }), { code: 'OUTPUT_EXISTS' });
});

test('scan cleanup produces real grayscale and binary PNG pixels, and transparent source pixels flatten onto white', browserOptions, async t => {
  const directory = await workspace(t), source = fixture('left'), { input, config } = await setup(directory, source);
  for (const mode of ['colour', 'grey', 'mono']) {
    const output = path.join(directory, `${mode}.png`);
    await scanDocument({ input_paths: [input], config_path: config, output_path: output, format: 'png', mode });
    const checked = readPng(await readFile(output)); let black = 0, white = 0;
    for (let at = 0; at < checked.pixels.length; at += 4) {
      assert.equal(checked.pixels[at + 3], 255);
      if (mode !== 'colour') assert.equal(checked.pixels[at], checked.pixels[at + 1]);
      if (mode !== 'colour') assert.equal(checked.pixels[at], checked.pixels[at + 2]);
      if (mode === 'mono') { assert.ok([0, 255].includes(checked.pixels[at])); black += checked.pixels[at] === 0; white += checked.pixels[at] === 255; }
    }
    if (mode === 'mono') { assert.ok(black > 50); assert.ok(white > black); }
  }
  await writeFile(input, fixture('alpha'));
  const output = path.join(directory, 'alpha.png');
  await scanDocument({ input_paths: [input], config_path: config, output_path: output, format: 'png', mode: 'photo' });
  const checked = readPng(await readFile(output)); assert.ok(checked.pixels.every(value => value === 255));
});

test('perspective scan accepts explicit nonrectangular corners and refuses a different decoded coordinate frame', browserOptions, async t => {
  const directory = await workspace(t), source = fixture('left');
  const chosen = { ...pageConfig(), corners: [{ x: 10, y: 10 }, { x: 118, y: 5 }, { x: 120, y: 86 }, { x: 5, y: 90 }] };
  const { input, config } = await setup(directory, source, chosen), output = path.join(directory, 'perspective.png');
  const result = await scanDocument({ input_paths: [input], config_path: config, output_path: output, format: 'png', mode: 'photo' });
  const checked = readPng(await readFile(output)); assert.equal(checked.width, result.pages[0].width); assert.equal(checked.height, result.pages[0].height);
  assert.ok(checked.width >= 64); assert.ok(checked.height >= 64); assert.equal(result.verification.png_all_pixels, true);
  await writeFile(config, JSON.stringify({ pages: [pageConfig(129, 96)] }));
  const bad = path.join(directory, 'wrong-frame.png');
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: bad, format: 'png' }), { code: 'SCAN_PROCESSING_FAILED' });
  await assert.rejects(readFile(bad), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
});

test('scanned PDF retains page order, exact monochrome pixels, physical fit and named-page geometry', browserOptions, async t => {
  const directory = await workspace(t), inputs = [path.join(directory, 'left.png'), path.join(directory, 'right.png')], config = path.join(directory, 'pages.json');
  const sources = [fixture('left'), fixture('right')]; for (let at = 0; at < 2; at++) await writeFile(inputs[at], sources[at]);
  await writeFile(config, JSON.stringify({ pages: [pageConfig(), pageConfig()] }));
  const output = path.join(directory, 'scan.pdf'), result = await scanDocument({ input_paths: inputs, config_path: config, output_path: output, mode: 'mono', dpi: 200 });
  const doc = await PdfDocument.open(new Uint8Array(await readFile(output))), pages = readSource(doc, 'scan.pdf').pages;
  assert.equal(pages.length, 2); assert.equal(result.page_count, 2); assert.equal(result.verification.pdf_mono_packed_pixels, true);
  for (const [at, page] of pages.entries()) {
    assert.ok(Math.abs(page.box[2] - 128 * 72 / 200) <= 0.0001); assert.ok(Math.abs(page.box[3] - 96 * 72 / 200) <= 0.0001);
    const image = doc.resolve(doc.get(doc.get(page.dict, 'Resources'), 'XObject').get('Im0'));
    assert.equal(doc.get(image.dict, 'BitsPerComponent'), 1); assert.equal(doc.get(image.dict, 'Filter').value, 'FlateDecode');
    const pixels = inflateSync(image.raw, { maxOutputLength: 128 / 8 * 96 }); let left = 0, right = 0;
    for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) if (!(pixels[y * 16 + (x >> 3)] & (0x80 >> (x & 7)))) { if (x < 64) left++; else right++; }
    assert.ok(at === 0 ? left > right + 50 : right > left + 50);
    assert.equal(hash(await readFile(inputs[at])), hash(sources[at]));
  }
  const color = path.join(directory, 'named.pdf');
  await scanDocument({ input_paths: inputs, config_path: config, output_path: color, mode: 'photo', page_size: 'a4', margin_mm: 10 });
  const namedDoc = await PdfDocument.open(new Uint8Array(await readFile(color))), named = readSource(namedDoc, 'named.pdf').pages;
  for (const page of named) {
    assert.ok(Math.abs(page.box[2] - 297 * 72 / 25.4) <= 0.0001); assert.ok(Math.abs(page.box[3] - 210 * 72 / 25.4) <= 0.0001);
    const image = namedDoc.resolve(namedDoc.get(namedDoc.get(page.dict, 'Resources'), 'XObject').get('Im0'));
    assert.equal(namedDoc.get(image.dict, 'BitsPerComponent'), 8); assert.equal(namedDoc.get(image.dict, 'Filter').value, 'DCTDecode');
    assert.equal(namedDoc.get(image.dict, 'Width'), 128); assert.equal(namedDoc.get(image.dict, 'Height'), 96);
  }
});

test('scan cancellation leaves local source photos, configuration and output location intact', browserOptions, async t => {
  const directory = await workspace(t), bytes = fixture(), { input, config } = await setup(directory, bytes), output = path.join(directory, 'cancelled.pdf');
  const originalConfig = await readFile(config), controller = new AbortController();
  const pending = scanDocument({ input_paths: [input], config_path: config, output_path: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(bytes)); assert.deepEqual(await readFile(config), originalConfig);
});
