import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseVideoCopy, MAX_VIDEO_INPUT_BYTES } from './video-copy.mjs';
import { admitAvcTrack, MAX_AVC_SAMPLES, MAX_AVC_SECONDS } from './video-headers.mjs';
import { rotationMatrix } from '../vendor/abox/tools/rotate-video/src/plan.js';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { plan as compressionPlan } from '../vendor/abox/tools/compress-video/src/plan.js';
import { averageFps } from '../vendor/abox/shared/js/webcodecs.js';
import { describeSound } from '../vendor/abox/shared/js/reencode-sound.js';
import { reversedTimes, outputSize as reverseSize } from '../vendor/abox/tools/reverse-video/src/timeline.js';
import { frameTimes as lapseTimes, outputSize as lapseSize } from '../vendor/abox/tools/timelapse-video/src/plan.js';
import { frameCount as gifCount, frameTimes as gifTimes, frameDelays as gifDelays, outputSize as gifSize, workingMemory as gifWorkingMemory } from '../vendor/abox/tools/video-to-gif/src/plan.js';
import { analyzeGifInput } from './gif.mjs';
import { admitMp4Audio } from './audio-headers.mjs';
import { installAudioPacketDecoder } from './audio-browser-codec.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_DECODE_OUTPUT_BYTES = 128 * 2 ** 20;
export const MAX_DECODE_OUTPUT_SIDE = 1920;
export const MAX_DECODE_OUTPUT_PIXELS = 2_073_600;
export const MAX_VIDEO_FRAME_BYTES = 32 * 2 ** 20;
export const MAX_VIDEO_CROP_CONFIG_BYTES = 16 * 1024;
export const MAX_VIDEO_GIF_FRAMES = 200;
export const MAX_VIDEO_GIF_PIXELS = 16_000_000;
export const MAX_VIDEO_REVERSE_PIXELS = 96_000_000;
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const equal = (one, two) => Buffer.from(one).equals(Buffer.from(two));
const fail = (code, message) => { throw new AdapterError(code, message); };
const verify = () => fail('VERIFICATION_FAILED', 'The processed video did not retain its admitted frame geometry, timestamps or copied audio packets. No output was written.');
function settingsFor(kind, args) {
  const keep_audio = args.keep_audio === undefined ? kind !== 'reverse' : args.keep_audio;
  if (kind === 'frame') {
    const time_seconds = args.time_seconds === undefined ? 0 : args.time_seconds;
    if (typeof time_seconds !== 'number' || !Number.isFinite(time_seconds) || time_seconds < 0 || time_seconds > MAX_AVC_SECONDS) fail('INVALID_ARGUMENTS', 'Choose a finite time_seconds from zero to60.');
    return { time_seconds };
  }
  if (kind === 'gif') {
    const settings = { start_seconds: args.start_seconds === undefined ? 0 : args.start_seconds, end_seconds: args.end_seconds,
      fps: args.fps === undefined ? 10 : args.fps, max_side: args.max_side === undefined ? 480 : args.max_side,
      colors: args.colors === undefined ? 255 : args.colors, dither: args.dither === undefined ? true : args.dither, loop: args.loop === undefined ? true : args.loop };
    if (!Number.isFinite(settings.start_seconds) || settings.start_seconds < 0 || settings.end_seconds !== undefined && (!Number.isFinite(settings.end_seconds) || settings.end_seconds <= settings.start_seconds)
        || !Number.isFinite(settings.fps) || settings.fps < 1 || settings.fps > 50 || !integer(settings.max_side, 16, 960) || !integer(settings.colors, 4, 255)
        || typeof settings.dither !== 'boolean' || typeof settings.loop !== 'boolean') fail('INVALID_ARGUMENTS', 'Choose a finite video section, fps1..50, max_side16..960, colors4..255 and boolean dither/loop.');
    return settings;
  }
  if (kind === 'timelapse') {
    const settings = { speed: args.speed === undefined ? 10 : args.speed, fps: args.fps === undefined ? 30 : args.fps,
      max_side: args.max_side === undefined ? 1280 : args.max_side, quality: args.quality === undefined ? 'medium' : args.quality };
    if (!Number.isFinite(settings.speed) || settings.speed < 1.1 || settings.speed > 1000 || ![5, 10, 15, 24, 25, 30].includes(settings.fps)
        || !integer(settings.max_side, 16, 1920) || !['low', 'medium', 'high'].includes(settings.quality)) fail('INVALID_ARGUMENTS', 'Choose speed1.1..1000, an offered5..30fps, max_side16..1920 and low/medium/high quality.');
    return settings;
  }
  if (typeof keep_audio !== 'boolean') fail('INVALID_ARGUMENTS', 'keep_audio must be boolean.');
  if (kind === 'bake') {
    const degrees = args.degrees === undefined ? 90 : args.degrees, max_side = args.max_side === undefined ? 1920 : args.max_side;
    if (![90, 180, 270].includes(degrees) || !integer(max_side, 16, 1920)) fail('INVALID_ARGUMENTS', 'Choose degrees90/180/270 and max_side16..1920.');
    return { keep_audio, degrees, max_side };
  }
  if (kind === 'compress') {
    const max_side = args.max_side === undefined ? 1920 : args.max_side;
    if (!integer(args.target_bytes, 100000, MAX_DECODE_OUTPUT_BYTES) || !integer(max_side, 16, MAX_DECODE_OUTPUT_SIDE)) fail('INVALID_ARGUMENTS', 'Compression requires target_bytes from100000 to128MiB and max_side from16 to1920.');
    return { keep_audio, target_bytes: args.target_bytes, max_side };
  }
  const quality = args.quality === undefined ? 'medium' : args.quality;
  if (!['low', 'medium', 'high'].includes(quality)) fail('INVALID_ARGUMENTS', 'Choose low, medium or high quality.');
  return { keep_audio, quality };
}
async function cropConfig(filename) {
  const input = await readInput(filename, { max_bytes: MAX_VIDEO_CROP_CONFIG_BYTES }); let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.data); let depth = 0;
    for (let at = 0; at < text.length; at++) {
      if (text[at] === '"') { for (at++; at < text.length; at++) { if (text[at] === '\\') at++; else if (text[at] === '"') break; } }
      else if (text[at] === '{' || text[at] === '[') { if (++depth > 2) throw new Error(); }
      else if (text[at] === '}' || text[at] === ']') depth--;
    }
    const tree = parseJson(text);
    const required = ['image_width', 'image_height', 'x', 'y', 'width', 'height'];
    if (tree.t !== 'map' || tree.pairs.length !== required.length || new Set(tree.pairs.map(pair => pair.key)).size !== required.length
        || tree.pairs.some(pair => !required.includes(pair.key) || pair.value.t !== 'num')) throw new Error();
    value = Object.fromEntries(tree.pairs.map(pair => [pair.key, Number(pair.value.raw)]));
    if (!Object.values(value).every(number => integer(number, 0, 4096)) || !value.image_width || !value.image_height
        || value.width < 16 || value.height < 16 || value.width % 2 || value.height % 2
        || value.width > MAX_DECODE_OUTPUT_SIDE || value.height > MAX_DECODE_OUTPUT_SIDE || value.width * value.height > MAX_DECODE_OUTPUT_PIXELS) throw new Error();
  } catch { fail('VIDEO_CROP_CONFIG', 'Use six integer image_width/image_height/x/y/width/height fields in local JSON, with even crop sides from16 to1920 and at most1080p output pixels.'); }
  return { path: input.path, bytes: input.data.length, value };
}
function presentation(video) {
  const normal = rotationMatrix(video.rotation, video.codedWidth, video.codedHeight), zero = Uint8Array.from(normal); zero.fill(0, 24, 32);
  if ((!equal(video.matrix, normal) && !equal(video.matrix, zero)) || video.trackWidth !== video.codedWidth * 65536 || video.trackHeight !== video.codedHeight * 65536) fail('UNSUPPORTED_VIDEO_MATRIX', 'Decoded video requires ordinary unstretched quarter-turn orientation. Complex transforms are refused.');
  const entry = Buffer.from(video.sampleEntry);
  for (let at = 86; at < entry.length;) {
    if (at + 8 > entry.length) verify(); const size = entry.readUInt32BE(at), type = entry.toString('latin1', at + 4, at + 8);
    if (size < 8 || at + size > entry.length) fail('UNSUPPORTED_VIDEO', 'Extended or incomplete visual descriptions are unsupported.');
    if (type === 'clap' || type === 'pasp' && (size !== 16 || !entry.readUInt32BE(at + 8) || entry.readUInt32BE(at + 8) !== entry.readUInt32BE(at + 12))) fail('UNSUPPORTED_VIDEO_MATRIX', 'Clean aperture and non-square pixel aspect are unsupported.');
    at += size;
  }
}
async function admission(bytes, kind, settings, crop) {
  const { media, structure } = await parseVideoCopy(bytes), { video, audio } = media;
  if (structure.fragmented) fail('UNSUPPORTED_VIDEO', 'Decoded video currently supports complete ordinary MP4 sample tables.');
  presentation(video); const avc = admitAvcTrack(bytes, video), fps = averageFps(video), order = video.samples.map(sample => sample.pts).sort((one, two) => one - two);
  const ticks = order.map(pts => Math.round(Math.round(pts / video.timescale * 1e6) / 1e6 * 90000));
  if (video.samples[0].dts !== 0 || order[0] !== 0 || video.samples.length / media.duration > 240
      || order.some((pts, index) => index && (pts <= order[index - 1] || ticks[index] <= ticks[index - 1]))) fail('UNSUPPORTED_VIDEO_TIMELINE', 'Decoded tracks must start at zero, have distinct presentation times and at most240frames/second.');
  if (settings.keep_audio && audio) {
    if (audio.samples.length > 10000 || audio.samples.reduce((sum, sample) => sum + sample.size, 0) > 32 * 2 ** 20
        || audio.samples[0]?.dts !== 0 || audio.samples[0]?.pts !== 0) fail('VIDEO_AUDIO_COPY_LIMIT', 'Copied audio must start at zero and fit10000packets/32MiB. Choose keep_audio:false to omit it.');
  }
  const result = { avc, width: video.displayWidth, height: video.displayHeight, rotation: video.rotation, duration: media.duration, fps,
    description: Array.from(video.description), pts_us: video.samples.map(sample => Math.round(sample.pts / video.timescale * 1e6)),
    source_frames: video.samples.length, expected_frames: video.samples.length, input_audio: Boolean(audio), copy_audio: Boolean(settings.keep_audio && audio), ticks,
    audio_bytes: settings.keep_audio && audio ? audio.samples.reduce((sum, sample) => sum + sample.size, 0) : 0 };
  if (kind === 'frame') {
    if (settings.time_seconds >= media.duration) fail('VIDEO_FRAME_TIME', 'The requested time must be inside the video duration.');
    let index = 0; for (let at = 1; at < order.length && order[at] / video.timescale <= settings.time_seconds; at++) index = at;
    return { ...result, frame_index: index, frame_time_seconds: order[index] / video.timescale };
  }
  if (kind === 'crop') {
    if (crop.image_width !== video.displayWidth || crop.image_height !== video.displayHeight || crop.x + crop.width > video.displayWidth || crop.y + crop.height > video.displayHeight) fail('VIDEO_CROP_COORDINATES', 'The crop must fit completely inside the declared decoded display dimensions.');
    return { ...result, output_width: crop.width, output_height: crop.height, crop, tail: ticks.length > 1 ? ticks.at(-1) - ticks.at(-2) : 3000 };
  }
  const fittedSize = (width, height, edge) => {
    const factor = Math.min(1, edge / Math.max(width, height), Math.sqrt(MAX_DECODE_OUTPUT_PIXELS / (width * height)));
    return { width: Math.max(2, Math.floor(width * factor / 2) * 2), height: Math.max(2, Math.floor(height * factor / 2) * 2) };
  };
  if (kind === 'reverse') {
    const size = reverseSize(video);
    if (size.width > 1920 || size.height > 1920 || size.width * size.height > MAX_DECODE_OUTPUT_PIXELS
        || video.samples.length * size.width * size.height > MAX_VIDEO_REVERSE_PIXELS) fail('VIDEO_REVERSE_LIMIT', 'Reversal supports1080p output geometry and96million aggregate visible frame pixels. Compress or shorten this video first.');
    const times = reversedTimes(video), reversed = Array.from(times.start, time => Math.round(Math.round(time / video.timescale * 1e6) / 1e6 * 90000)).sort((one, two) => one - two);
    if (reversed.some((time, at) => at && time <= reversed[at - 1])) fail('UNSUPPORTED_VIDEO_TIMELINE', 'The reversed presentation times do not remain distinct after source-engine clock rounding.');
    let audioPlan = null;
    if (settings.keep_audio && audio) {
      const sound = await admitMp4Audio(bytes);
      if (Math.abs(sound.duration_seconds - media.duration) > Math.max(0.05, 2048 / sound.sample_rate)) fail('VIDEO_AUDIO_TIMELINE', 'Reversed AAC must cover the video within two AAC packets; unmatched track lengths are refused.');
      audioPlan = { codec: sound.codec, description: Array.from(sound.description), sample_rate: sound.sample_rate, channels: sound.channels,
        frames: sound.frames, packet_frames: sound.packet_frames, packets: sound.packets };
    }
    return { ...result, copy_audio: false, reverse_audio: Boolean(audioPlan), audio_plan: audioPlan, ticks: reversed,
      output_width: size.width, output_height: size.height, tail: Math.max(1, Math.round(90000 / Math.max(1, fps))) };
  }
  if (kind === 'timelapse') {
    const count = Math.max(1, Math.floor(media.duration / (settings.speed / settings.fps) + 1e-6));
    if (count < 2 || count > MAX_AVC_SAMPLES) fail('VIDEO_TIMELAPSE_LIMIT', 'The time-lapse plan must contain2..1800frames; choose a lower speed or longer source.');
    const desired = fittedSize(video.displayWidth, video.displayHeight, settings.max_side), shortEdge = Math.min(desired.width, desired.height), size = lapseSize({ width: video.displayWidth, height: video.displayHeight, shortEdge });
    if (size.width > 1920 || size.height > 1920 || size.width * size.height > MAX_DECODE_OUTPUT_PIXELS) fail('VIDEO_TIMELAPSE_LIMIT', 'Time-lapse output exceeds1080p pixels.');
    return { ...result, times: lapseTimes({ duration: media.duration, speed: settings.speed, fps: settings.fps }), expected_frames: count,
      ticks: Array.from({ length: count }, (_, at) => Math.round(at * 90000 / settings.fps)), tail: Math.round(90000 / settings.fps), output_width: size.width, output_height: size.height };
  }
  if (kind === 'gif') {
    const end = settings.end_seconds === undefined ? media.duration : settings.end_seconds, start = settings.start_seconds;
    if (!(start < end) || end > media.duration) fail('VIDEO_GIF_RANGE', 'The GIF section must fit fully inside the source duration.');
    const count = gifCount({ start, end, fps: settings.fps }), width = Math.max(1, Math.round(video.displayWidth * Math.min(1, settings.max_side / Math.max(video.displayWidth, video.displayHeight)))), size = gifSize(video.displayWidth, video.displayHeight, width);
    if (count > MAX_VIDEO_GIF_FRAMES || count * size.width * size.height > MAX_VIDEO_GIF_PIXELS || gifWorkingMemory({ frames: count, ...size, sourceWidth: avc.coded_width, sourceHeight: avc.coded_height, packetBytes: bytes.length }) > 384 * 2 ** 20) fail('VIDEO_GIF_LIMIT', 'GIF export supports200sampledframes,16million aggregate output pixels and a384MiB estimated working policy.');
    const times = gifTimes({ start, end, fps: settings.fps }), delays = gifDelays(times, end);
    return { ...result, times, delays, expected_frames: count, output_width: size.width, output_height: size.height, total_delay_cs: delays.reduce((sum, delay) => sum + delay, 0) };
  }
  if (kind === 'bake') {
    if (settings.keep_audio && audio && !describeSound(audio)?.copyable) fail('VIDEO_AUDIO_COPY_UNSUPPORTED', 'Baked rotation can copy supported AAC only. Choose keep_audio:false to omit other audio.');
    const rotation = (video.rotation + settings.degrees) % 360, switched = rotation % 180 !== 0, size = fittedSize(switched ? video.codedHeight : video.codedWidth, switched ? video.codedWidth : video.codedHeight, settings.max_side);
    return { ...result, output_width: size.width, output_height: size.height, tail: Math.max(1, Math.round(90000 / Math.round(fps))) };
  }
  const source = { seconds: media.duration, fps, displayWidth: video.displayWidth, displayHeight: video.displayHeight,
    videoBytes: video.samples.reduce((sum, sample) => sum + sample.size, 0), audioBytes: audio?.samples.reduce((sum, sample) => sum + sample.size, 0) ?? 0,
    samples: video.samples.length + (settings.keep_audio ? audio?.samples.length ?? 0 : 0) };
  let edge = Math.min(settings.max_side, Math.floor(Math.sqrt(MAX_DECODE_OUTPUT_PIXELS * Math.max(source.displayWidth, source.displayHeight) / Math.min(source.displayWidth, source.displayHeight))));
  let planned = compressionPlan(source, { targetBytes: settings.target_bytes, keepAudio: settings.keep_audio, longEdge: edge });
  while (planned.ok && planned.frame.width * planned.frame.height > MAX_DECODE_OUTPUT_PIXELS && edge > 16) planned = compressionPlan(source, { targetBytes: settings.target_bytes, keepAudio: settings.keep_audio, longEdge: --edge });
  if (!planned.ok) fail('VIDEO_TARGET_TOO_SMALL', 'The target cannot hold the selected audio, sample tables and source engine minimum video bitrate.');
  if (planned.bitrate > 40_000_000) planned.bitrate = 40_000_000;
  return { ...result, source, compression: planned, output_width: planned.frame.width, output_height: planned.frame.height, tail: Math.max(1, Math.round(90000 / Math.round(fps))) };
}
async function admitWorker(bytes, kind, settings, crop, { signal } = {}) {
  const source = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-video-admit', source, operation: kind, settings, crop }, transferList: [source.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } }); worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); }); };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Video header admission exceeded two minutes.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('VIDEO_DECODE_LIMIT', 'The isolated video admission worker exceeded its resource policy.')));
    worker.on('exit', () => finish(new AdapterError('VIDEO_DECODE_LIMIT', 'The isolated video admission worker stopped before completion.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
async function processBrowser(input, kind, settings, admitted, options) {
  return withBrowser(async page => {
    if (admitted.audio_plan) await page.evaluate(installAudioPacketDecoder);
    await page.locator('#input').setInputFiles({ name: 'source.mp4', mimeType: 'video/mp4', buffer: input });
    return page.evaluate(async ({ kind, settings, admitted, maxBytes }) => {
      const refuse = (code, message) => ({ error: { code, message } }), NativeDecoder = globalThis.VideoDecoder, NativeEncoder = globalThis.VideoEncoder;
      if (typeof NativeDecoder !== 'function' || !['frame', 'gif'].includes(kind) && typeof NativeEncoder !== 'function') return refuse('H264_UNAVAILABLE', 'The installed browser must support the requested native H.264 decoding/encoding.');
      const budget = { failure: null, decoded: 0, encoded: 0, bytes: 0 }, allowedTimes = new Set(admitted.pts_us), description = Uint8Array.from(admitted.description);
      const asBytes = value => ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
      class CheckedDecoder extends NativeDecoder {
        constructor(init) {
          let instance;
          super({ ...init, output: frame => {
            const rect = frame.visibleRect;
            const reason = ++budget.decoded > 18000 ? 'VIDEO_DECODE_COUNT'
              : !Number.isInteger(frame.codedWidth) || !Number.isInteger(frame.codedHeight) || frame.codedWidth < 1 || frame.codedHeight < 1
                || frame.codedWidth > admitted.avc.native_max_width || frame.codedHeight > admitted.avc.native_max_height
                || frame.displayWidth !== admitted.avc.width || frame.displayHeight !== admitted.avc.height || !rect
                || rect.width !== admitted.avc.width || rect.height !== admitted.avc.height || rect.x < 0 || rect.y < 0
                || rect.x + rect.width > frame.codedWidth || rect.y + rect.height > frame.codedHeight ? 'VIDEO_DECODE_GEOMETRY'
                : !allowedTimes.has(frame.timestamp) ? 'VIDEO_DECODE_TIMESTAMP' : null;
            if (reason) {
              budget.failure = reason; frame.close(); try { instance.close(); } catch {} return;
            }
            init.output(frame);
          } }); instance = this;
        }
        configure(config) {
          const bytes = config.description && asBytes(config.description);
          if (!bytes || bytes.length !== description.length || bytes.some((value, index) => value !== description[index])
              || config.codedWidth !== admitted.avc.width || config.codedHeight !== admitted.avc.height) { budget.failure = 'VIDEO_DECODE_CONFIG'; throw new Error('admission'); }
          return super.configure(config);
        }
      }
      Object.defineProperty(CheckedDecoder, 'isConfigSupported', { value: NativeDecoder.isConfigSupported.bind(NativeDecoder) });
      class CheckedEncoder extends (NativeEncoder ?? class {}) {
        constructor(init) {
          let instance;
          super({ ...init, output: (chunk, metadata) => {
            const config = metadata?.decoderConfig?.description;
            if (++budget.encoded > admitted.expected_frames * (kind === 'compress' ? 2 : 1) || chunk.byteLength < 1 || chunk.byteLength > 8 * 2 ** 20
                || (budget.bytes += chunk.byteLength) > maxBytes - admitted.audio_bytes - 2 * 2 ** 20 || config && asBytes(config).length > 65536) {
              budget.failure = 'VIDEO_ENCODE_LIMIT'; try { instance.close(); } catch {} return;
            }
            init.output(chunk, metadata);
          } }); instance = this;
        }
      }
      if (NativeEncoder) Object.defineProperty(CheckedEncoder, 'isConfigSupported', { value: NativeEncoder.isConfigSupported.bind(NativeEncoder) });
      globalThis.VideoDecoder = CheckedDecoder; if (NativeEncoder) globalThis.VideoEncoder = CheckedEncoder;
      let reader, canvas, outputDecoder;
      try {
        const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js'), { decoderConfig, micros, settle } = await import('/vendor/abox/shared/js/webcodecs.js');
        const file = document.querySelector('#input').files[0], media = await demux(file), { video } = media;
        if (video.samples.length !== admitted.source_frames || video.codedWidth !== admitted.avc.width || video.codedHeight !== admitted.avc.height || video.rotation !== admitted.rotation) return refuse('VERIFICATION_FAILED', 'Browser demux disagreed with admitted video headers.');
        const supported = await NativeDecoder.isConfigSupported(decoderConfig(video)); if (!supported.supported) return refuse('H264_UNAVAILABLE', 'The installed browser cannot decode this admitted H.264 configuration.');
        let blob, frames = 0, fitted = null, reversedPcmSamples = 0, encodedAudioPackets = 0, omittedAudioFrames = 0;
        if (kind === 'frame') {
          const { FrameReader } = await import('/vendor/abox/tools/grab-frame/src/frames.js'), { frameCanvas } = await import('/vendor/abox/tools/grab-frame/src/draw.js'), { encodeStill } = await import('/vendor/abox/tools/grab-frame/src/still.js');
          reader = new FrameReader(file, video); reader.lookahead = 2; reader.maxCached = 3;
          const bitmap = await reader.frameAt(admitted.frame_index); canvas = frameCanvas(bitmap, video);
          blob = await encodeStill(canvas, { type: 'image/png' });
          if (blob.size > 32 * 2 ** 20) return refuse('OUTPUT_SIZE', 'The video frame PNG exceeds32MiB.');
          const decoded = await createImageBitmap(blob), check = document.createElement('canvas');
          try {
            if (decoded.width !== canvas.width || decoded.height !== canvas.height) return refuse('VERIFICATION_FAILED', 'The saved frame dimensions changed.');
            check.width = canvas.width; check.height = canvas.height; check.getContext('2d').drawImage(decoded, 0, 0);
            const expected = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, actual = check.getContext('2d').getImageData(0, 0, check.width, check.height).data;
            if (actual.some((value, index) => value !== expected[index])) return refuse('VERIFICATION_FAILED', 'The saved PNG changed a decoded frame pixel.');
          } finally { decoded.close(); check.width = check.height = 0; }
          frames = 1;
        } else if (kind === 'gif') {
          const { framesByDecoding } = await import('/vendor/abox/tools/video-to-gif/src/frames.js'), { encodeGif, ColorHistogram } = await import('/vendor/abox/tools/video-to-gif/src/encode.js');
          const { Palette, medianCut, quantizeFrame, amplitudeFor } = await import('/vendor/abox/tools/video-to-gif/src/quantize.js');
          const histogram = new ColorHistogram(), sampled = await framesByDecoding({ file, media, times: admitted.times, width: admitted.output_width, height: admitted.output_height, histogram });
          if (sampled.length !== admitted.expected_frames) return refuse('VERIFICATION_FAILED', 'Video sampling did not return every planned GIF instant.');
          const palette = new Palette(medianCut(histogram, settings.colors)), amplitude = settings.dither ? amplitudeFor(palette.rgb) : 0, hashes = [];
          const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
          for (const rgba of sampled) {
            const indices = quantizeFrame(rgba, admitted.output_width, admitted.output_height, palette, amplitude), expected = new Uint8Array(indices.length * 4);
            for (let at = 0; at < indices.length; at++) { expected.set(palette.rgb.subarray(indices[at] * 3, indices[at] * 3 + 3), at * 4); expected[at * 4 + 3] = 255; }
            hashes.push(await digest(expected));
          }
          const encoded = await encodeGif({ frames: sampled, histogram, delays: admitted.delays, width: admitted.output_width, height: admitted.output_height, colors: settings.colors, dither: settings.dither, loop: settings.loop }); blob = encoded.blob;
          if (blob.size > 32 * 2 ** 20) return refuse('OUTPUT_SIZE', 'The sampled GIF exceeds32MiB.');
          const { decodeGif } = await import('/vendor/abox/shared/js/gif-decode.js'), { GifCanvas } = await import('/vendor/abox/shared/js/gif-compose.js');
          const gif = decodeGif(new Uint8Array(await blob.arrayBuffer()), { maxPixels: 16000000, strictMaxPixels: true });
          if (gif.truncated || gif.width !== admitted.output_width || gif.height !== admitted.output_height || gif.loopCount !== (settings.loop ? 0 : 1)) return refuse('VERIFICATION_FAILED', 'The generated GIF geometry or loop metadata changed.');
          const painter = new GifCanvas(gif); let cursor = 0, remaining = admitted.delays[0], total = 0;
          for (let frame; (frame = painter.next());) {
            const hash = await digest(frame.pixels); let delay = frame.frame.delay; total += delay;
            while (delay > 0) { if (cursor >= hashes.length || hash !== hashes[cursor]) return refuse('VERIFICATION_FAILED', 'A composited GIF frame differs from the admitted quantized video samples.');
              const take = Math.min(delay, remaining); delay -= take; remaining -= take; if (remaining === 0) { cursor++; remaining = admitted.delays[cursor]; } }
          }
          if (cursor !== hashes.length || total !== admitted.total_delay_cs) return refuse('VERIFICATION_FAILED', 'The generated GIF changed the complete sampled timeline.');
          frames = gif.frames.length;
        } else if (kind === 'timelapse') {
          const { timelapseByDecoding } = await import('/vendor/abox/tools/timelapse-video/src/decode.js'), { TimelapseWriter } = await import('/vendor/abox/tools/timelapse-video/src/encode.js');
          const { chooseBitrate } = await import('/vendor/abox/tools/timelapse-video/src/plan.js'), { pickH264Codec } = await import('/vendor/abox/shared/js/video-support.js');
          const bitrate = chooseBitrate({ width: admitted.output_width, height: admitted.output_height, fps: settings.fps, quality: settings.quality }), codec = await pickH264Codec({ width: admitted.output_width, height: admitted.output_height, framerate: settings.fps, bitrate });
          if (!codec) return refuse('H264_UNAVAILABLE', 'The installed browser cannot encode the time-lapse H.264 configuration.');
          const writer = new TimelapseWriter({ width: admitted.output_width, height: admitted.output_height, fps: settings.fps, bitrate, codec });
          try { writer.open(); const made = await timelapseByDecoding({ file, media, times: admitted.times, width: admitted.output_width, height: admitted.output_height, writer }); blob = made.blob; frames = made.frames; }
          finally { writer.close(); }
        } else if (kind === 'reverse') {
          const { reverseExact } = await import('/vendor/abox/tools/reverse-video/src/reverse.js');
          const made = await reverseExact({ file, media, quality: settings.quality, keepAudio: false }); blob = made.blob; frames = made.frames;
          if (admitted.audio_plan) {
            const { reverseChannels, encodeAudioTrack, canEncodeAudio } = await import('/vendor/abox/tools/reverse-video/src/audio.js');
            const decoded = await globalThis.__aboxDecodeAudioPackets(file, admitted.audio_plan), hash = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(array.buffer, array.byteOffset, array.byteLength)))).join(',');
            const before = []; for (const plane of decoded.channels) before.push(await hash(plane)); reverseChannels(decoded.channels);
            for (const [channel, plane] of decoded.channels.entries()) {
              const restored = new Float32Array(plane.length); for (let at = 0; at < plane.length; at++) restored[at] = plane[plane.length - 1 - at];
              if (await hash(restored) !== before[channel]) return refuse('VERIFICATION_FAILED', 'The source audio reversal changed decoded PCM values.');
            }
            reversedPcmSamples = decoded.channels.length * decoded.frames; omittedAudioFrames = decoded.decoder_omitted_frames;
            if (!await canEncodeAudio({ sampleRate: decoded.sampleRate, numberOfChannels: decoded.channels.length })) return refuse('AUDIO_ENCODER_UNAVAILABLE', 'The installed browser cannot encode reversed sound as AAC. Choose keep_audio:false for a silent video.');
            const NativeAudioEncoder = globalThis.AudioEncoder; let audioBytes = 0, audioFailed = false;
            class CheckedAudioEncoder extends NativeAudioEncoder {
              constructor(init) {
                let instance;
                super({ ...init, output: (chunk, metadata) => {
                  if (++encodedAudioPackets > Math.ceil(admitted.audio_plan.frames / 1024) + 4 || chunk.byteLength < 1 || chunk.byteLength > 65536
                      || (audioBytes += chunk.byteLength) > 16 * 2 ** 20 || metadata?.decoderConfig?.description && asBytes(metadata.decoderConfig.description).length > 16) {
                    audioFailed = true; budget.failure = 'AUDIO_ENCODE_LIMIT'; try { instance.close(); } catch {} return;
                  }
                  init.output(chunk, metadata);
                } }); instance = this;
              }
            }
            Object.defineProperty(CheckedAudioEncoder, 'isConfigSupported', { value: NativeAudioEncoder.isConfigSupported.bind(NativeAudioEncoder) });
            let sound;
            try { globalThis.AudioEncoder = CheckedAudioEncoder; sound = await encodeAudioTrack({ channels: decoded.channels, sampleRate: decoded.sampleRate }); }
            finally { globalThis.AudioEncoder = NativeAudioEncoder; for (const plane of decoded.channels) plane.fill(0); }
            if (audioFailed) return refuse('AUDIO_ENCODE_LIMIT', 'Reversed AAC exceeded its bounded output packet policy.');
            const { Mp4Writer } = await import('/vendor/abox/shared/js/mp4-writer.js'), picture = await demux(blob), writer = new Mp4Writer();
            const track = writer.addTrack({ kind: 'vide', timescale: picture.video.timescale, sampleEntry: picture.video.sampleEntry,
              matrix: picture.video.matrix, width: picture.video.trackWidth, height: picture.video.trackHeight });
            for (let at = 0; at < picture.video.samples.length; at++) { const sample = picture.video.samples[at], next = picture.video.samples[at + 1];
              track.addSample({ data: blob.slice(sample.offset, sample.offset + sample.size), isKey: sample.isKey, dts: sample.dts, pts: sample.pts, duration: (next?.dts ?? picture.video.duration) - sample.dts }); }
            const audio = writer.addTrack({ kind: 'soun', timescale: sound.timescale, sampleEntry: sound.sampleEntry }), origin = sound.samples[0].dts;
            for (const sample of sound.samples) audio.addSample({ data: sample.data, isKey: true, dts: sample.dts - origin, pts: sample.dts - origin, duration: sample.duration });
            blob = writer.finalize();
          }
        } else if (kind === 'bake') {
          const { rotate } = await import('/vendor/abox/tools/rotate-video/src/rotate.js'), { bakeBitrate } = await import('/vendor/abox/tools/rotate-video/src/plan.js'), { describeSound } = await import('/vendor/abox/shared/js/reencode-sound.js');
          const sound = settings.keep_audio && media.audio ? describeSound(media.audio) : null, sourceBitrate = video.samples.reduce((sum, sample) => sum + sample.size, 0) * 8 / admitted.duration;
          if (settings.keep_audio && media.audio && !sound?.copyable) return refuse('VIDEO_AUDIO_COPY_UNSUPPORTED', 'Baked rotation copies AAC only; omit other audio explicitly.');
          const frame = { width: admitted.output_width, height: admitted.output_height }, bitrate = bakeBitrate({ ...frame, fps: admitted.fps, sourceBitrate });
          const made = await rotate({ file, media, sound, turn: settings.degrees, bake: true, soundJob: sound ? 'copy' : 'none', bitrate, frame, fps: admitted.fps }); blob = made.blob; frames = made.frames;
        } else if (kind === 'crop') {
          const { cropExact } = await import('/vendor/abox/tools/crop-video/src/transcode.js');
          const made = await cropExact({ file, media, crop: admitted.crop, quality: settings.quality, keepAudio: settings.keep_audio }); blob = made.blob; frames = made.frames;
        } else {
          const { compress } = await import('/vendor/abox/tools/compress-video/src/encode.js'), { retune, fixedBytes } = await import('/vendor/abox/tools/compress-video/src/plan.js');
          let bitrate = admitted.compression.bitrate, made = await compress({ file, media, frame: admitted.compression.frame, bitrate, fps: admitted.fps, keepAudio: settings.keep_audio });
          if (made.blob.size > settings.target_bytes) { bitrate = retune(bitrate, made.blob.size, settings.target_bytes, fixedBytes(admitted.source, settings.keep_audio)); made = await compress({ file, media, frame: admitted.compression.frame, bitrate, fps: admitted.fps, keepAudio: settings.keep_audio }); }
          blob = made.blob; frames = made.frames; fitted = blob.size <= settings.target_bytes;
        }
        if (budget.failure) return refuse(budget.failure, 'Native video processing exceeded its admitted geometry, timestamp or byte policy.');
        if (!blob?.size || blob.size > maxBytes || !['frame', 'gif'].includes(kind) && frames !== admitted.expected_frames) return refuse('VERIFICATION_FAILED', 'Native processing did not produce every admitted video frame within the output policy.');
        globalThis.VideoDecoder = NativeDecoder; if (NativeEncoder) globalThis.VideoEncoder = NativeEncoder;
        let decodedFrames = 0;
        if (!['frame', 'gif'].includes(kind)) {
          const made = await demux(blob), track = made.video;
          if (track.codedWidth !== admitted.output_width || track.codedHeight !== admitted.output_height || track.rotation !== 0 || track.samples.length !== admitted.ticks.length || track.timescale !== 90000) return refuse('VERIFICATION_FAILED', 'The generated MP4 changed output geometry or sample count.');
          for (let index = 0; index < admitted.ticks.length; index++) if (track.samples[index].dts !== admitted.ticks[index] || track.samples[index].pts !== admitted.ticks[index]) return refuse('VERIFICATION_FAILED', 'The generated MP4 changed admitted presentation times.');
          if (track.duration !== admitted.ticks.at(-1) + admitted.tail) return refuse('VERIFICATION_FAILED', 'The generated MP4 changed its source-engine final-frame duration.');
          let decodeFailure = false; const expectedTimes = new Set(track.samples.map(sample => micros(sample.pts, track.timescale))), seen = new Set();
          outputDecoder = new NativeDecoder({ output: frame => { try { if (frame.displayWidth !== admitted.output_width || frame.displayHeight !== admitted.output_height || !expectedTimes.has(frame.timestamp) || seen.has(frame.timestamp)) decodeFailure = true; seen.add(frame.timestamp); } finally { frame.close(); } }, error: () => { decodeFailure = true; } });
          outputDecoder.configure(decoderConfig(track));
          for (const sample of track.samples) { await settle([outputDecoder], { limit: 2, stallAfter: 30000, stallKey: 'decode' }); if (decodeFailure) return refuse('VERIFICATION_FAILED', 'The generated MP4 failed native verification.');
            outputDecoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta', timestamp: micros(sample.pts, track.timescale), data: await blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer() })); }
          await outputDecoder.flush(); decodedFrames = seen.size;
          if (decodeFailure || decodedFrames !== admitted.expected_frames) return refuse('VERIFICATION_FAILED', 'The generated MP4 did not decode every admitted frame.');
        }
        const data = await new Promise((resolve, reject) => { const file = new FileReader(); file.onload = () => resolve(file.result.split(',')[1]); file.onerror = reject; file.readAsDataURL(blob); });
        return { data, frame_count: frames, fitted, width: kind === 'frame' ? admitted.width : admitted.output_width, height: kind === 'frame' ? admitted.height : admitted.output_height,
          ...(kind === 'reverse' ? { audio_reversed: Boolean(admitted.audio_plan), audio_decoder_omitted_frames: omittedAudioFrames } : {}),
          verification: { avc_all_samples: true, decoded_input_frames: budget.decoded, output_decoded_frames: decodedFrames, png_all_pixels: kind === 'frame',
            gif_quantized_composites: kind === 'gif', frame_timing: kind !== 'frame', ...(kind === 'reverse' ? { reversed_pcm_samples: reversedPcmSamples, encoded_audio_packets: encodedAudioPackets } : {}) } };
      } catch (error) {
        if (budget.failure) return refuse(budget.failure, 'Native video processing exceeded its admitted geometry, timestamp or byte policy.');
        if (['AUDIO_DECODER_UNAVAILABLE', 'AUDIO_DECODE_MISMATCH'].includes(error?.code)) return refuse(error.code, 'The admitted AAC track could not be decoded within its sample policy.');
        if (['encode.noh264', 'encode.toobig'].includes(error?.message)) return refuse('H264_UNAVAILABLE', 'The installed browser cannot encode H.264 at these settings.');
        return refuse('VIDEO_PROCESSING_FAILED', 'The installed browser could not decode, process or verify this bounded video. No output was written.');
      } finally {
        reader?.release(); if (canvas) canvas.width = canvas.height = 0; if (outputDecoder && outputDecoder.state !== 'closed') outputDecoder.close();
        globalThis.VideoDecoder = NativeDecoder; if (NativeEncoder) globalThis.VideoEncoder = NativeEncoder;
      }
    }, { kind, settings, admitted, maxBytes: MAX_DECODE_OUTPUT_BYTES });
  }, options);
}
async function verifyAudio(input, output, keep) {
  const before = (await parseVideoCopy(input)).media, after = (await parseVideoCopy(output, false)).media;
  if (!keep || !before.audio) { if (after.audio) verify(); return; }
  if (!after.audio || !equal(before.audio.sampleEntry, after.audio.sampleEntry) || before.audio.timescale !== after.audio.timescale
      || before.audio.duration !== after.audio.duration || before.audio.samples.length !== after.audio.samples.length) verify();
  for (let at = 0; at < before.audio.samples.length; at++) {
    const one = before.audio.samples[at], two = after.audio.samples[at];
    if (one.dts !== two.dts || one.pts !== two.pts || !equal(input.subarray(one.offset, one.offset + one.size), output.subarray(two.offset, two.offset + two.size))) verify();
  }
}
async function verifyReversedAudio(output, admitted, options) {
  const sound = await admitMp4Audio(output, options), before = admitted.audio_plan;
  if (sound.sample_rate !== before.sample_rate || sound.channels !== before.channels || sound.frames < before.frames || sound.frames > before.frames + 4096) verify();
  const plan = { codec: sound.codec, description: Array.from(sound.description), sample_rate: sound.sample_rate, channels: sound.channels,
    frames: sound.frames, packet_frames: sound.packet_frames, packets: sound.packets };
  const checked = await withBrowser(async page => {
    await page.evaluate(installAudioPacketDecoder); await page.locator('#input').setInputFiles({ name: 'reversed.mp4', mimeType: 'video/mp4', buffer: output });
    return page.evaluate(async plan => {
      try {
        const decoded = await globalThis.__aboxDecodeAudioPackets(document.querySelector('#input').files[0], plan);
        for (const plane of decoded.channels) plane.fill(0);
        return { frames: decoded.frames, omitted: decoded.decoder_omitted_frames };
      } catch { return null; }
    }, plan);
  }, options);
  if (!checked || checked.frames !== sound.frames) verify();
  return { audio_output_decoded: true, output_audio_frames: sound.frames, output_audio_decoder_omitted_frames: checked.omitted };
}
async function invoke(kind, args, options) {
  options.signal?.throwIfAborted(); const settings = settingsFor(kind, args), output = await newOutput(args.output_path), extension = path.extname(output).toLowerCase();
  const format = kind === 'frame' ? 'png' : kind === 'gif' ? 'gif' : 'mp4';
  if (extension !== `.${format}`) fail('OUTPUT_EXTENSION', 'Choose a new .mp4 video, .gif animation or .png frame matching the operation.');
  const crop = kind === 'crop' ? await cropConfig(args.crop_path) : null, input = await readInput(args.input_path, { max_bytes: MAX_VIDEO_INPUT_BYTES }); options.signal?.throwIfAborted();
  const admitted = await admitWorker(input.data, kind, settings, crop?.value, options), made = await processBrowser(input.data, kind, settings, admitted, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message); const data = Buffer.from(made.data, 'base64'); delete made.data;
  if (kind !== 'compress') delete made.fitted;
  if (!data.length || data.length > (format === 'mp4' ? MAX_DECODE_OUTPUT_BYTES : MAX_VIDEO_FRAME_BYTES)) fail('OUTPUT_SIZE', 'The processed video or frame exceeds its output policy.');
  if (kind === 'frame') {
    if (data.length < 33 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.readUInt32BE(16) !== made.width || data.readUInt32BE(20) !== made.height) verify();
  } else if (kind === 'gif') {
    const checked = await analyzeGifInput(data, options);
    if (checked.width !== made.width || checked.height !== made.height || checked.frame_count !== made.frame_count
        || checked.nominal_duration_seconds !== admitted.total_delay_cs / 100) verify();
  } else if (kind === 'reverse' && admitted.reverse_audio) Object.assign(made.verification, await verifyReversedAudio(data, admitted, options));
  else await verifyAudio(input.data, data, settings.keep_audio);
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: kind === 'frame' ? 'grab-video-frame' : kind === 'gif' ? 'video-to-gif' : kind === 'bake' ? 'bake-video-rotation' : `${kind}-video`, input_path: input.path, output_path: output,
    ...(crop ? { crop_path: crop.path } : {}), input_bytes: input.data.length, output_bytes: data.length, format, verified: true, ...made,
    avc_admission: admitted.avc, input_duration_seconds: admitted.duration, audio_copied: admitted.copy_audio,
    ...(kind === 'frame' ? { requested_time_seconds: settings.time_seconds, frame_time_seconds: admitted.frame_time_seconds, display_frame: admitted.frame_index + 1 }
      : { reencoded: true, audio_packet_bytes_verified: format === 'mp4' && !admitted.reverse_audio, output_duration_seconds: kind === 'gif' ? admitted.total_delay_cs / 100 : (admitted.ticks.at(-1) + admitted.tail) / 90000,
        ...(kind === 'compress' ? { target_bytes: settings.target_bytes } : {}), ...(kind === 'gif' ? { sampled_frames: admitted.expected_frames, loop: settings.loop }
          : kind === 'timelapse' ? { speed: settings.speed, fps: settings.fps } : kind === 'bake' ? { degrees: settings.degrees, baked_pixels: true } : {}) }),
    warnings: kind === 'frame' ? ['The PNG preserves the selected decoded frame pixels after the source orientation is applied. Codec decoding can differ across platforms; this does not establish source authenticity.']
      : kind === 'gif' ? ['The GIF samples admitted video frames, quantizes colors and uses centisecond timing. Identical palette frames can merge; every composited palette frame and total delay are verified. Audio and source metadata are omitted.']
      : ['Video is decoded and re-encoded as H.264. Color, chroma and final-frame timing can change. Container metadata and other tracks are omitted.',
        ...(admitted.reverse_audio ? [] : ['Selected copied audio packets remain byte-for-byte unchanged and are not decoded.']),
        ...(['reverse', 'timelapse'].includes(kind) ? [admitted.reverse_audio ? 'AAC sound is decoded, its PCM samples reversed exactly and re-encoded. AAC priming/padding and lossy encoding can change timing and sound; decoder omissions are reported.'
          : 'This output is silent. The source frame ordering/sampling engine determines the new presentation timeline.'] : []),
        ...(kind === 'compress' ? ['The target is an estimate with at most one source-engine retry. Check fitted; the output can be larger than the target or input.'] : [])] };
}
export const compressVideo = (args, options = {}) => invoke('compress', args, options);
export const cropVideo = (args, options = {}) => invoke('crop', args, options);
export const grabVideoFrame = (args, options = {}) => invoke('frame', args, options);
export const reverseVideo = (args, options = {}) => invoke('reverse', args, options);
export const timelapseVideo = (args, options = {}) => invoke('timelapse', args, options);
export const videoToGif = (args, options = {}) => invoke('gif', args, options);
export const bakeVideoRotation = (args, options = {}) => invoke('bake', args, options);
if (!isMainThread && workerData?.kind === 'abox-video-admit') {
  try { parentPort.postMessage({ result: await admission(Buffer.from(workerData.source), workerData.operation, workerData.settings, workerData.crop) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message } : { code: 'UNSUPPORTED_VIDEO', message: 'The video headers or selected operation could not be admitted. Source values are excluded from errors.' } }); }
  finally { parentPort.close(); }
}
