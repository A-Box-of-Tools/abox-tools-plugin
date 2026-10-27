import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { imagesToVideo, gifToVideo, MAX_VIDEO_CREATE_GIF_BYTES } from '../src/video-create.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-create-bounds-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(width = 1, height = 1, animated = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(animated ? [chunk('acTL', animation)] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function gif({ width = 1, delay = 10, data = [0x44, 0x01] } = {}) {
  return Buffer.from([...Buffer.from('GIF89a'), width & 255, width >> 8, 1, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255,
    0x21, 0xf9, 4, 4, delay & 255, delay >> 8, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, data.length, ...data, 0, 0x3b]);
}

test('slideshow settings enforce exact image cardinality, even geometry, rounded timeline and supported options', async t => {
  const directory = await workspace(t), input = path.join(directory, 'missing.png'), output = path.join(directory, 'created.mp4');
  const args = { input_paths: [input], output_path: output };
  for (const extra of [{ input_paths: [] }, { input_paths: Array(33).fill(input) }, { width: 17 }, { height: 0 },
    { width: 1920, height: 1920 }, { fps: 60 }, { fps: null }, { duration_ms: 19 }, { duration_ms: 60001 },
    { durations_ms: [] }, { durations_ms: [1000, 1000] }, { durations_ms: [1.5] }, { durations_ms: null },
    { quality: 'maximum' }, { fit: 'pad' }, { background: 'url(file:///private)' }]) {
    await assert.rejects(imagesToVideo({ ...args, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(imagesToVideo({ ...args, input_paths: [input, input], duration_ms: 60000 }), { code: 'VIDEO_TIMELINE_LIMIT' });
  await assert.rejects(imagesToVideo({ ...args, input_paths: ['https://example.invalid/private'] }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(imagesToVideo({ ...args, output_path: path.join(directory, 'wrong.webm') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(imagesToVideo(args, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('slideshow admission refuses animations, large declarations and aggregate bytes before native codecs', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.png'), output = path.join(directory, 'created.mp4');
  for (const [bytes, code] of [[png(1, 1, true), 'ANIMATED_IMAGE'], [png(4097, 1), 'IMAGE_DIMENSIONS'], [png(2001, 2000), 'IMAGE_DIMENSIONS']]) {
    await writeFile(input, bytes); await assert.rejects(imagesToVideo({ input_paths: [input], output_path: output }), { code });
  }
  const paths = [];
  for (const name of ['one', 'two']) {
    const filename = path.join(directory, `${name}.png`), file = await open(filename, 'w');
    await file.truncate(65 * 1024 * 1024); await file.close(); paths.push(filename);
  }
  await assert.rejects(imagesToVideo({ input_paths: paths, output_path: output }), { code: 'INPUT_SIZE' });
  await writeFile(output, 'keep');
  await assert.rejects(imagesToVideo({ input_paths: [input], output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep');
});

test('GIF conversion admits geometry/timing before strict EOI decoding and never creates partial output', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.gif'), output = path.join(directory, 'created.mp4');
  for (const extra of [{ background: null }, { background: '#fff' }, { bitrate: 399999 }, { bitrate: 20000001 }, { bitrate: null }]) {
    await assert.rejects(gifToVideo({ input_path: input, output_path: output, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await writeFile(input, gif({ width: 1921, data: [0x04] }));
  await assert.rejects(gifToVideo({ input_path: input, output_path: output }), { code: 'GIF_VIDEO_LIMIT' });
  await writeFile(input, gif({ delay: 6001 }));
  await assert.rejects(gifToVideo({ input_path: input, output_path: output }), { code: 'VIDEO_TIMELINE_LIMIT' });
  await writeFile(input, gif({ data: [0x04] }));
  await assert.rejects(gifToVideo({ input_path: input, output_path: output }), { code: 'INVALID_GIF_PIXELS' });
  const file = await open(input, 'w'); await file.truncate(MAX_VIDEO_CREATE_GIF_BYTES + 1); await file.close();
  await assert.rejects(gifToVideo({ input_path: input, output_path: output }), { code: 'INPUT_SIZE' });
  await assert.rejects(gifToVideo({ input_path: input, output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
