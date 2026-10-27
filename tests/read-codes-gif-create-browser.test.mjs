import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { readCodeImage, createGif } from '../src/read-codes-gif-create.mjs';
import { convertImage } from '../src/image.mjs';
import { findBrowser } from '../src/browser.mjs';
import { makeQr } from '../vendor/abox/shared/js/qr.js';
import { makeBarcode } from '../vendor/abox/tools/qr-barcode/src/barcode.js';
import { decodeGif } from '../vendor/abox/shared/js/gif-decode.js';
import { GifCanvas } from '../vendor/abox/shared/js/gif-compose.js';
import { parseGif, frameData } from '../vendor/abox/tools/gif-analyzer/src/gif.js';
import { lzwDecode } from '../vendor/abox/tools/gif-analyzer/src/lzw.js';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-read-create-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(width, height, pixel) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    rows.set(typeof pixel === 'function' ? pixel(x, y) : pixel, y * (1 + width * 4) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function qrPng(text, { rotated = false, inverted = false, transparent = false } = {}) {
  const code = makeQr(text, { level: 'M' }, key => key), scale = 5, quiet = 4, side = (code.size + quiet * 2) * scale;
  return png(side, side, (x, y) => {
    let column = Math.floor(x / scale) - quiet, row = Math.floor(y / scale) - quiet;
    if (rotated) [column, row] = [row, code.size - 1 - column];
    const dark = row >= 0 && column >= 0 && row < code.size && column < code.size && code.modules[row * code.size + column] === 1;
    const black = inverted ? !dark : dark;
    return black ? [0, 0, 0, 255] : [255, 255, 255, transparent ? 0 : 255];
  });
}

test('reader saves exact private QR text only in JSON, handles rotation/inversion/alpha, and preserves inputs', browserOptions, async t => {
  const directory = await workspace(t), text = 'WIFI:T:WPA;S:private-network;P:private-secret-token;;\n';
  for (const [index, settings] of [{}, { rotated: true }, { inverted: true }, { transparent: true }].entries()) {
    const input = path.join(directory, `code-${index}.png`), output = path.join(directory, `read-${index}.json`), bytes = qrPng(text, settings);
    await writeFile(input, bytes);
    const result = await readCodeImage({ input_path: input, output_path: output });
    const decoded = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(decoded.code.text, text); assert.equal(decoded.code.symbology, 'qr'); assert.equal(decoded.found, true);
    assert.equal(result.found, true); assert.equal(result.code_count, 1); assert.equal(result.verified, true);
    assert.equal(result.verification.sampled_qr_modules, true); assert.equal(result.verification.external_requests, false);
    for (const value of [text, 'private-network', 'private-secret-token', hash(Buffer.from(text))]) assert.ok(!JSON.stringify(result).includes(value));
    assert.equal(hash(await readFile(input)), hash(bytes));
    await assert.rejects(readCodeImage({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  }
});

test('reader obtains linear barcode values from actual stripes and writes a no-result report for blank images', browserOptions, async t => {
  const directory = await workspace(t);
  for (const [symbology, text] of [['code128', 'private-token-123'], ['ean13', '5901234123457'], ['code39', 'PRIVATE-42'], ['itf', '123456']]) {
    const code = makeBarcode(text, { symbology, code39Check: false }, key => key), scale = 3;
    const input = path.join(directory, `${symbology}.png`), output = path.join(directory, `${symbology}.json`);
    const bytes = png(code.modules.length * scale, 80, x => code.modules[Math.floor(x / scale)] ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    await writeFile(input, bytes);
    const result = await readCodeImage({ input_path: input, output_path: output });
    const decoded = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(decoded.code.text, text); assert.equal(decoded.code.symbology, symbology); assert.equal(result.symbology, symbology);
    assert.ok(!JSON.stringify(result).includes(text));
  }
  const blank = path.join(directory, 'blank.png'), output = path.join(directory, 'blank.json');
  await writeFile(blank, png(32, 24, [255, 255, 255, 255]));
  const result = await readCodeImage({ input_path: blank, output_path: output, thorough: false });
  assert.equal(result.found, false); assert.equal(result.verified, false); assert.equal(result.code_count, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { found: false, image: { width: 32, height: 24 }, code_count: 0, code: null });
});

test('reader accepts native JPEG and WebP with unchanged decoded text', browserOptions, async t => {
  const directory = await workspace(t), original = path.join(directory, 'source.png'), text = 'https://example.invalid/private-token';
  await writeFile(original, qrPng(text));
  for (const format of ['jpeg', 'webp']) {
    const input = path.join(directory, `source.${format}`), output = path.join(directory, `${format}.json`);
    await convertImage({ input_path: original, output_path: input, format, quality: 1 });
    const result = await readCodeImage({ input_path: input, output_path: output });
    assert.equal(JSON.parse(await readFile(output, 'utf8')).code.text, text); assert.equal(result.found, true);
    assert.ok(!JSON.stringify(result).includes('private-token')); assert.ok(!JSON.stringify(result).includes('example.invalid'));
  }
});

async function colorFrames(directory) {
  const input_paths = [];
  for (const [index, color] of [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]].entries()) {
    const filename = path.join(directory, `${index}.png`); await writeFile(filename, png(24, 16, color)); input_paths.push(filename);
  }
  return input_paths;
}
function playback(bytes) {
  const gif = decodeGif(new Uint8Array(bytes)), compositor = new GifCanvas(gif), frames = [];
  for (let frame = 0; frame < gif.frames.length; frame++) frames.push(Uint8ClampedArray.from(compositor.next().pixels));
  return { gif, frames };
}

test('GIF creation preserves input order, exact solid pixels, rounded timing and strict LZW with local/global palettes', browserOptions, async t => {
  const directory = await workspace(t), paths = await colorFrames(directory), input_paths = [paths[2], paths[0], paths[1]];
  const originals = await Promise.all(input_paths.map(filename => readFile(filename)));
  for (const shared_palette of [false, true]) {
    const output = path.join(directory, `${shared_palette}.gif`);
    const result = await createGif({ input_paths, output_path: output, delays_ms: [33, 33, 34], width: 24, height: 16,
      loop: 'count', loop_count: 3, colors: 16, dither: false, shared_palette });
    assert.equal(result.operation, 'create-gif'); assert.equal(result.verified, true); assert.equal(result.frame_count, 3);
    assert.deepEqual(result.delays_cs, [3, 4, 3]); assert.equal(result.duration_seconds, 0.1);
    assert.equal(result.encoded_loop_count, 3); assert.equal(result.verification.palette_pixels, 24 * 16 * 3);
    assert.equal(result.verification.composited_pixels, 24 * 16 * 3); assert.equal(result.verification.lzw_end_codes, true);
    const bytes = await readFile(output), metadata = parseGif(new Uint8Array(bytes)), decoded = playback(bytes);
    assert.equal(metadata.width, 24); assert.equal(metadata.height, 16); assert.equal(metadata.loop, 3);
    assert.equal(Boolean(metadata.globalPalette), shared_palette); assert.equal(decoded.gif.truncated, null);
    for (const [index, color] of [[0, 0, 255, 255], [255, 0, 0, 255], [0, 255, 0, 255]].entries()) {
      for (let at = 0; at < decoded.frames[index].length; at += 4) assert.deepEqual(Array.from(decoded.frames[index].subarray(at, at + 4)), color);
      const data = frameData(new Uint8Array(bytes), metadata.frames[index]), lzw = lzwDecode(data, metadata.frames[index].minCodeSize, 384);
      assert.equal(lzw.complete, true); assert.equal(lzw.overrun, 0); assert.equal(lzw.bytesRead, data.length);
    }
    await assert.rejects(createGif({ input_paths, output_path: output }), { code: 'OUTPUT_EXISTS' });
  }
  for (const [index, filename] of input_paths.entries()) assert.equal(hash(await readFile(filename)), hash(originals[index]));
});

test('GIF transparent frames clear prior content, keep one-bit alpha, and support single-frame automatic sizing', browserOptions, async t => {
  const directory = await workspace(t), one = path.join(directory, 'one.png'), two = path.join(directory, 'two.png');
  await writeFile(one, png(16, 16, (x, y) => x < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  await writeFile(two, png(16, 16, (x, y) => x >= 8 ? [0, 0, 255, 255] : [0, 0, 0, 0]));
  const output = path.join(directory, 'transparent.gif');
  const result = await createGif({ input_paths: [one, two], output_path: output, width: 16, height: 16,
    transparent: true, colors: 16, dither: false, loop: 'once', delay_ms: 120 });
  assert.equal(result.encoded_loop_count, null); assert.deepEqual(result.delays_cs, [12, 12]);
  const decoded = playback(await readFile(output));
  assert.equal(decoded.gif.frames[0].disposal, 2); assert.equal(decoded.gif.frames[1].disposal, 2);
  assert.deepEqual(Array.from(decoded.frames[0].subarray(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(decoded.frames[1].subarray(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(decoded.frames[1].subarray(15 * 4, 15 * 4 + 4)), [0, 0, 255, 255]);
  const single = path.join(directory, 'single.gif');
  const oneResult = await createGif({ input_paths: [one], output_path: single, max_side: 32, dither: true, shared_palette: true });
  assert.equal(oneResult.width, 16); assert.equal(oneResult.height, 16); assert.equal(oneResult.frame_count, 1);
  assert.equal(oneResult.encoded_loop_count, 0); assert.deepEqual(oneResult.delays_cs, [50]);
});

test('GIF contain/cover/stretch and JPEG/WebP sources retain requested dimensions and matte', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'red.png'); await writeFile(input, png(32, 16, [255, 0, 0, 255]));
  for (const fit of ['contain', 'cover', 'stretch']) {
    const output = path.join(directory, `${fit}.gif`);
    await createGif({ input_paths: [input], output_path: output, width: 16, height: 16, fit,
      background: '#ffffff', colors: 16, dither: false });
    const decoded = playback(await readFile(output));
    assert.deepEqual(Array.from(decoded.frames[0].subarray(0, 4)), fit === 'contain' ? [255, 255, 255, 255] : [255, 0, 0, 255]);
    assert.deepEqual(Array.from(decoded.frames[0].subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)), [255, 0, 0, 255]);
  }
  const paths = [];
  for (const format of ['jpeg', 'webp']) {
    const filename = path.join(directory, `source.${format}`); await convertImage({ input_path: input, output_path: filename, format, quality: 1 }); paths.push(filename);
  }
  const result = await createGif({ input_paths: paths, output_path: path.join(directory, 'mixed.gif'), width: 32, height: 16 });
  assert.equal(result.frame_count, 2); assert.equal(result.width, 32); assert.equal(result.height, 16);
});

test('active code-reading and GIF creation cancellation leave new outputs absent', browserOptions, async t => {
  const directory = await workspace(t), [input] = await colorFrames(directory);
  for (const [operation, args] of [[readCodeImage, { input_path: input, output_path: path.join(directory, 'cancelled.json') }],
    [createGif, { input_paths: [input], output_path: path.join(directory, 'cancelled.gif') }]]) {
    const controller = new AbortController(), pending = operation(args, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
    await assert.rejects(readFile(args.output_path), { code: 'ENOENT' });
  }
});
