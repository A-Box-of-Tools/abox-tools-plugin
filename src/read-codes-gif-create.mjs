import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { AdapterError } from './errors.mjs';
import { MAX_INPUT_BYTES, localPath, newOutput, readInput, writeNew } from './files.mjs';

export const MAX_CODE_READ_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_CODE_READ_OUTPUT_BYTES = 64 * 1024;
export const MAX_CODE_READ_SIDE = 4096;
export const MAX_CODE_READ_PIXELS = 4_000_000;
export const MAX_GIF_CREATE_FRAMES = 32;
export const MAX_GIF_CREATE_SIDE = 1000;
export const MAX_GIF_CREATE_INPUT_SIDE = 4096;
export const MAX_GIF_CREATE_INPUT_PIXELS = 4_000_000;
export const MAX_GIF_CREATE_TOTAL_PIXELS = 16_000_000;
export const MAX_GIF_CREATE_OUTPUT_BYTES = 32 * 1024 * 1024;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const valueOr = (value, fallback) => value === undefined ? fallback : value;
const whole = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;

async function inputsFor(values, maxBytes, signal) {
  const paths = [];
  let total = 0;
  for (const value of values) {
    signal?.throwIfAborted();
    const filename = localPath(await realpath(localPath(value)));
    const info = await stat(filename);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Every input must be a regular local image file.');
    total += info.size;
    if (!info.size || total > maxBytes) throw new AdapterError('INPUT_SIZE', 'The combined image inputs exceed the operation byte limit or contain an empty file.');
    paths.push(filename);
  }
  const inputs = [];
  total = 0;
  for (const filename of paths) {
    signal?.throwIfAborted();
    const input = await readInput(filename, { max_bytes: maxBytes });
    total += input.data.length;
    if (total > maxBytes) throw new AdapterError('INPUT_SIZE', 'The combined image inputs grew beyond the operation byte limit.');
    const image = await supportedImage(input.data);
    if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
      throw new AdapterError('ANIMATED_IMAGE', 'Code reading and GIF creation accept still JPEG, PNG and WebP. Animated inputs are refused.');
    }
    const size = rasterInputDimensions(image);
    if (!size || !whole(size.width, 1, MAX_GIF_CREATE_INPUT_SIDE) || !whole(size.height, 1, MAX_GIF_CREATE_INPUT_SIDE)
        || size.width * size.height > MAX_GIF_CREATE_INPUT_PIXELS) {
      throw new AdapterError('IMAGE_DIMENSIONS', 'Each image must have consistent dimensions within 4096 pixels per side and 4 megapixels.');
    }
    inputs.push({ ...input, format: image.kind });
  }
  return { inputs, total };
}

async function loadFiles(page, inputs) {
  await page.locator('#input').evaluate(input => { input.multiple = true; });
  await page.locator('#input').setInputFiles(inputs.map((input, index) => ({
    name: `source-${index}.${input.format}`, mimeType: MIME[input.format], buffer: input.data,
  })));
}

export async function readCodeImage(args, options = {}) {
  options.signal?.throwIfAborted();
  const thorough = valueOr(args.thorough, true);
  if (typeof thorough !== 'boolean') throw new AdapterError('INVALID_ARGUMENTS', 'thorough must be a boolean.');
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.json') throw new AdapterError('OUTPUT_EXTENSION', 'Decoded code results must use a new .json output file.');
  const { inputs, total } = await inputsFor([args.input_path], MAX_CODE_READ_INPUT_BYTES, options.signal);
  const made = await withBrowser(async page => {
    await loadFiles(page, inputs);
    return page.evaluate(async ({ thorough, maxSide, maxPixels, maxBytes }) => {
      const { scan } = await import('/vendor/abox/tools/qr-barcode-reader/src/scan.js');
      const { decodeMatrix } = await import('/vendor/abox/tools/qr-barcode-reader/src/qr-decode.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      let decoded, canvas;
      try {
        decoded = await codecs.decode(document.querySelector('#input').files[0]);
        const { width, height } = decoded;
        if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maxSide) || width * height > maxPixels) {
          return refuse('IMAGE_DIMENSIONS', 'The decoded image exceeds 4096 pixels per side or 4 megapixels.');
        }
        canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(decoded.bitmap, 0, 0);
        codecs.release(decoded.bitmap); decoded = null;
        const found = scan(context.getImageData(0, 0, width, height), { thorough });
        const allowed = ['qr', 'code128', 'ean13', 'upca', 'upce', 'ean8', 'itf', 'itf14', 'code39'];
        let qr = null;
        if (found) {
          if (typeof found.text !== 'string' || !allowed.includes(found.symbology)) return refuse('VERIFICATION_FAILED', 'The reader returned an unsupported result shape.');
          if (found.kind === 'qr') {
            const check = decodeMatrix(found.dimension, found.modules);
            if (check.text !== found.text || check.version !== found.version || check.level !== found.level) {
              return refuse('VERIFICATION_FAILED', 'The sampled QR modules did not reproduce the reader result.');
            }
            qr = { version: found.version, level: found.level, mask: found.mask, corrected_codewords: found.corrections,
              eci: found.eci, gs1: found.gs1, structured_append: found.structuredAppend };
          }
        }
        // Only this bounded file receives the decoded value. It is never used
        // as an address, a browser action, a log message or a tool summary.
        const report = { found: Boolean(found), image: { width, height }, code_count: found ? 1 : 0,
          code: found ? { symbology: found.symbology, text: found.text, ...(qr ? { qr } : {}) } : null };
        const json = JSON.stringify(report, null, 2) + '\n';
        if (new TextEncoder().encode(json).length > maxBytes) return refuse('OUTPUT_SIZE', 'The decoded JSON exceeds the 64 KiB output limit.');
        return { json, found: Boolean(found), symbology: found?.symbology ?? null, width, height,
          verification: { reader_checks: Boolean(found), sampled_qr_modules: Boolean(qr), external_requests: false } };
      } catch { return refuse('CODE_READ_FAILED', 'The installed browser could not decode or scan this image. Decoded contents are excluded from errors.'); }
      finally {
        codecs.release(decoded?.bitmap);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }, { thorough, maxSide: MAX_CODE_READ_SIDE, maxPixels: MAX_CODE_READ_PIXELS, maxBytes: MAX_CODE_READ_OUTPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.json, 'utf8'); delete made.json;
  if (!data.length || data.length > MAX_CODE_READ_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The decoded JSON exceeds the 64 KiB output limit.');
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'read-code-image', input_path: inputs[0].path, output_path: output,
    input_bytes: total, output_bytes: data.length, format: 'json', code_count: made.found ? 1 : 0,
    verified: made.found, ...made, warnings: [
      'Decoded values are saved only in the local JSON file. They may contain passwords, network credentials or unsafe links; nothing is opened.',
      'The existing reader returns at most one QR or supported linear barcode per image. A missing result does not prove the image contains no code.',
    ] };
}

function gifSettings(args) {
  const settings = { delay_ms: valueOr(args.delay_ms, 500), max_side: valueOr(args.max_side, 480),
    fit: valueOr(args.fit, 'contain'), background: valueOr(args.background, '#ffffff'), colors: valueOr(args.colors, 256),
    dither: valueOr(args.dither, true), shared_palette: valueOr(args.shared_palette, false),
    transparent: valueOr(args.transparent, false), loop: valueOr(args.loop, 'forever') };
  if (!Array.isArray(args.input_paths) || args.input_paths.length < 1 || args.input_paths.length > MAX_GIF_CREATE_FRAMES
      || !whole(settings.delay_ms, 20, 60000) || !whole(settings.max_side, 16, MAX_GIF_CREATE_SIDE)
      || !['contain', 'cover', 'stretch'].includes(settings.fit) || !whole(settings.colors, 4, 256)
      || typeof settings.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.background)
      || ['dither', 'shared_palette', 'transparent'].some(key => typeof settings[key] !== 'boolean')
      || !['forever', 'once', 'count'].includes(settings.loop)
      || (settings.loop === 'count' ? !whole(args.loop_count, 1, 65535) : args.loop_count !== undefined)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose 1–32 still images, 20–60000 ms frame delays, 16–1000 pixel dimensions, 4–256 colors, supported fit/loop settings and boolean palette options. A count loop needs loop_count from 1 to 65535.');
  }
  const custom = args.width !== undefined || args.height !== undefined;
  if (custom && (!whole(args.width, 16, MAX_GIF_CREATE_SIDE) || !whole(args.height, 16, MAX_GIF_CREATE_SIDE) || args.max_side !== undefined)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Custom GIF dimensions require both width and height from 16 to 1000; max_side applies only to automatic sizing.');
  }
  if (args.delays_ms !== undefined && (!Array.isArray(args.delays_ms) || args.delays_ms.length !== args.input_paths.length
      || args.delays_ms.some(value => !whole(value, 20, 60000)))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'delays_ms must contain exactly one whole 20–60000 ms value per input image.');
  }
  return { ...settings, width: custom ? args.width : null, height: custom ? args.height : null,
    delays_ms: args.delays_ms ?? args.input_paths.map(() => settings.delay_ms),
    loop_count: settings.loop === 'count' ? args.loop_count : null };
}

export async function createGif(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = gifSettings(args);
  if (settings.width !== null && settings.width * settings.height * args.input_paths.length > MAX_GIF_CREATE_TOTAL_PIXELS) {
    throw new AdapterError('GIF_PIXEL_LIMIT', 'The GIF may contain at most 16 million output frame pixels in total.');
  }
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.gif') throw new AdapterError('OUTPUT_EXTENSION', 'Created animations must use a new .gif output file.');
  const { inputs, total } = await inputsFor(args.input_paths, MAX_INPUT_BYTES, options.signal);
  const made = await withBrowser(async page => {
    await loadFiles(page, inputs);
    return page.evaluate(async ({ settings, maxInputSide, maxInputPixels, maxTotalPixels, maxBytes }) => {
      const { encodeGif, loopValue } = await import('/vendor/abox/tools/gif-maker/src/encode.js');
      const { drawFrame, resolveOutputSize } = await import('/vendor/abox/tools/gif-maker/src/compose.js');
      const { frameDelays } = await import('/vendor/abox/tools/gif-maker/src/images.js');
      const { createHistogram, addToHistogram, buildPalette, mapFrame } = await import('/vendor/abox/tools/gif-maker/src/quantize.js');
      const { parseGif, frameData } = await import('/vendor/abox/tools/gif-analyzer/src/gif.js');
      const { lzwDecode } = await import('/vendor/abox/tools/gif-analyzer/src/lzw.js');
      const { decodeGif } = await import('/vendor/abox/shared/js/gif-decode.js');
      const { patchPixels, GifCanvas } = await import('/vendor/abox/shared/js/gif-compose.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      const files = Array.from(document.querySelector('#input').files), items = [];
      let active, canvas;
      try {
        for (const [index, file] of files.entries()) {
          active = await codecs.decode(file);
          const { width, height } = active;
          if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maxInputSide) || width * height > maxInputPixels) {
            return refuse('IMAGE_DIMENSIONS', 'Each decoded input must fit within 4096 pixels per side and 4 megapixels.');
          }
          items.push({ file, width, height, delay: settings.delays_ms[index] / 1000 });
          codecs.release(active.bitmap); active = null;
        }
        const size = settings.width === null ? resolveOutputSize(String(settings.max_side), items)
          : resolveOutputSize('custom', items, { width: settings.width, height: settings.height });
        if (size.width * size.height * items.length > maxTotalPixels) return refuse('GIF_PIXEL_LIMIT', 'The GIF may contain at most 16 million output frame pixels in total.');
        const delays = frameDelays(items), loop = loopValue(settings.loop === 'count' ? 'times' : settings.loop, settings.loop_count);
        const sourceSettings = { ...size, fit: settings.fit, background: settings.background, colors: settings.colors,
          dither: settings.dither, sharedPalette: settings.shared_palette, transparent: settings.transparent, loop };
        const encoded = await encodeGif({ items, settings: sourceSettings });
        if (encoded.width !== size.width || encoded.height !== size.height || encoded.frames !== items.length
            || encoded.blob.type !== 'image/gif' || !encoded.blob.size || encoded.blob.size > maxBytes) {
          return refuse('OUTPUT_SIZE', 'The GIF encoder returned an unsupported result or exceeded 32 MiB.');
        }
        const bytes = new Uint8Array(await encoded.blob.arrayBuffer()), gif = parseGif(bytes);
        if (gif.truncated || gif.trailerAt !== bytes.length - 1 || gif.problems.length || gif.width !== size.width || gif.height !== size.height
            || gif.frames.length !== items.length || gif.loop !== loop || Boolean(gif.globalPalette) !== settings.shared_palette) {
          return refuse('VERIFICATION_FAILED', 'The generated GIF did not retain its expected dimensions, order, timing or loop structure.');
        }
        // The analyzer reads through EOI rather than stopping at the declared
        // rectangle. Its strict result precedes the separate playback decoder.
        for (const [index, frame] of gif.frames.entries()) {
          if (frame.left !== 0 || frame.top !== 0 || frame.width !== size.width || frame.height !== size.height || frame.interlaced
              || frame.delay !== delays[index] || frame.disposal !== (settings.transparent ? 2 : 1)
              || frame.transparentIndex !== (settings.transparent ? 0 : -1) || frame.localPalette === settings.shared_palette) {
            return refuse('VERIFICATION_FAILED', 'A generated GIF frame has unexpected timing, geometry, palette or disposal fields.');
          }
          const compressed = frameData(bytes, frame), decoded = lzwDecode(compressed, frame.minCodeSize, size.width * size.height);
          const palette = frame.palette ?? gif.globalPalette;
          if (!decoded.complete || decoded.truncated || decoded.corrupt || decoded.overrun || decoded.bytesRead !== compressed.length
              || decoded.pixels !== size.width * size.height || decoded.indices.some(value => value >= palette.count)) {
            return refuse('VERIFICATION_FAILED', 'A generated GIF frame failed complete LZW and palette validation.');
          }
        }
        const played = decodeGif(bytes, { maxPixels: maxTotalPixels, strictMaxPixels: true });
        if (played.truncated || played.frames.length !== items.length) return refuse('VERIFICATION_FAILED', 'The playback decoder did not read every generated frame.');
        canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const pixelsFor = async item => {
          active = await codecs.decode(item.file);
          try { drawFrame(context, active.bitmap, { fit: settings.fit, background: settings.transparent ? null : settings.background }); }
          finally { codecs.release(active.bitmap); active = null; }
          return context.getImageData(0, 0, size.width, size.height).data;
        };
        const reserved = settings.transparent ? 1 : 0, wanted = Math.max(2, settings.colors - reserved);
        const reserve = palette => {
          if (!reserved) return palette;
          const result = new Uint8Array(palette.length + 3); result.set(palette, 3); return result;
        };
        let shared = null;
        if (settings.shared_palette) {
          const histogram = createHistogram();
          for (const item of items) addToHistogram(histogram, await pixelsFor(item), settings.transparent);
          shared = reserve(buildPalette(histogram, wanted));
        }
        const compositor = new GifCanvas(played);
        let verifiedPixels = 0;
        for (const [index, item] of items.entries()) {
          const rgba = await pixelsFor(item);
          const palette = shared ?? reserve(buildPalette(addToHistogram(createHistogram(), rgba, settings.transparent), wanted));
          const actualPalette = (gif.frames[index].palette ?? gif.globalPalette).colors;
          if (actualPalette.length < palette.length || actualPalette.some((value, at) => value !== (palette[at] ?? 0))) {
            return refuse('VERIFICATION_FAILED', 'The GIF palette did not match the requested source color quantization.');
          }
          const indices = mapFrame(rgba, size.width, size.height, palette, { dither: settings.dither, from: reserved,
            transparentIndex: settings.transparent ? 0 : -1 });
          const frame = played.frames[index], stored = patchPixels(frame), composited = compositor.next().pixels;
          if (frame.partial || frame.indices.length !== indices.length) return refuse('VERIFICATION_FAILED', 'The playback decoder returned incomplete generated pixels.');
          for (let pixel = 0, at = 0; pixel < indices.length; pixel++, at += 4) {
            const transparent = settings.transparent && indices[pixel] === 0;
            for (let channel = 0; channel < 4; channel++) {
              const expected = channel === 3 ? transparent ? 0 : 255 : transparent ? 0 : palette[indices[pixel] * 3 + channel];
              if (stored[at + channel] !== expected || composited[at + channel] !== expected) {
                return refuse('VERIFICATION_FAILED', 'The generated GIF pixels did not match the quantized frames and disposal behavior.');
              }
            }
          }
          verifiedPixels += indices.length;
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('output-read')); reader.readAsDataURL(encoded.blob);
        });
        return { data, width: size.width, height: size.height, frame_count: items.length, delays_cs: delays,
          encoded_loop_count: loop, duration_seconds: delays.reduce((sum, delay) => sum + delay, 0) / 100,
          verification: { container_structure: true, lzw_end_codes: true, frame_timing: true,
            palette_pixels: verifiedPixels, composited_pixels: verifiedPixels } };
      } catch { return refuse('GIF_CREATE_FAILED', 'The installed browser could not decode, quantize, encode or verify these frames. No output was written.'); }
      finally {
        codecs.release(active?.bitmap);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }, { settings, maxInputSide: MAX_GIF_CREATE_INPUT_SIDE, maxInputPixels: MAX_GIF_CREATE_INPUT_PIXELS,
      maxTotalPixels: MAX_GIF_CREATE_TOTAL_PIXELS, maxBytes: MAX_GIF_CREATE_OUTPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64'); delete made.data;
  if (data.length < 14 || data.length > MAX_GIF_CREATE_OUTPUT_BYTES || data.toString('ascii', 0, 6) !== 'GIF89a'
      || data.readUInt16LE(6) !== made.width || data.readUInt16LE(8) !== made.height || data.at(-1) !== 0x3b) {
    throw new AdapterError('VERIFICATION_FAILED', 'The generated GIF bytes did not match the verified result.');
  }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'create-gif', input_paths: inputs.map(input => input.path), output_path: output,
    input_bytes: total, output_bytes: data.length, format: 'gif', fit: settings.fit, colors: settings.colors,
    dither: settings.dither, shared_palette: settings.shared_palette, transparent: settings.transparent,
    background: settings.transparent ? null : settings.background, loop: settings.loop, verified: true, ...made,
    warnings: ['GIF quantizes colors to a palette and retains only one-bit transparency. Resizing, color conversion, dithering and centisecond timing can change the source appearance; metadata is not copied.',
      'Each source image becomes one full frame in the requested order. Transparent frames restore to transparent background; a numeric GIF loop count has player-dependent repetition semantics.'] };
}
