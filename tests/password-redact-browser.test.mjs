import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { redactImage } from '../src/password-redact.mjs';

const browser = await findBrowser(), browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-redact-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const value of out.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function fixture() {
  const width = 16, height = 12, pixels = Buffer.alloc(width * height * 4), rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgba = x < 8 ? [200, 40, 80, 255] : y < 6 ? [30, 120, 240, 128] : [0, 0, 0, 0];
    pixels.set(rgba, (y * width + x) * 4); rows.set(rgba, y * (width * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return { width, height, pixels, bytes: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('private-key\0private-unredacted-description')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]) };
}

// A separate PNG filter decoder checks actual output pixels without relying on
// the browser or the production redaction/verification routines.
function decodedPng(bytes) {
  const idat = [], types = []; let width, height, channels;
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, at + 8 + size);
    types.push(type);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : null; assert.ok(channels); assert.equal(data[12], 0); }
    if (type === 'IDAT') idat.push(data); at += size + 12;
  }
  const stride = width * channels, raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) });
  assert.equal(raw.length, height * (stride + 1));
  const rows = Buffer.alloc(height * stride), pixels = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const above = y ? rows[(y - 1) * stride + x] : 0, corner = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const value = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, corner);
      rows[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + value) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * channels, to = (y * width + x) * 4;
      pixels.set([rows[from], rows[from + 1], rows[from + 2], channels === 4 ? rows[from + 3] : 255], to);
    }
  }
  return { width, height, pixels, types };
}

test('solid redaction overwrites all requested pixels, retains visible outside pixels, and removes source metadata', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.png'), output = path.join(directory, 'redacted.png'), regions = path.join(directory, 'regions.json');
  const source = fixture(), boxes = [{ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 2, width: 5, height: 4 },
    { x: 8, y: 4, width: 8, height: 8 }];
  const config = JSON.stringify({ image_width: source.width, image_height: source.height, regions: boxes });
  await writeFile(input, source.bytes); await writeFile(regions, config);
  const result = await redactImage({ input_path: input, output_path: output, regions_path: regions });
  const bytes = await readFile(output), decoded = decodedPng(bytes); let covered = 0;
  assert.equal(decoded.width, source.width); assert.equal(decoded.height, source.height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const at = (y * source.width + x) * 4, actual = Array.from(decoded.pixels.subarray(at, at + 4));
    if (boxes.some(box => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height)) {
      assert.deepEqual(actual, [0, 0, 0, 255]); covered++;
    } else {
      const expected = source.pixels.subarray(at, at + 4); assert.equal(actual[3], expected[3]);
      for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actual[channel] * actual[3] / 255 - expected[channel] * expected[3] / 255) <= 1);
    }
  }
  assert.equal(result.region_count, boxes.length); assert.equal(result.redacted_pixels, covered);
  assert.equal(result.verified, true); assert.equal(result.redaction, 'opaque-black-fill'); assert.equal(result.source_metadata_copied, false);
  assert.equal(result.verification.all_pixels_checked, source.width * source.height); assert.equal(result.verification.opaque_regions, true);
  assert.ok(!decoded.types.includes('tEXt')); assert.ok(!bytes.includes(Buffer.from('private-unredacted-description')));
  assert.ok(!JSON.stringify(result).includes('private-unredacted-description')); assert.ok(!Object.hasOwn(result, 'regions'));
  assert.equal(hash(await readFile(input)), hash(source.bytes)); assert.equal(await readFile(regions, 'utf8'), config);
  await assert.rejects(redactImage({ input_path: input, output_path: output, regions_path: regions }), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(output), bytes);
});

test('redaction supports still JPEG and WebP but refuses a coordinate frame with mismatched dimensions', browserOptions, async t => {
  const directory = await workspace(t), source = fixture(), regions = path.join(directory, 'regions.json');
  for (const format of ['jpeg', 'webp']) {
    const bytes = await withBrowser(async page => {
      await page.locator('#input').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: source.bytes });
      return page.evaluate(async mime => {
        const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
        try {
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, 0.92));
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        } finally { bitmap.close(); }
      }, `image/${format}`);
    });
    const input = path.join(directory, `source.${format}`), output = path.join(directory, `${format}.png`);
    await writeFile(input, Buffer.from(bytes));
    await writeFile(regions, JSON.stringify({ image_width: 16, image_height: 12, regions: [{ x: 0, y: 0, width: 16, height: 12 }] }));
    const result = await redactImage({ input_path: input, output_path: output, regions_path: regions });
    const decoded = decodedPng(await readFile(output));
    for (let at = 0; at < decoded.pixels.length; at += 4) assert.deepEqual(Array.from(decoded.pixels.subarray(at, at + 4)), [0, 0, 0, 255]);
    assert.equal(result.redacted_pixels, 192); assert.equal(hash(await readFile(input)), hash(Buffer.from(bytes)));
  }
  const input = path.join(directory, 'source.png'), output = path.join(directory, 'wrong-frame.png'); await writeFile(input, source.bytes);
  await writeFile(regions, JSON.stringify({ image_width: 15, image_height: 12, regions: [{ x: 0, y: 0, width: 1, height: 1 }] }));
  await assert.rejects(redactImage({ input_path: input, output_path: output, regions_path: regions }), { code: 'REDACTION_DIMENSIONS' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('redaction cancellation leaves input, coordinate file and output location intact', browserOptions, async t => {
  const directory = await workspace(t), source = fixture(), input = path.join(directory, 'source.png'), output = path.join(directory, 'cancelled.png'), regions = path.join(directory, 'regions.json');
  const config = JSON.stringify({ image_width: 16, image_height: 12, regions: [{ x: 0, y: 0, width: 1, height: 1 }] });
  await writeFile(input, source.bytes); await writeFile(regions, config);
  const controller = new AbortController(), pending = redactImage({ input_path: input, output_path: output, regions_path: regions }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source.bytes)); assert.equal(await readFile(regions, 'utf8'), config);
});
