import path from 'node:path';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { MAX_INPUT_BYTES, readInput, newOutput, writeNew } from './files.mjs';
import { MAX_IMAGE_PIXELS } from './image.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { AdapterError } from './errors.mjs';

export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function settings(args) {
  const sizes = args.sizes ?? [16, 32, 48, 256];
  const fit = args.fit ?? 'pad';
  const storage = args.storage ?? 'auto';
  const background = args.background ?? null;
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > ICO_SIZES.length
      || sizes.some(size => !ICO_SIZES.includes(size)) || new Set(sizes).size !== sizes.length
      || !['pad', 'crop', 'stretch'].includes(fit) || !['auto', 'png', 'bmp'].includes(storage)
      || (background !== null && (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose unique supported icon sizes, pad/crop/stretch fit, auto/png/bmp storage, and an optional six-digit background color.');
  }
  return { sizes: [...sizes].sort((a, b) => a - b), fit, storage, background };
}

function verifyDirectory(bytes, sizes, storage) {
  const fail = () => { throw new AdapterError('VERIFICATION_FAILED', 'The icon directory or an embedded frame did not match the requested output.'); };
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1
      || bytes.readUInt16LE(4) !== sizes.length) fail();
  let offset = 6 + sizes.length * 16;
  if (offset > bytes.length) fail();
  const entries = sizes.map((size, index) => {
    const at = 6 + index * 16;
    const length = bytes.readUInt32LE(at + 8);
    const start = bytes.readUInt32LE(at + 12);
    if ((bytes[at] || 256) !== size || (bytes[at + 1] || 256) !== size || bytes[at + 2] !== 0
        || bytes[at + 3] !== 0 || bytes.readUInt16LE(at + 4) !== 1 || bytes.readUInt16LE(at + 6) !== 32
        || start !== offset || !length || start + length > bytes.length) fail();
    const data = bytes.subarray(start, start + length);
    const kind = storage === 'auto' ? (size > 64 ? 'png' : 'bmp') : storage;
    if (kind === 'png') {
      if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size) fail();
    } else {
      const expected = 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size;
      if (data.length !== expected || data.readUInt32LE(0) !== 40 || data.readInt32LE(4) !== size
          || data.readInt32LE(8) !== size * 2 || data.readUInt16LE(12) !== 1 || data.readUInt16LE(14) !== 32
          || data.readUInt32LE(16) !== 0 || data.readUInt32LE(20) !== expected - 40) fail();
    }
    offset += length;
    return { width: size, height: size, kind, bytes: length };
  });
  if (offset !== bytes.length) fail();
  return entries;
}

export async function imageToIco(args, options = {}) {
  options.signal?.throwIfAborted();
  const plan = settings(args);
  const input = await readInput(args.input_path);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.ico') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .ico.');
  const original = await supportedImage(input.data);
  if (original.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Icon conversion supports still images. Animated PNG and WebP are refused to preserve animation.');
  }
  // Read the parsed container headers before the native decoder allocates a bitmap.
  // WebP's canvas and encoded-frame dimensions must agree; checking only VP8X can miss a larger frame.
  const dimensions = rasterInputDimensions(original);
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
      || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new AdapterError('IMAGE_DIMENSIONS', 'The source image has missing, inconsistent, or unsupported dimensions, or exceeds the 80 megapixel limit.');
  }
  const made = await withBrowser(async page => {
    // The website decoder also recognizes SVG by filename. Name these already
    // verified raster bytes by their actual container, never by an untrusted suffix.
    await page.locator('#input').setInputFiles({ name: `source.${original.kind}`, mimeType: MIME[original.kind], buffer: input.data });
    return page.evaluate(async ({ settings, maxPixels, maxBytes }) => {
      const rendering = await import('/vendor/abox/tools/image-to-ico/src/render.js');
      const { writeIco, dibEntry, readIcoDirectory } = await import('/vendor/abox/tools/image-to-ico/src/ico.js');
      const { storageFor } = await import('/vendor/abox/tools/image-to-ico/src/sizes.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      let source;
      const canvases = [];
      try {
        source = await rendering.decode(document.querySelector('#input').files[0]);
        if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
            || source.width < 1 || source.height < 1 || source.width * source.height > maxPixels || source.vector) {
          return refuse('IMAGE_DIMENSIONS', 'The source image exceeds the 80 megapixel limit or is not a supported still raster.');
        }
        const entries = [];
        const expected = [];
        for (const size of settings.sizes) {
          const canvas = rendering.square(source.bitmap, source.width, source.height, size, settings);
          canvases.push(canvas);
          const pixels = rendering.pixels(canvas);
          const kind = storageFor(size, settings.storage);
          const data = kind === 'png' ? await rendering.png(canvas) : dibEntry(pixels);
          entries.push({ width: size, height: size, kind, data });
          expected.push(pixels.data);
        }
        const bytes = writeIco(entries);
        if (!bytes.length || bytes.length > maxBytes) return refuse('OUTPUT_SIZE', 'The icon exceeds the 128 MiB output limit.');
        const found = readIcoDirectory(bytes);
        if (found.length !== entries.length) return refuse('VERIFICATION_FAILED', 'The icon frame count could not be verified.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < found.length; index++) {
          const entry = found[index];
          const size = settings.sizes[index];
          const start = view.getUint32(6 + index * 16 + 12, true);
          const frame = bytes.subarray(start, start + entry.bytes);
          let actual;
          if (entry.width !== size || entry.height !== size || entry.kind !== entries[index].kind) {
            return refuse('VERIFICATION_FAILED', 'The icon frame directory disagrees with the prepared sizes.');
          }
          if (entry.kind === 'png') {
            const decoded = await codecs.decode(new Blob([frame], { type: 'image/png' }));
            try {
              if (decoded.width !== size || decoded.height !== size) return refuse('VERIFICATION_FAILED', 'A PNG icon frame has incorrect dimensions.');
              const canvas = document.createElement('canvas');
              canvases.push(canvas);
              canvas.width = size; canvas.height = size;
              const context = canvas.getContext('2d');
              context.drawImage(decoded.bitmap, 0, 0);
              actual = context.getImageData(0, 0, size, size).data;
            } finally { codecs.release(decoded.bitmap); }
          } else {
            actual = new Uint8Array(size * size * 4);
            const maskStride = Math.ceil(size / 32) * 4;
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++) {
                const at = 40 + ((size - 1 - y) * size + x) * 4;
                const to = (y * size + x) * 4;
                actual.set([frame[at + 2], frame[at + 1], frame[at], frame[at + 3]], to);
                const mask = frame[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] & (0x80 >> (x & 7));
                if (Boolean(mask) !== (actual[to + 3] < 128)) return refuse('VERIFICATION_FAILED', 'An icon transparency mask did not match its alpha channel.');
              }
            }
          }
          const wanted = expected[index];
          for (let pixel = 0; pixel < wanted.length; pixel += 4) {
            if (Math.abs(actual[pixel + 3] - wanted[pixel + 3]) > 1) return refuse('VERIFICATION_FAILED', 'An icon frame did not preserve transparency.');
            for (let channel = 0; channel < 3; channel++) {
              // Compare visible, premultiplied color. Hidden RGB values at zero
              // alpha may change during an otherwise lossless PNG round trip.
              if (Math.abs(actual[pixel + channel] * actual[pixel + 3] / 255
                  - wanted[pixel + channel] * wanted[pixel + 3] / 255) > 1) {
                return refuse('VERIFICATION_FAILED', 'An icon frame did not preserve its rendered pixels.');
              }
            }
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Icon output could not be read.'));
          reader.readAsDataURL(new Blob([bytes], { type: 'image/x-icon' }));
        });
        return { data, input_width: source.width, input_height: source.height };
      } catch {
        return refuse('ICON_RENDER_FAILED', 'The installed browser could not decode or render this image as an icon.');
      } finally {
        rendering.release(source);
        for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
      }
    }, { settings: plan, maxPixels: MAX_IMAGE_PIXELS, maxBytes: MAX_INPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  if (!data.length || data.length > MAX_INPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The icon exceeds the 128 MiB output limit.');
  const entries = verifyDirectory(data, plan.sizes, plan.storage);
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'image-to-ico', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: 'ico', verified: true,
    input_width: made.input_width, input_height: made.input_height, entries,
    sizes: plan.sizes, fit: plan.fit, storage: plan.storage, background: plan.background,
    warnings: ['The icon contains newly rendered pixels; source metadata is not copied.'],
  };
}
