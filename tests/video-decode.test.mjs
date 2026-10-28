import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compressVideo, cropVideo, grabVideoFrame, reverseVideo, timelapseVideo, videoToGif, bakeVideoRotation } from '../src/video-decode.mjs';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { MAX_VIDEO_INPUT_BYTES } from '../src/video-copy.mjs';

async function workspace(t) { const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-decode-'))); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function unsupportedFixture(directory) {
  const writer = new Mp4Writer(), video = writer.addTrack({ kind: 'vide', timescale: 1000, width: 16 << 16, height: 16 << 16,
    sampleEntry: avcSampleEntry(16, 16, Uint8Array.from([1, 66, 0, 30, 255])) });
  video.addSample({ data: Uint8Array.from([0, 0, 0, 1, 0x65]), dts: 0, pts: 0, duration: 1000, isKey: true });
  const input = path.join(directory, 'incomplete AVC.mp4'), bytes = Buffer.from(await writer.finalize().arrayBuffer()); await writeFile(input, bytes); return { input, bytes };
}
test('decoded-video options, exclusive outputs and extensions fail before native processing', async t => {
  const directory = await workspace(t), { input, bytes } = await unsupportedFixture(directory), output = path.join(directory, 'new.mp4');
  for (const extra of [{ target_bytes: 1 }, { target_bytes: null }, { target_bytes: 100000, max_side: 0 }, { target_bytes: 100000, keep_audio: null }]) {
    await assert.rejects(compressVideo({ input_path: input, output_path: output, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const time_seconds of [null, -1, Infinity, 61]) await assert.rejects(grabVideoFrame({ input_path: input, output_path: path.join(directory, 'frame.png'), time_seconds }), { code: 'INVALID_ARGUMENTS' });
  for (const [operation, extra] of [[reverseVideo, { keep_audio: null }], [timelapseVideo, { speed: 1 }], [timelapseVideo, { fps: 60 }], [videoToGif, { fps: null }], [videoToGif, { loop: null }], [bakeVideoRotation, { degrees: 45 }]]) {
    await assert.rejects(operation({ input_path: input, output_path: output, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(compressVideo({ input_path: input, output_path: path.join(directory, 'wrong.mov'), target_bytes: 100000 }), { code: 'OUTPUT_EXTENSION' });
  await writeFile(output, 'existing'); await assert.rejects(compressVideo({ input_path: input, output_path: output, target_bytes: 100000 }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'existing'); assert.deepEqual(await readFile(input), bytes);
});
test('crop configuration is flat, exact, private, bounded and never silently clips regions', async t => {
  const directory = await workspace(t), { input } = await unsupportedFixture(directory), config = path.join(directory, 'crop.json');
  const good = { image_width: 16, image_height: 16, x: 0, y: 0, width: 16, height: 16 };
  const cases = [JSON.stringify({ ...good, width: 15 }), JSON.stringify({ ...good, x: -1 }), JSON.stringify({ ...good, private: 'PRIVATE' }),
    '{"image_width":16,"image_height":16,"x":0,"x":1,"y":0,"width":16,"height":16}', '['.repeat(300) + '0' + ']'.repeat(300)];
  for (const [at, text] of cases.entries()) {
    const output = path.join(directory, `crop-${at}.mp4`); await writeFile(config, text);
    await assert.rejects(cropVideo({ input_path: input, output_path: output, crop_path: config }), error => { assert.equal(error.code, 'VIDEO_CROP_CONFIG'); assert.ok(!String(error).includes('PRIVATE')); return true; });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});
test('incomplete SPS/PPS is refused before the browser, while size and cancellation preserve all sources', async t => {
  const directory = await workspace(t), { input, bytes } = await unsupportedFixture(directory), output = path.join(directory, 'none.mp4');
  await assert.rejects(compressVideo({ input_path: input, output_path: output, target_bytes: 100000 }), { code: 'AVC_UNSUPPORTED' });
  await assert.rejects(grabVideoFrame({ input_path: input, output_path: path.join(directory, 'none.png') }), { code: 'AVC_UNSUPPORTED' });
  for (const operation of [compressVideo, cropVideo, grabVideoFrame]) await assert.rejects(operation({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const large = path.join(directory, 'huge.mp4'), handle = await open(large, 'w'); await handle.truncate(MAX_VIDEO_INPUT_BYTES + 1); await handle.close();
  await assert.rejects(compressVideo({ input_path: large, output_path: output, target_bytes: 100000 }), { code: 'INPUT_SIZE' });
  const controller = new AbortController(), pending = compressVideo({ input_path: input, output_path: output, target_bytes: 100000 }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5); try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), bytes);
});
