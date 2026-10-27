import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractGifFrames } from '../src/gif.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const hash = data => createHash('sha256').update(data).digest('hex');
const palette = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]];
const u16 = value => [value & 255, value >> 8];
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-gif-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

function literalData(indices) {
  const out = []; let bits = 0, used = 0;
  for (const code of [...indices.flatMap(index => [4, index]), 5]) {
    bits |= code << used; used += 3;
    while (used >= 8) { out.push(bits & 255); bits >>= 8; used -= 8; }
  }
  if (used) out.push(bits); return out;
}
function fixture(width, height, frames) {
  const out = [...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0x81, 0, 0, ...palette.flatMap(color => color.slice(0, 3)),
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0];
  for (const frame of frames) {
    const transparent = frame.transparent ?? -1, data = frame.data ?? literalData(frame.indices);
    out.push(0x21, 0xf9, 4, (frame.disposal ?? 1) << 2 | (transparent >= 0 ? 1 : 0), ...u16(frame.delay ?? 1), Math.max(0, transparent), 0,
      0x2c, ...u16(frame.x ?? 0), ...u16(frame.y ?? 0), ...u16(frame.width), ...u16(frame.height),
      (frame.interlaced ? 0x40 : 0) | (frame.palette ? 0x81 : 0));
    if (frame.palette) out.push(...frame.palette);
    out.push(2);
    for (let at = 0; at < data.length; at += 255) out.push(Math.min(255, data.length - at), ...data.slice(at, at + 255));
    out.push(0);
  }
  out.push(0x3b); return Buffer.from(out);
}

const animation = () => fixture(3, 2, [
  { width: 3, height: 2, indices: [0, 0, 0, 0, 0, 0], delay: 1 },
  { x: 1, width: 1, height: 2, indices: [1, 1], disposal: 2, delay: 2 },
  { x: 2, width: 1, height: 1, indices: [2], disposal: 3, delay: 5 },
  { y: 1, width: 1, height: 1, indices: [1], delay: 3 },
  { width: 3, height: 1, indices: [3, 2, 3], transparent: 3 },
]);

async function decodedPngs(outputs) {
  return withBrowser(async page => {
    const result = [];
    for (const output of outputs) {
      await page.locator('#input').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: await readFile(output.output_path) });
      result.push(await page.evaluate(async () => {
        const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
        const canvas = document.createElement('canvas');
        try {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
          return { width: bitmap.width, height: bitmap.height, pixels: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
        } finally { bitmap.close(); canvas.width = canvas.height = 0; }
      }));
    }
    return result;
  });
}

test('GIF composited PNGs retain exact disposal, transparency, frame order and timing', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.gif'), output = path.join(directory, 'frames');
  const source = animation(); await writeFile(input, source);
  const result = await extractGifFrames({ input_path: input, output_dir: output });
  assert.equal(result.output_count, 5); assert.equal(result.verification.decoded_frames, 5); assert.equal(result.verification.png_pixels, 30);
  assert.equal(result.mode, 'composited'); assert.equal(result.verified, true);
  const images = await decodedPngs(result.outputs), expected = [
    [0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 1, 0], [0, 3, 2, 0, 3, 0], [0, 3, 0, 1, 3, 0], [0, 2, 0, 1, 3, 0],
  ];
  for (const [at, image] of images.entries()) {
    assert.equal(image.width, 3); assert.equal(image.height, 2); assert.deepEqual(image.pixels, expected[at].flatMap(index => palette[index]));
    assert.equal(path.basename(result.outputs[at].output_path), `frame-0${at + 1}.png`);
  }
  const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8'));
  assert.equal(manifest.loop_count, 0); assert.deepEqual(manifest.outputs.map(frame => frame.delay_cs), [1, 2, 5, 3, 1]);
  assert.deepEqual(manifest.outputs.map(frame => frame.played_delay_seconds), [0.1, 0.02, 0.05, 0.03, 0.1]);
  assert.equal(hash(await readFile(input)), hash(source));
});

test('GIF stored PNGs preserve patch sizes, local palettes, interlacing and requested original frame numbers', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.gif'); const source = animation(); await writeFile(input, source);
  const stored = await extractGifFrames({ input_path: input, output_dir: path.join(directory, 'stored'), mode: 'stored', frames: [5, 2] });
  assert.deepEqual(stored.outputs.map(frame => frame.frame_index), [2, 5]);
  const images = await decodedPngs(stored.outputs);
  assert.deepEqual(images[0], { width: 1, height: 2, pixels: [1, 1].flatMap(index => palette[index]) });
  assert.deepEqual(images[1], { width: 3, height: 1, pixels: [3, 2, 3].flatMap(index => palette[index]) });
  const selected = await extractGifFrames({ input_path: input, output_dir: path.join(directory, 'selected'), frames: [5, 4, 2] });
  const shown = await decodedPngs(selected.outputs);
  assert.deepEqual(shown[1].pixels, [0, 3, 0, 1, 3, 0].flatMap(index => palette[index]));
  assert.deepEqual(shown[2].pixels, [0, 2, 0, 1, 3, 0].flatMap(index => palette[index]));
  const rowColors = [0, 1, 2, 0, 1, 2, 0, 1], order = [0, 4, 2, 6, 1, 3, 5, 7];
  const local = [255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255];
  await writeFile(input, fixture(1, 8, [{ width: 1, height: 8, indices: order.map(row => rowColors[row]), interlaced: true, palette: local }]));
  const interlaced = await extractGifFrames({ input_path: input, output_dir: path.join(directory, 'interlaced'), mode: 'stored' });
  const [decoded] = await decodedPngs(interlaced.outputs);
  assert.deepEqual(decoded.pixels, rowColors.flatMap(index => local.slice(index * 3, index * 3 + 3).concat(255)));
});

test('GIF partial streams fail without outputs and cancellation removes only newly written PNGs', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.gif');
  await writeFile(input, fixture(2, 2, [{ width: 2, height: 2, indices: [], data: [0] }]));
  const bad = path.join(directory, 'bad');
  await assert.rejects(extractGifFrames({ input_path: input, output_dir: bad }), { code: 'INVALID_GIF_PIXELS' });
  await assert.rejects(stat(bad), { code: 'ENOENT' });
  const source = fixture(64, 64, Array.from({ length: 120 }, (_, at) => ({ width: 64, height: 64, indices: Array(4096).fill(at % 3) })));
  await writeFile(input, source); const output = path.join(directory, 'cancelled'), controller = new AbortController();
  let done = false;
  const pending = extractGifFrames({ input_path: input, output_dir: output }, { signal: controller.signal });
  const settled = pending.then(() => ({ ok: true }), error => ({ error })).finally(() => { done = true; });
  let sawOutput = false;
  while (!done) {
    try { await stat(path.join(output, 'frame-001.png')); sawOutput = true; controller.abort(); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const result = await settled; assert.equal(sawOutput, true); assert.equal(result.error?.name, 'AbortError');
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
});
