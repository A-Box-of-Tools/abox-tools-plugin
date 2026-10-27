import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { analyzeGifInput } from './gif.mjs';
import { preflightMp4 } from './video-copy.mjs';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { MAX_INPUT_BYTES, localPath, readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_VIDEO_CREATE_IMAGES = 32;
export const MAX_VIDEO_CREATE_GIF_FRAMES = 200;
export const MAX_VIDEO_CREATE_GIF_BYTES = 32 * 1024 * 1024;
export const MAX_VIDEO_CREATE_GIF_PATCH_PIXELS = 32_000_000;
export const MAX_VIDEO_CREATE_SIDE = 1920;
export const MAX_VIDEO_CREATE_PIXELS = 1920 * 1080;
export const MAX_VIDEO_CREATE_FRAMES = 1800;
export const MAX_VIDEO_CREATE_SECONDS = 60;
export const MAX_VIDEO_CREATE_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4_000_000;
const MAX_IMAGE_SIDE = 4096;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const get = (value, fallback) => value === undefined ? fallback : value;
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const FPS = [1, 2, 5, 10, 15, 24, 25, 30];

function imageSettings(args) {
  const settings = { width: get(args.width, 1280), height: get(args.height, 720), fps: get(args.fps, 30),
    duration_ms: get(args.duration_ms, 1000), fit: get(args.fit, 'contain'), background: get(args.background, '#ffffff'),
    quality: get(args.quality, 'medium') };
  if (!Array.isArray(args.input_paths) || !integer(args.input_paths.length, 1, MAX_VIDEO_CREATE_IMAGES)
      || !integer(settings.width, 16, MAX_VIDEO_CREATE_SIDE) || !integer(settings.height, 16, MAX_VIDEO_CREATE_SIDE)
      || settings.width % 2 || settings.height % 2 || settings.width * settings.height > MAX_VIDEO_CREATE_PIXELS
      || !FPS.includes(settings.fps) || !integer(settings.duration_ms, 20, 60000)
      || !['contain', 'cover', 'blur', 'stretch'].includes(settings.fit) || !color(settings.background)
      || !['low', 'medium', 'high'].includes(settings.quality)
      || (args.durations_ms !== undefined && (!Array.isArray(args.durations_ms) || args.durations_ms.length !== args.input_paths.length
        || args.durations_ms.some(value => !integer(value, 20, 60000))))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose 1–32 still images, even output dimensions within 1920 per side and 1080p pixels, supported FPS/fit/quality, and exact per-image 20–60000 ms durations.');
  }
  const durations = args.durations_ms ?? args.input_paths.map(() => settings.duration_ms);
  const frames = durations.map(value => Math.max(1, Math.round(value * settings.fps / 1000)));
  const frameCount = frames.reduce((sum, value) => sum + value, 0);
  if (frameCount > MAX_VIDEO_CREATE_FRAMES || frameCount / settings.fps > MAX_VIDEO_CREATE_SECONDS) {
    throw new AdapterError('VIDEO_TIMELINE_LIMIT', 'The rounded slideshow may contain at most 1800 frames and 60 seconds.');
  }
  return { ...settings, durations_ms: durations, frame_counts: frames, frame_count: frameCount };
}

async function imageInputs(values, signal) {
  const paths = []; let total = 0;
  for (const value of values) {
    signal?.throwIfAborted(); const filename = localPath(await realpath(localPath(value))), info = await stat(filename);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Each slideshow source must be a regular local image file.');
    total += info.size;
    if (!info.size || total > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'Slideshow inputs must total 1 byte to 128 MiB.');
    paths.push(filename);
  }
  const inputs = []; total = 0;
  for (const filename of paths) {
    signal?.throwIfAborted(); const input = await readInput(filename); total += input.data.length;
    if (total > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'Slideshow inputs grew beyond 128 MiB.');
    const image = await supportedImage(input.data), size = rasterInputDimensions(image);
    if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
      throw new AdapterError('ANIMATED_IMAGE', 'Slideshows accept still JPEG, PNG and WebP images. Use GIF conversion for GIF animation.');
    }
    if (!size || !integer(size.width, 1, MAX_IMAGE_SIDE) || !integer(size.height, 1, MAX_IMAGE_SIDE) || size.width * size.height > MAX_IMAGE_PIXELS) {
      throw new AdapterError('IMAGE_DIMENSIONS', 'Each slideshow source must have consistent dimensions within 4096 pixels per side and 4 megapixels.');
    }
    inputs.push({ ...input, kind: image.kind });
  }
  return { inputs, total };
}

function gifAdmission(analysis) {
  const { width, height } = analysis;
  const evenWidth = width + width % 2, evenHeight = height + height % 2;
  if (!analysis.container_complete || !analysis.byte_budget.matches || analysis.trailing_bytes
      || !integer(width, 1, MAX_VIDEO_CREATE_SIDE) || !integer(height, 1, MAX_VIDEO_CREATE_SIDE)
      || evenWidth > MAX_VIDEO_CREATE_SIDE || evenHeight > MAX_VIDEO_CREATE_SIDE || evenWidth * evenHeight > MAX_VIDEO_CREATE_PIXELS
      || !integer(analysis.frame_count, 1, MAX_VIDEO_CREATE_GIF_FRAMES)
      || analysis.frames.some(frame => frame.width * frame.height > MAX_VIDEO_CREATE_PIXELS)
      || analysis.decoded_patch_pixels > MAX_VIDEO_CREATE_GIF_PATCH_PIXELS) {
    throw new AdapterError('GIF_VIDEO_LIMIT', 'GIF conversion requires a complete container, at most 200 frames, 1080p output pixels, and 32 million decoded patch pixels.');
  }
  if (!(analysis.played_duration_seconds > 0) || analysis.played_duration_seconds > MAX_VIDEO_CREATE_SECONDS) {
    throw new AdapterError('VIDEO_TIMELINE_LIMIT', 'A GIF playback cycle may contain at most 60 seconds.');
  }
}

async function renderVideo(kind, inputs, settings, analysis, options) {
  return withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(inputs.map((input, index) => ({ name: `source-${index}.${input.kind}`, mimeType: MIME[input.kind], buffer: input.data })));
    return page.evaluate(async ({ kind, settings, analysis, maxBytes, maxFrames, maxPixels, maxSide, maxImagePixels, maxGifPixels }) => {
      const refuse = (code, message) => ({ error: { code, message } });
      if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') {
        return refuse('H264_UNAVAILABLE', 'The installed browser must support local H.264 encoding and decoding. No recorder or network fallback is used.');
      }
      const NativeEncoder = globalThis.VideoEncoder;
      const budget = { bytes: 0, frames: 0, exceeded: false, config: null };
      const failBudget = () => { budget.exceeded = true; };
      class BoundedEncoder extends NativeEncoder {
        constructor(init) {
          let instance;
          super({ ...init, output: (chunk, metadata) => {
            const raw = metadata?.decoderConfig?.description;
            const config = raw && (ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw));
            if (budget.exceeded || !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > 16 * 1024 * 1024
                || budget.bytes + chunk.byteLength > maxBytes - 2 * 1024 * 1024 || ++budget.frames > maxFrames
                || (config && config.byteLength > 1024 * 1024)
                || (config && budget.config && (config.length !== budget.config.length || config.some((value, index) => value !== budget.config[index])))) {
              failBudget(); try { instance.close(); } catch {} return;
            }
            budget.bytes += chunk.byteLength;
            if (config && !budget.config) budget.config = Uint8Array.from(config);
            init.output(chunk, metadata);
          } });
          instance = this;
        }
      }
      Object.defineProperty(BoundedEncoder, 'isConfigSupported', { value: NativeEncoder.isConfigSupported.bind(NativeEncoder) });
      globalThis.VideoEncoder = BoundedEncoder;
      let decoder;
      try {
        const codecs = await import('/vendor/abox/shared/js/image-convert.js');
        const files = Array.from(document.querySelector('#input').files);
        let encoded, durations, width, height;
        if (kind === 'images') {
          const { encodeToMp4, countFrames } = await import('/vendor/abox/tools/images-to-video/src/encoder.js');
          const items = [];
          for (const [index, file] of files.entries()) {
            const decoded = await codecs.decode(file);
            try {
              if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1
                  || decoded.width > 4096 || decoded.height > 4096 || decoded.width * decoded.height > maxImagePixels) {
                return refuse('IMAGE_DIMENSIONS', 'A decoded slideshow source exceeds 4096 pixels per side or 4 megapixels.');
              }
              items.push({ file, width: decoded.width, height: decoded.height, duration: settings.durations_ms[index] / 1000 });
            } finally { codecs.release(decoded.bitmap); }
          }
          if (countFrames(items, settings.fps) !== settings.frame_count) return refuse('VERIFICATION_FAILED', 'The source slideshow timeline differs from the admitted frame count.');
          ({ width, height } = settings);
          durations = Array(settings.frame_count).fill(1 / settings.fps);
          encoded = await encodeToMp4({ items, settings });
        } else {
          const { gifToMp4 } = await import('/vendor/abox/tools/gif-to-mp4/src/encode.js');
          const { outputSize, frameTimes, nominalFps, bitrateFor, parseHex } = await import('/vendor/abox/tools/gif-to-mp4/src/plan.js');
          const { gifWorkingPlan, sourceCopies } = await import('/vendor/abox/tools/gif-to-mp4/src/working.js');
          const { decodeGif } = await import('/vendor/abox/shared/js/gif-decode.js');
          const bytes = new Uint8Array(await files[0].arrayBuffer()), size = outputSize(analysis);
          ({ width, height } = size);
          if (width > maxSide || height > maxSide || width * height > maxPixels || size.scale !== 1) return refuse('GIF_VIDEO_LIMIT', 'The GIF output exceeds the supported 1080p geometry.');
          const metadata = { width: analysis.width, height: analysis.height, frames: analysis.frames.map(frame => ({ disposal: frame.disposal })) };
          const extraIndex = Math.max(0, ...analysis.frames.filter(frame => frame.interlaced).map(frame => frame.width * frame.height));
          const extraData = Math.max(0, ...analysis.frames.map(frame => frame.compressed_bytes));
          const admission = gifWorkingPlan(metadata, size, { copies: sourceCopies(metadata),
            retainedBytes: bytes.byteLength + analysis.decoded_patch_pixels + extraIndex + extraData,
            chunkBytes: maxBytes * 2 + 2 * 1024 * 1024 });
          if (!admission.fits) return refuse('GIF_WORKING_LIMIT', 'The GIF exceeds the source encoder’s 512 MiB estimated working-buffer policy.');
          const gif = decodeGif(bytes, { maxPixels: maxGifPixels, strictMaxPixels: true });
          if (gif.truncated || gif.width !== analysis.width || gif.height !== analysis.height || gif.frames.length !== analysis.frame_count
              || gif.loopCount !== analysis.loop_count || gif.frames.some((frame, index) => {
                const expected = analysis.frames[index];
                return frame.partial || frame.width !== expected.width || frame.height !== expected.height || frame.x !== expected.x || frame.y !== expected.y
                  || frame.delay !== expected.delay_cs || frame.disposal !== expected.disposal || frame.transparentIndex !== expected.transparent_index
                  || frame.palette.length !== expected.palette_entries * 3 || frame.indices.length !== frame.width * frame.height
                  || frame.indices.some(value => value >= expected.palette_entries);
              })) return refuse('INVALID_GIF_PIXELS', 'The GIF playback decoder disagreed with the admitted complete source frames.');
          const timeline = frameTimes(gif.frames), fps = nominalFps(gif.frames);
          durations = timeline.times.map(time => time.duration);
          const bitrate = settings.bitrate ?? bitrateFor({ width, height, fps });
          encoded = await gifToMp4({ gif, size, fps, bitrate, background: parseHex(settings.background) });
        }
        if (budget.exceeded) return refuse('VIDEO_ENCODE_LIMIT', 'H.264 output exceeded its pre-copy chunk, sample or configuration budget.');
        if (encoded.extension !== undefined && encoded.extension !== 'mp4' || !encoded.blob.size || encoded.blob.size > maxBytes) {
          return refuse('OUTPUT_SIZE', 'The encoded video exceeds 128 MiB or has an unsupported container.');
        }
        const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js');
        const { decoderConfig, micros, settle } = await import('/vendor/abox/shared/js/webcodecs.js');
        const media = await demux(encoded.blob), video = media.video, ticks = durations.map(duration => Math.max(1, Math.round(duration * 90000)));
        if (media.audio || video.codec.split('.')[0] !== 'avc1' || video.codedWidth !== width || video.codedHeight !== height
            || video.timescale !== 90000 || video.samples.length !== ticks.length || budget.frames !== ticks.length) {
          return refuse('VERIFICATION_FAILED', 'The generated MP4 geometry, codec, track or frame count changed.');
        }
        let clock = 0;
        for (let index = 0; index < ticks.length; index++) {
          if (video.samples[index].dts !== clock || video.samples[index].pts !== clock) return refuse('VERIFICATION_FAILED', 'The generated MP4 changed the admitted frame timeline.');
          clock += ticks[index];
        }
        if (video.duration !== clock) return refuse('VERIFICATION_FAILED', 'The generated MP4 duration differs from its complete frame timeline.');
        const expectedTimes = new Set(video.samples.map(sample => micros(sample.pts, video.timescale))), seen = new Set();
        let decodeFailure = false;
        decoder = new VideoDecoder({ output: frame => {
          try {
            if (frame.displayWidth !== width || frame.displayHeight !== height || !expectedTimes.has(frame.timestamp) || seen.has(frame.timestamp)) decodeFailure = true;
            seen.add(frame.timestamp);
          } finally { frame.close(); }
        }, error: () => { decodeFailure = true; } });
        const config = decoderConfig(video), supported = await VideoDecoder.isConfigSupported(config);
        if (!supported.supported) return refuse('H264_UNAVAILABLE', 'The installed browser cannot decode its generated H.264 output for verification.');
        decoder.configure(config);
        for (const sample of video.samples) {
          await settle([decoder], { limit: 2, stallAfter: 30000, stallKey: 'decode-stalled' });
          if (decodeFailure) return refuse('VERIFICATION_FAILED', 'The generated H.264 output could not be decoded consistently.');
          decoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta', timestamp: micros(sample.pts, video.timescale),
            data: await encoded.blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer() }));
        }
        await decoder.flush();
        if (decodeFailure || seen.size !== ticks.length) return refuse('VERIFICATION_FAILED', 'The browser did not decode every generated video frame at its admitted time.');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('output-read')); reader.readAsDataURL(encoded.blob);
        });
        return { data, width, height, frame_count: ticks.length, duration_seconds: clock / 90000, ticks, codec: encoded.codec,
          verification: { geometry: true, frame_timing: true, decoded_frames: seen.size, encoded_chunk_bytes: budget.bytes, audio: false } };
      } catch (error) {
        if (budget.exceeded) return refuse('VIDEO_ENCODE_LIMIT', 'H.264 output exceeded its pre-copy chunk, sample or configuration budget.');
        if (error?.message === 'encode.noh264') return refuse('H264_UNAVAILABLE', 'The installed browser cannot encode H.264 at the requested settings. No recorder or network fallback is used.');
        return refuse('VIDEO_CREATE_FAILED', 'The installed browser could not render, encode or verify this local video. No output was written.');
      } finally {
        if (decoder && decoder.state !== 'closed') decoder.close();
        globalThis.VideoEncoder = NativeEncoder;
      }
    }, { kind, settings, analysis, maxBytes: MAX_VIDEO_CREATE_OUTPUT_BYTES, maxFrames: MAX_VIDEO_CREATE_FRAMES,
      maxSide: MAX_VIDEO_CREATE_SIDE, maxPixels: MAX_VIDEO_CREATE_PIXELS, maxImagePixels: MAX_IMAGE_PIXELS, maxGifPixels: MAX_VIDEO_CREATE_GIF_PATCH_PIXELS });
  }, options);
}

async function writeVideo(kind, inputs, total, output, settings, analysis, options) {
  const made = await renderVideo(kind, inputs, settings, analysis, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64'); delete made.data;
  if (!data.length || data.length > MAX_VIDEO_CREATE_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The video exceeds 128 MiB.');
  preflightMp4(data);
  const media = await demux(new File([data], 'created.mp4', { type: 'video/mp4' }));
  let clock = 0;
  if (media.audio || media.video.codedWidth !== made.width || media.video.codedHeight !== made.height
      || media.video.samples.length !== made.ticks.length || media.video.timescale !== 90000) {
    throw new AdapterError('VERIFICATION_FAILED', 'The MP4 file did not retain the verified generated track.');
  }
  for (let index = 0; index < made.ticks.length; index++) {
    if (media.video.samples[index].dts !== clock || media.video.samples[index].pts !== clock) throw new AdapterError('VERIFICATION_FAILED', 'The saved MP4 frame times changed.');
    clock += made.ticks[index];
  }
  if (media.video.duration !== clock) throw new AdapterError('VERIFICATION_FAILED', 'The saved MP4 duration changed.');
  delete made.ticks;
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: kind === 'images' ? 'images-to-video' : 'gif-to-mp4', input_paths: inputs.map(input => input.path),
    output_path: output, input_bytes: total, output_bytes: data.length, format: 'mp4', verified: true, ...made,
    background: settings.background, ...(kind === 'images' ? { image_count: inputs.length, fps: settings.fps, fit: settings.fit, quality: settings.quality } : { gif_frames: analysis.frame_count, loop_cycles: 1 }),
    warnings: ['The output is a newly encoded, silent H.264 video. Lossy color conversion, chroma subsampling and timing quantization can change the source; metadata is not copied.',
      ...(kind === 'gif' ? ['GIF frame delays follow the website browser-playback model. One cycle is exported; GIF loop metadata is not repeated, and odd dimensions receive background padding.'] : [])] };
}

async function outputPath(value) {
  const output = await newOutput(value);
  if (path.extname(output).toLowerCase() !== '.mp4') throw new AdapterError('OUTPUT_EXTENSION', 'Created video output must use a new .mp4 path.');
  return output;
}

export async function imagesToVideo(args, options = {}) {
  options.signal?.throwIfAborted(); const settings = imageSettings(args), output = await outputPath(args.output_path);
  const { inputs, total } = await imageInputs(args.input_paths, options.signal);
  return writeVideo('images', inputs, total, output, settings, null, options);
}

export async function gifToVideo(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = { background: get(args.background, '#ffffff'), bitrate: args.bitrate };
  if (!color(settings.background) || (settings.bitrate !== undefined && !integer(settings.bitrate, 400000, 20000000))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Use a six-digit background color and an optional whole bitrate from 400000 to 20000000 bits per second.');
  }
  const output = await outputPath(args.output_path), input = await readInput(args.input_path, { max_bytes: MAX_VIDEO_CREATE_GIF_BYTES });
  const analysis = await analyzeGifInput(input.data, { ...options, verify_lzw: false });
  gifAdmission(analysis);
  await analyzeGifInput(input.data, options);
  options.signal?.throwIfAborted();
  return writeVideo('gif', [{ ...input, kind: 'gif' }], input.data.length, output, settings, analysis, options);
}
