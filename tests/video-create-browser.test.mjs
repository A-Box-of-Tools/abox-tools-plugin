import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { imagesToVideo, gifToVideo } from '../src/video-create.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';

const browser = await findBrowser();
const encoder = browser && await withBrowser(page => page.evaluate(async () => {
  if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') return false;
  const { pickH264Codec } = await import('/vendor/abox/shared/js/video-support.js');
  return Boolean(await pickH264Codec({ width: 160, height: 160, framerate: 10, bitrate: 38400 }));
}));
const browserOptions = { skip: !encoder, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-create-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(rgba) {
  const width = 32, height = 32, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(rgba, y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function gif() {
  const width = 33, height = 31;
  const out = [...Buffer.from('GIF89a'), width, 0, height, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255];
  for (const [index, delay] of [1, 2].entries()) {
    const data = []; let bits = 0, count = 0;
    for (const code of [...Array(width * height).fill(index).flatMap(value => [4, value]), 5]) {
      bits |= code << count; count += 3;
      while (count >= 8) { data.push(bits & 255); bits >>= 8; count -= 8; }
    }
    if (count) data.push(bits);
    out.push(0x21, 0xf9, 4, 4, delay, 0, 0, 0, 0x2c, 0, 0, 0, 0, width, 0, height, 0, 0, 2);
    for (let at = 0; at < data.length; at += 255) out.push(Math.min(255, data.length - at), ...data.slice(at, at + 255));
    out.push(0);
  }
  out.push(0x3b); return Buffer.from(out);
}
async function decodeColors(filename) {
  const bytes = await readFile(filename);
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'created.mp4', mimeType: 'video/mp4', buffer: bytes });
    return page.evaluate(async () => {
      const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js');
      const { decoderConfig, micros } = await import('/vendor/abox/shared/js/webcodecs.js');
      const file = document.querySelector('#input').files[0], { video } = await demux(file), frames = [];
      let failed = false;
      const decoder = new VideoDecoder({ output: frame => {
        try {
          const canvas = document.createElement('canvas'); canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
          const context = canvas.getContext('2d'); context.drawImage(frame, 0, 0);
          frames.push({ timestamp: frame.timestamp, color: Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data) });
        } finally { frame.close(); }
      }, error: () => { failed = true; } });
      try {
        decoder.configure(decoderConfig(video));
        for (const sample of video.samples) decoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta',
          timestamp: micros(sample.pts, video.timescale), data: await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer() }));
        await decoder.flush(); if (failed) throw new Error('decode');
        return frames.sort((a, b) => a.timestamp - b.timestamp);
      } finally { decoder.close(); }
    });
  });
}
function near(actual, expected, tolerance = 30) {
  assert.equal(actual[3], 255);
  for (let at = 0; at < 3; at++) assert.ok(Math.abs(actual[at] - expected[at]) <= tolerance, `Channel ${at} differs from the synthetic source color.`);
}

test('slideshow MP4 retains rounded frame counts, source order and native-decoded synthetic colors', browserOptions, async t => {
  const directory = await workspace(t), one = path.join(directory, 'one.png'), two = path.join(directory, 'two.png'), output = path.join(directory, 'created.mp4');
  const red = png([255, 0, 0, 255]), blue = png([0, 0, 255, 255]); await writeFile(one, red); await writeFile(two, blue);
  const result = await imagesToVideo({ input_paths: [one, two], output_path: output, width: 160, height: 160, fps: 10,
    durations_ms: [200, 300], quality: 'high' });
  assert.equal(result.frame_count, 5); assert.equal(result.duration_seconds, 0.5); assert.equal(result.image_count, 2);
  assert.equal(result.verification.decoded_frames, 5); assert.equal(result.width, 160); assert.equal(result.height, 160);
  assert.equal(result.verified, true); assert.ok(result.verification.encoded_chunk_bytes > 0);
  const bytes = await readFile(output), media = await demux(new File([bytes], 'created.mp4'));
  assert.equal(media.audio, null); assert.equal(media.video.samples.length, 5);
  assert.deepEqual(media.video.samples.map(sample => sample.dts), [0, 9000, 18000, 27000, 36000]);
  const decoded = await decodeColors(output); assert.equal(decoded.length, 5);
  for (const [index, frame] of decoded.entries()) near(frame.color, index < 2 ? [255, 0, 0] : [0, 0, 255]);
  assert.equal(hash(await readFile(one)), hash(red)); assert.equal(hash(await readFile(two)), hash(blue));
  await assert.rejects(imagesToVideo({ input_paths: [one, two], output_path: output }), { code: 'OUTPUT_EXISTS' });
});

test('GIF conversion preserves one playback cycle, variable clamped delays, padding and decoded colors', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.gif'), output = path.join(directory, 'created.mp4');
  const source = gif(); await writeFile(input, source);
  const result = await gifToVideo({ input_path: input, output_path: output });
  assert.equal(result.frame_count, 2); assert.equal(result.gif_frames, 2); assert.equal(result.loop_cycles, 1);
  assert.equal(result.width, 34); assert.equal(result.height, 32); assert.equal(result.duration_seconds, 0.12);
  assert.equal(result.verification.decoded_frames, 2);
  const bytes = await readFile(output), media = await demux(new File([bytes], 'created.mp4'));
  assert.equal(media.video.duration, 10800); assert.deepEqual(media.video.samples.map(sample => sample.dts), [0, 9000]);
  const decoded = await decodeColors(output); near(decoded[0].color, [255, 0, 0]); near(decoded[1].color, [0, 0, 255]);
  assert.equal(hash(await readFile(input)), hash(source));
});

test('created-video cancellation leaves new output absent', { skip: !browser, timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), output = path.join(directory, 'cancelled.mp4');
  await writeFile(input, png([255, 0, 0, 255]));
  const controller = new AbortController(), pending = imagesToVideo({ input_paths: [input], output_path: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
