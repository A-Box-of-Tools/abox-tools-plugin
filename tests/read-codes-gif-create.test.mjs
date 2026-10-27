import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { readCodeImage, createGif, MAX_CODE_READ_INPUT_BYTES, MAX_GIF_CREATE_FRAMES } from '../src/read-codes-gif-create.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-read-create-bounds-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png({ width = 1, height = 1, animated = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', animation)] : []), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('code reading validates local paths, result extension, stillness, dimensions, bytes and cancellation before scanning', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), output = path.join(directory, 'code.json');
  const args = { input_path: input, output_path: output };
  for (const thorough of ['true', null, 1]) await assert.rejects(readCodeImage({ ...args, thorough }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(readCodeImage({ ...args, output_path: path.join(directory, 'code.txt') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(readCodeImage({ ...args, input_path: 'https://example.invalid/private' }), { code: 'LOCAL_PATH_REQUIRED' });
  for (const [bytes, code] of [[png({ animated: true }), 'ANIMATED_IMAGE'],
    [png({ width: 4000, height: 1001 }), 'IMAGE_DIMENSIONS'], [png({ width: 4097 }), 'IMAGE_DIMENSIONS']]) {
    await writeFile(input, bytes); await assert.rejects(readCodeImage(args), { code });
  }
  const oversized = await open(input, 'w'); await oversized.truncate(MAX_CODE_READ_INPUT_BYTES + 1); await oversized.close();
  await assert.rejects(readCodeImage(args), { code: 'INPUT_SIZE' });
  await assert.rejects(readCodeImage(args, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(output, 'keep'); await assert.rejects(readCodeImage(args), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep');
});

test('GIF creation refuses unsupported settings, dropped delays, invalid geometry and irrelevant loop fields', async t => {
  const directory = await workspace(t), input = path.join(directory, 'missing.png'), output = path.join(directory, 'animation.gif');
  const args = { input_paths: [input], output_path: output };
  for (const extra of [{ input_paths: [] }, { input_paths: Array(MAX_GIF_CREATE_FRAMES + 1).fill(input) },
    { delay_ms: 19 }, { delay_ms: 60001 }, { delay_ms: 20.5 }, { delay_ms: null }, { max_side: 15 }, { max_side: 1001 },
    { width: 100 }, { height: 100 }, { width: 100, height: 100, max_side: 480 }, { width: 0, height: 100 },
    { delays_ms: [] }, { delays_ms: [500, 500] }, { delays_ms: [null] }, { delays_ms: [NaN] },
    { colors: 3 }, { colors: 257 }, { dither: 1 }, { shared_palette: null }, { transparent: 'true' },
    { fit: 'pad' }, { background: 'url(file:///private)' }, { loop: 'private' }, { loop: 'count' },
    { loop: 'count', loop_count: 0 }, { loop: 'count', loop_count: 65536 }, { loop: 'once', loop_count: 1 }, { loop_count: 1 }]) {
    await assert.rejects(createGif({ ...args, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(createGif({ ...args, input_paths: Array(17).fill(input), width: 1000, height: 1000 }), { code: 'GIF_PIXEL_LIMIT' });
  await assert.rejects(createGif({ ...args, output_path: path.join(directory, 'animation.png') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(createGif({ ...args, input_paths: ['https://example.invalid/private'] }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(createGif(args, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('GIF input admission rejects animation, oversized declarations and aggregate bytes without a browser', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), output = path.join(directory, 'animation.gif');
  const args = { input_paths: [input], output_path: output };
  for (const [bytes, code] of [[png({ animated: true }), 'ANIMATED_IMAGE'],
    [png({ width: 4097 }), 'IMAGE_DIMENSIONS'], [png({ width: 2001, height: 2000 }), 'IMAGE_DIMENSIONS']]) {
    await writeFile(input, bytes); await assert.rejects(createGif(args), { code });
  }
  const large = [];
  for (const name of ['a', 'b']) {
    const filename = path.join(directory, `${name}.png`), file = await open(filename, 'w');
    await file.truncate(65 * 1024 * 1024); await file.close(); large.push(filename);
  }
  await assert.rejects(createGif({ ...args, input_paths: large }), { code: 'INPUT_SIZE' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(output, 'keep'); await assert.rejects(createGif(args), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep');
});
