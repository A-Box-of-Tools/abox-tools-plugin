import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { compressVideo, cropVideo, grabVideoFrame, reverseVideo, timelapseVideo, videoToGif, bakeVideoRotation } from '../src/video-decode.mjs';
import { decodeGif } from '../vendor/abox/shared/js/gif-decode.js';
import { GifCanvas } from '../vendor/abox/shared/js/gif-compose.js';
import { Mp4Writer } from '../vendor/abox/shared/js/mp4-writer.js';
import { mp4aSampleEntry } from '../vendor/abox/shared/js/aac.js';
import { admitCompressedAudio, admitMp4Audio } from '../src/audio-headers.mjs';
import { imagesToVideo } from '../src/video-create.mjs';
import { admitAvcTrack } from '../src/video-headers.mjs';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { VIDEO_FIXTURE } from './video-codec-fixtures.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 240000 }, hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) { const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-decode-browser-'))); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(left, right) {
  const width = 160, height = 96, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([...(x < width / 2 ? left : right), 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function source(directory, t) {
  const left = path.join(directory, 'first.png'), right = path.join(directory, 'last.png'), input = path.join(directory, 'source.mp4');
  await writeFile(left, png([255, 0, 0], [0, 255, 0])); await writeFile(right, png([0, 0, 255], [255, 255, 0]));
  try {
    let frozen = null; try { frozen = await readFile(VIDEO_FIXTURE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (frozen) await writeFile(input, frozen);
    else await imagesToVideo({ input_paths: [left, right], output_path: input, width: 160, height: 96, fps: 10, durations_ms: [200, 300], quality: 'high' });
  }
  catch (error) { if (error.code === 'H264_UNAVAILABLE') { t.skip('The installed browser lacks native H.264 encoding.'); return null; } throw error; }
  const bytes = await readFile(input), media = await demux(new File([bytes], 'source.mp4'));
  try { assert.equal(admitAvcTrack(bytes, media.video).samples_checked, 5); }
  catch (error) {
    // Only this locally generated two-color fixture is described. Header-only
    // evidence makes host encoder differences reproducible without video data.
    const lengthSize = (media.video.description[4] & 3) + 1, nals = [];
    for (const [index, sample] of media.video.samples.slice(0, 3).entries()) {
      let at = sample.offset;
      for (let count = 0; count < 8 && at + lengthSize <= sample.offset + sample.size; count++) {
        let size = 0; for (let byte = 0; byte < lengthSize; byte++) size = size * 256 + bytes[at++];
        nals.push({ sample: index, size, type: bytes[at] & 31, header: bytes.subarray(at, Math.min(at + 8, sample.offset + sample.size)).toString('hex') });
        if (!size || at + size > sample.offset + sample.size) break; at += size;
      }
    }
    assert.fail(`${error.code}: synthetic encoder admission; config=${Buffer.from(media.video.description).subarray(0, 512).toString('hex')}; nals=${JSON.stringify(nals)}`);
  }
  return { input, bytes };
}
async function colors(filename, image = false, vertical = false) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: image ? 'frame.png' : 'video.mp4', mimeType: image ? 'image/png' : 'video/mp4', buffer: await readFile(filename) });
    return page.evaluate(async ({ image, vertical }) => {
      const file = document.querySelector('#input').files[0], frames = [];
      const sample = source => { const canvas = document.createElement('canvas'); canvas.width = source.displayWidth ?? source.width; canvas.height = source.displayHeight ?? source.height; const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
        const points = [0.25, 0.75].map(fraction => Array.from(context.getImageData(vertical ? Math.floor(canvas.width / 2) : Math.floor(canvas.width * fraction), vertical ? Math.floor(canvas.height * fraction) : Math.floor(canvas.height / 2), 1, 1).data)); canvas.width = canvas.height = 0; return points; };
      if (image) { const bitmap = await createImageBitmap(file); try { return [sample(bitmap)]; } finally { bitmap.close(); } }
      const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js'), { decoderConfig, micros } = await import('/vendor/abox/shared/js/webcodecs.js'), { video } = await demux(file);
      let failed = false; const decoder = new VideoDecoder({ output: frame => { try { frames.push({ time: frame.timestamp, points: sample(frame) }); } finally { frame.close(); } }, error: () => { failed = true; } });
      try { decoder.configure(decoderConfig(video)); for (const packet of video.samples) decoder.decode(new EncodedVideoChunk({ type: packet.isKey ? 'key' : 'delta', timestamp: micros(packet.pts, video.timescale), data: await file.slice(packet.offset, packet.offset + packet.size).arrayBuffer() }));
        await decoder.flush(); if (failed) throw new Error('decode'); return frames.sort((one, two) => one.time - two.time).map(frame => frame.points);
      } finally { if (decoder.state !== 'closed') decoder.close(); }
    }, { image, vertical });
  });
}
function near(actual, wanted) { assert.equal(actual[3], 255); for (let at = 0; at < 3; at++) assert.ok(Math.abs(actual[at] - wanted[at]) <= 35); }
async function syntheticFailure(operation, args) {
  try { return await operation(args); }
  catch (error) {
    if (error.code === 'H264_UNAVAILABLE') throw error;
    const geometry = await withBrowser(async page => {
      await page.locator('#input').setInputFiles({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: await readFile(args.input_path) });
      return page.evaluate(async () => {
        const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js'), { decoderConfig, micros } = await import('/vendor/abox/shared/js/webcodecs.js');
        const file = document.querySelector('#input').files[0], { video } = await demux(file); let first = null, failed = false;
        const decoder = new VideoDecoder({ output: frame => { try { first ??= { coded_width: frame.codedWidth, coded_height: frame.codedHeight, display_width: frame.displayWidth, display_height: frame.displayHeight,
          timestamp: frame.timestamp, visible: { x: frame.visibleRect.x, y: frame.visibleRect.y, width: frame.visibleRect.width, height: frame.visibleRect.height } }; } finally { frame.close(); } }, error: () => { failed = true; } });
        try { decoder.configure(decoderConfig(video)); for (const sample of video.samples.slice(0, 5)) decoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta', timestamp: micros(sample.pts, video.timescale), data: await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer() })); await decoder.flush(); return { first, failed }; }
        finally { if (decoder.state !== 'closed') decoder.close(); }
      });
    });
    assert.fail(`${error.code}: synthetic operation failed; native_frame=${JSON.stringify(geometry)}`);
  }
}

test('admitted H.264 compression and crop retain every presentation time and independently decoded source regions', browserOptions, async t => {
  const directory = await workspace(t), fixture = await source(directory, t); if (!fixture) return; const { input, bytes } = fixture;
  const compressed = path.join(directory, 'compressed.mp4'); let made;
  try { made = await syntheticFailure(compressVideo, { input_path: input, output_path: compressed, target_bytes: 100000, max_side: 80, keep_audio: false }); }
  catch (error) { if (error.code === 'H264_UNAVAILABLE') { t.skip('Native H.264 encoding is unavailable; frame decoding has a separate always-run fixture case.'); return; } throw error; }
  assert.equal(made.verified, true); assert.equal(made.frame_count, 5); assert.equal(made.verification.output_decoded_frames, 5); assert.equal(typeof made.fitted, 'boolean');
  assert.deepEqual([made.width, made.height], [80, 48]); const compressedColors = await colors(compressed); near(compressedColors[0][0], [255, 0, 0]); near(compressedColors[4][1], [255, 255, 0]);
  const crop = path.join(directory, 'crop.json'), cropped = path.join(directory, 'cropped.mp4'); await writeFile(crop, JSON.stringify({ image_width: 160, image_height: 96, x: 80, y: 0, width: 80, height: 96 }));
  const croppedResult = await cropVideo({ input_path: input, output_path: cropped, crop_path: crop, quality: 'high' });
  assert.equal(croppedResult.verified, true); assert.equal(croppedResult.frame_count, 5); assert.deepEqual([croppedResult.width, croppedResult.height], [80, 96]);
  const croppedColors = await colors(cropped); near(croppedColors[0][0], [0, 255, 0]); near(croppedColors[4][1], [255, 255, 0]);
  for (const output of [compressed, cropped]) { const media = await demux(new File([await readFile(output)], 'result.mp4')); assert.deepEqual(media.video.samples.map(sample => sample.pts), [0, 9000, 18000, 27000, 36000]); assert.equal(media.video.duration, 45000); }
  await assert.rejects(compressVideo({ input_path: input, output_path: compressed, target_bytes: 100000 }), { code: 'OUTPUT_EXISTS' }); assert.equal(hash(await readFile(input)), hash(bytes));
});

test('frame grab chooses the source frame at or before time and keeps every lossless output pixel', browserOptions, async t => {
  const directory = await workspace(t), fixture = await source(directory, t); if (!fixture) return; const { input, bytes } = fixture, output = path.join(directory, 'frame.png');
  const result = await syntheticFailure(grabVideoFrame, { input_path: input, output_path: output, time_seconds: 0.25 });
  assert.equal(result.verified, true); assert.equal(result.frame_time_seconds, 0.2); assert.equal(result.display_frame, 3); assert.equal(result.verification.png_all_pixels, true);
  const pixels = await colors(output, true); near(pixels[0][0], [0, 0, 255]); near(pixels[0][1], [255, 255, 0]);
  await assert.rejects(grabVideoFrame({ input_path: input, output_path: path.join(directory, 'end.png'), time_seconds: 0.5 }), { code: 'VIDEO_FRAME_TIME' });
  const config = path.join(directory, 'bad.json'); await writeFile(config, JSON.stringify({ image_width: 161, image_height: 96, x: 0, y: 0, width: 80, height: 80 }));
  await assert.rejects(cropVideo({ input_path: input, output_path: path.join(directory, 'bad.mp4'), crop_path: config }), { code: 'VIDEO_CROP_COORDINATES' });
  await assert.rejects(stat(path.join(directory, 'end.png')), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(bytes));
});

test('reverse, time-lapse and baked rotation use the source engines with verified changed frame order and geometry', browserOptions, async t => {
  const directory = await workspace(t), fixture = await source(directory, t); if (!fixture) return; const { input, bytes } = fixture;
  const reversePath = path.join(directory, 'reversed.mp4'); let reversed;
  try { reversed = await syntheticFailure(reverseVideo, { input_path: input, output_path: reversePath, quality: 'high' }); }
  catch (error) { if (error.code === 'H264_UNAVAILABLE') { t.skip('Native H.264 encoding is unavailable.'); return; } throw error; }
  assert.equal(reversed.frame_count, 5); assert.equal(reversed.audio_copied, false); assert.equal(reversed.output_duration_seconds, 0.5);
  const reversedColors = await colors(reversePath); near(reversedColors[0][0], [0, 0, 255]); near(reversedColors.at(-1)[0], [255, 0, 0]);
  const lapsePath = path.join(directory, 'time-lapse.mp4'), lapse = await syntheticFailure(timelapseVideo, { input_path: input, output_path: lapsePath, speed: 2, fps: 10, max_side: 80 });
  assert.equal(lapse.frame_count, 2); assert.equal(lapse.output_duration_seconds, 0.2); assert.deepEqual([lapse.width, lapse.height], [80, 48]);
  const lapseColors = await colors(lapsePath); near(lapseColors[0][0], [255, 0, 0]); near(lapseColors[1][0], [0, 0, 255]);
  const bakePath = path.join(directory, 'baked.mp4'), baked = await syntheticFailure(bakeVideoRotation, { input_path: input, output_path: bakePath, degrees: 90 });
  assert.equal(baked.baked_pixels, true); assert.deepEqual([baked.width, baked.height], [96, 160]);
  const bakedMedia = await demux(new File([await readFile(bakePath)], 'baked.mp4')); assert.equal(bakedMedia.video.rotation, 0);
  const bakedColors = await colors(bakePath, false, true); near(bakedColors[0][0], [255, 0, 0]); near(bakedColors[0][1], [0, 255, 0]);
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('video GIF export verifies complete palette composites, merged frame delays and sampled source regions', browserOptions, async t => {
  const directory = await workspace(t), fixture = await source(directory, t); if (!fixture) return; const { input, bytes } = fixture, output = path.join(directory, 'sampled.gif');
  const result = await syntheticFailure(videoToGif, { input_path: input, output_path: output, fps: 10, max_side: 80, colors: 16, dither: false, loop: false });
  assert.equal(result.verified, true); assert.equal(result.sampled_frames, 5); assert.equal(result.verification.gif_quantized_composites, true); assert.equal(result.output_duration_seconds, 0.5);
  const gif = decodeGif(new Uint8Array(await readFile(output))), painter = new GifCanvas(gif), picked = [];
  for (let frame; (frame = painter.next());) picked.push({ delay: frame.frame.delay, left: [...frame.pixels.subarray((Math.floor(gif.height / 2) * gif.width + Math.floor(gif.width / 4)) * 4, (Math.floor(gif.height / 2) * gif.width + Math.floor(gif.width / 4)) * 4 + 4)] });
  assert.equal(gif.width, 80); assert.equal(gif.height, 48); assert.equal(picked.reduce((sum, frame) => sum + frame.delay, 0), 50);
  near(picked[0].left, [255, 0, 0]); near(picked.at(-1).left, [0, 0, 255]); assert.equal(hash(await readFile(input)), hash(bytes));
});

test('requested reversed AAC uses bounded packet PCM, exact sample reversal and a verified AAC output without silent omission', browserOptions, async t => {
  const directory = await workspace(t), fixture = await source(directory, t); if (!fixture) return;
  const adts = await readFile(new URL('./fixtures/abox-synthetic.aac', import.meta.url)), plan = await admitCompressedAudio(adts), picture = await demux(new File([fixture.bytes], 'source.mp4')), writer = new Mp4Writer();
  const video = writer.addTrack({ kind: 'vide', timescale: picture.video.timescale, sampleEntry: picture.video.sampleEntry, matrix: picture.video.matrix, width: picture.video.trackWidth, height: picture.video.trackHeight });
  for (let at = 0; at < picture.video.samples.length; at++) { const sample = picture.video.samples[at], next = picture.video.samples[at + 1];
    video.addSample({ data: fixture.bytes.subarray(sample.offset, sample.offset + sample.size), isKey: sample.isKey, dts: sample.dts, pts: sample.pts, duration: (next?.dts ?? picture.video.duration) - sample.dts }); }
  const count = Math.round(0.5 * plan.sample_rate / 1024), audio = writer.addTrack({ kind: 'soun', timescale: plan.sample_rate,
    sampleEntry: mp4aSampleEntry({ channels: plan.channels, sampleRate: plan.sample_rate, asc: plan.description }) });
  for (let at = 0; at < count; at++) { const packet = plan.packets[at % plan.packets.length]; audio.addSample({ data: adts.subarray(packet.offset, packet.offset + packet.size), isKey: true, dts: at * 1024, pts: at * 1024, duration: 1024 }); }
  const input = path.join(directory, 'video with AAC.mp4'), output = path.join(directory, 'reversed with AAC.mp4'), original = Buffer.from(await writer.finalize().arrayBuffer()); await writeFile(input, original);
  let result;
  try { result = await reverseVideo({ input_path: input, output_path: output, keep_audio: true }); }
  catch (error) {
    if (['H264_UNAVAILABLE', 'AUDIO_ENCODER_UNAVAILABLE', 'AUDIO_DECODER_UNAVAILABLE'].includes(error.code)) { await assert.rejects(stat(output), { code: 'ENOENT' }); t.skip('The installed native codecs cannot encode/decode requested reversed sound.'); return; }
    throw error;
  }
  assert.equal(result.audio_reversed, true); assert.equal(result.audio_copied, false); assert.equal(result.audio_packet_bytes_verified, false);
  assert.equal(result.verification.reversed_pcm_samples, count * 1024 * plan.channels); assert.equal(result.verification.audio_output_decoded, true);
  assert.ok(result.verification.encoded_audio_packets > 0); const checked = await admitMp4Audio(await readFile(output));
  assert.equal(checked.channels, plan.channels); assert.equal(checked.sample_rate, plan.sample_rate); assert.ok(checked.frames >= count * 1024);
  assert.equal(hash(await readFile(input)), hash(original)); assert.ok(!Object.hasOwn(result, 'channels'));
});
