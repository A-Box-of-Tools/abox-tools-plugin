import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_FIXTURE } from '../tests/video-codec-fixtures.mjs';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { decodeGif } from '../vendor/abox/shared/js/gif-decode.js';
import { GifCanvas } from '../vendor/abox/shared/js/gif-compose.js';
import { withBrowser } from '../src/browser.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected) => { assert.equal(actual[3], 255); expected.forEach((value, at) => assert.ok(Math.abs(value - actual[at]) <= 35, 'Video processing changed an independently sampled fixture region.')); };
async function visualFacts(files) {
  return withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(await Promise.all(files.map(async item => ({ name: item.name, mimeType: item.image ? 'image/png' : 'video/mp4', buffer: await readFile(item.path) }))));
    return page.evaluate(async expected => {
      const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js'), { decoderConfig, micros } = await import('/vendor/abox/shared/js/webcodecs.js'), results = [];
      const pixels = (source, vertical) => {
        const canvas = document.createElement('canvas'); canvas.width = source.displayWidth ?? source.width; canvas.height = source.displayHeight ?? source.height;
        const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
        const sampled = [0.25, 0.75].map(fraction => Array.from(context.getImageData(vertical ? Math.floor(canvas.width / 2) : Math.floor(canvas.width * fraction), vertical ? Math.floor(canvas.height * fraction) : Math.floor(canvas.height / 2), 1, 1).data));
        canvas.width = canvas.height = 0; return sampled;
      };
      for (const [index, file] of Array.from(document.querySelector('#input').files).entries()) {
        const item = expected[index];
        if (item.image) { const bitmap = await createImageBitmap(file); try { results.push({ name: item.name, points: [pixels(bitmap, false)] }); } finally { bitmap.close(); } continue; }
        const { video } = await demux(file), points = []; let failed = false;
        const decoder = new VideoDecoder({ output: frame => { try { points.push({ time: frame.timestamp, colors: pixels(frame, item.vertical) }); } finally { frame.close(); } }, error: () => { failed = true; } });
        try {
          decoder.configure(decoderConfig(video));
          for (const sample of video.samples) decoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta', timestamp: micros(sample.pts, video.timescale), data: await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer() }));
          await decoder.flush(); if (failed) throw new Error('A generated fixture video failed independent decoding.');
          results.push({ name: item.name, points: points.sort((one, two) => one.time - two.time).map(frame => frame.colors) });
        } finally { if (decoder.state !== 'closed') decoder.close(); }
      }
      return results;
    }, files.map(({ name, image, vertical }) => ({ name, image, vertical })));
  });
}
export async function smokeVideoGaps({ client, workspace }) {
  const input = path.join(workspace, 'original synthetic codec.mp4'), source = await readFile(VIDEO_FIXTURE); await writeFile(input, source);
  const expectedHash = hash(source), tools = [], absent = [], outputs = [], local = name => path.join(workspace, name);
  const run = async (name, args, expectation) => {
    const response = await client.callTool({ name, arguments: args }), text = response.content?.find(block => block.type === 'text'); assert.ok(text);
    const result = JSON.parse(text.text); assert.deepEqual(response.structuredContent, result); tools.push(name);
    if (response.isError) {
      assert.equal(result.ok, false); assert.equal(result.error.code, 'H264_UNAVAILABLE', 'Only explicit native H.264 capability absence may skip a successful video smoke.');
      await assert.rejects(stat(args.output_path), { code: 'ENOENT' }); absent.push({ name, code: result.error.code }); return null;
    }
    assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.verification.avc_all_samples, true);
    assert.deepEqual([result.width, result.height], expectation.size); assert.equal(result.avc_admission.samples_checked, 5);
    assert.ok(!Object.hasOwn(result, 'description')); assert.ok(!Object.hasOwn(result, 'crop'));
    if (expectation.format === 'mp4') {
      const bytes = await readFile(args.output_path), media = await demux(new File([bytes], 'smoke.mp4'));
      assert.equal(media.video.rotation, 0); assert.equal(media.video.samples.length, expectation.frames); assert.equal(media.audio, null);
      assert.equal(result.verification.output_decoded_frames, expectation.frames); assert.equal(result.output_duration_seconds, expectation.duration);
      assert.equal(media.video.duration / media.video.timescale, expectation.duration);
      outputs.push({ name, path: args.output_path, vertical: expectation.vertical });
    } else if (expectation.format === 'png') {
      assert.equal(result.verification.png_all_pixels, true); assert.equal(result.frame_time_seconds, 0.2); outputs.push({ name, path: args.output_path, image: true });
    } else {
      assert.equal(result.verification.gif_quantized_composites, true); assert.equal(result.sampled_frames, 5);
      const gif = decodeGif(new Uint8Array(await readFile(args.output_path))), painter = new GifCanvas(gif); let first, last, delay = 0;
      for (let frame; (frame = painter.next());) { const at = (Math.floor(gif.height / 2) * gif.width + Math.floor(gif.width / 4)) * 4; first ??= [...frame.pixels.subarray(at, at + 4)]; last = [...frame.pixels.subarray(at, at + 4)]; delay += frame.frame.delay; }
      near(first, [255, 0, 0]); near(last, [0, 0, 255]); assert.equal(delay, 50);
    }
    return result;
  };
  await run('abox_video_compress', { input_path: input, output_path: local('compressed native.mp4'), target_bytes: 100000, max_side: 80, keep_audio: false }, { format: 'mp4', size: [80, 48], frames: 5, duration: 0.5 });
  const crop = local('native crop.json'); await writeFile(crop, JSON.stringify({ image_width: 160, image_height: 96, x: 80, y: 0, width: 80, height: 96 }));
  await run('abox_video_crop', { input_path: input, output_path: local('cropped native.mp4'), crop_path: crop, quality: 'high' }, { format: 'mp4', size: [80, 96], frames: 5, duration: 0.5 });
  await run('abox_video_frame', { input_path: input, output_path: local('selected native frame.png'), time_seconds: 0.25 }, { format: 'png', size: [160, 96] });
  await run('abox_video_reverse', { input_path: input, output_path: local('reversed native.mp4'), quality: 'high' }, { format: 'mp4', size: [160, 96], frames: 5, duration: 0.5 });
  await run('abox_video_timelapse', { input_path: input, output_path: local('native time-lapse.mp4'), speed: 2, fps: 10, max_side: 80 }, { format: 'mp4', size: [80, 48], frames: 2, duration: 0.2 });
  await run('abox_video_to_gif', { input_path: input, output_path: local('native sampled.gif'), fps: 10, max_side: 80, colors: 16, dither: false, loop: false }, { format: 'gif', size: [80, 48] });
  await run('abox_video_rotate_bake', { input_path: input, output_path: local('native baked turn.mp4'), degrees: 90 }, { format: 'mp4', size: [96, 160], frames: 5, duration: 0.5, vertical: true });
  for (const item of await visualFacts(outputs)) {
    if (item.name === 'abox_video_frame') { near(item.points[0][0], [0, 0, 255]); near(item.points[0][1], [255, 255, 0]); }
    else if (item.name === 'abox_video_crop') { near(item.points[0][0], [0, 255, 0]); near(item.points.at(-1)[1], [255, 255, 0]); }
    else if (item.name === 'abox_video_reverse') { near(item.points[0][0], [0, 0, 255]); near(item.points.at(-1)[0], [255, 0, 0]); }
    else if (item.name === 'abox_video_rotate_bake') { near(item.points[0][0], [255, 0, 0]); near(item.points[0][1], [0, 255, 0]); }
    else { near(item.points[0][0], [255, 0, 0]); near(item.points.at(-1)[0], [0, 0, 255]); }
  }
  assert.equal(hash(await readFile(input)), expectedHash);
  assert.deepEqual([...new Set(tools)].sort(), ['abox_video_compress', 'abox_video_crop', 'abox_video_frame', 'abox_video_reverse', 'abox_video_timelapse', 'abox_video_to_gif', 'abox_video_rotate_bake'].sort());
  return { tools, capability_absences: absent };
}
