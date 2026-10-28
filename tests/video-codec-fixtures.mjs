import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { imagesToVideo } from '../src/video-create.mjs';

export const VIDEO_FIXTURE = new URL('./fixtures/video-synthetic.mp4', import.meta.url);
export const VIDEO_FIXTURE_FACTS = Object.freeze({ width: 160, height: 96, frames: 5, fps: 10, duration_seconds: 0.5,
  description: 'Original synthetic test media: two vertical solid-color halves, red/green then blue/yellow. No people, voices, metadata or external media.' });
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function picture(left, right) {
  const { width, height } = VIDEO_FIXTURE_FACTS, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([...(x < width / 2 ? left : right), 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export async function writeVideoFixture(output = fileURLToPath(VIDEO_FIXTURE)) {
  assert.ok(path.isAbsolute(output)); const parent = await realpath(tmpdir()), directory = await realpath(await mkdtemp(path.join(parent, 'abox-synthetic-video-')));
  try {
    const first = path.join(directory, 'first.png'), last = path.join(directory, 'last.png'), encoded = path.join(directory, 'encoded.mp4');
    await writeFile(first, picture([255, 0, 0], [0, 255, 0])); await writeFile(last, picture([0, 0, 255], [255, 255, 0]));
    await imagesToVideo({ input_paths: [first, last], output_path: encoded, width: 160, height: 96, fps: 10, durations_ms: [200, 300], quality: 'high' });
    const bytes = await readFile(encoded); assert.ok(bytes.length < 128 * 1024, 'The permanent color fixture must remain small.');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, bytes, { flag: 'wx' });
    return { path: output, bytes: bytes.length, ...VIDEO_FIXTURE_FACTS };
  } finally {
    const canonical = await realpath(directory); assert.equal(path.dirname(canonical), parent); assert.ok(path.basename(canonical).startsWith('abox-synthetic-video-'));
    await rm(canonical, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--write', 'Usage: node tests/video-codec-fixtures.mjs --write [absolute-output.mp4]');
  assert.ok(process.argv.length <= 4); const result = await writeVideoFixture(process.argv[3]); console.log(JSON.stringify(result));
}
