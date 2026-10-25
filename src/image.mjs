import path from 'node:path';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { MAX_INPUT_BYTES, readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_IMAGE_PIXELS = 80_000_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function settings(args, resizing) {
  const format = args.format ?? (resizing ? 'keep' : undefined);
  if (!(Object.hasOwn(MIME, format) || (resizing && format === 'keep'))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose jpeg, png, or webp; resizing also supports keep.');
  }
  const quality = args.quality ?? 0.92;
  const background = args.background ?? '#ffffff';
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1
      || typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Quality must be between 0 and 1, and background must be a six-digit hexadecimal color.');
  }
  const result = { format, quality, background, max_pixels: MAX_IMAGE_PIXELS, max_bytes: MAX_INPUT_BYTES };
  if (!resizing) return result;
  for (const dimension of ['width', 'height']) {
    const value = args[dimension];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > MAX_IMAGE_PIXELS)) {
      throw new AdapterError('INVALID_ARGUMENTS', 'Width and height must be positive integer pixel dimensions.');
    }
    result[dimension] = value ?? null;
  }
  if (result.width === null && result.height === null) throw new AdapterError('INVALID_ARGUMENTS', 'Specify width, height, or both.');
  if (result.width && result.height && result.width * result.height > MAX_IMAGE_PIXELS) {
    throw new AdapterError('IMAGE_DIMENSIONS', 'The requested output box exceeds the 80 megapixel limit.');
  }
  result.fit = args.fit ?? 'contain';
  result.allow_upscale = args.allow_upscale ?? false;
  if (!['contain', 'cover'].includes(result.fit) || typeof result.allow_upscale !== 'boolean') {
    throw new AdapterError('INVALID_ARGUMENTS', 'Fit must be contain or cover, and allow_upscale must be a boolean.');
  }
  return result;
}

async function processImage(args, options, resizing) {
  options.signal?.throwIfAborted();
  const plan = settings(args, resizing);
  const input = await readInput(args.input_path);
  const output = await newOutput(args.output_path);
  const original = await supportedImage(input.data);
  if (original.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Resizing and conversion support still images. Animated PNG and WebP are refused to preserve animation.');
  }
  const outputFormat = plan.format === 'keep' ? original.kind : plan.format;
  const mime = MIME[outputFormat];
  requireExtension(output, mime);
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: path.basename(input.path), mimeType: MIME[original.kind], buffer: input.data });
    return page.evaluate(async request => {
      const { settings, resizing, mime } = request;
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const file = document.querySelector('#input').files[0];
      const refuse = (code, message) => ({ error: { code, message } });
      const validSize = size => Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
        && size.width > 0 && size.height > 0 && size.width * size.height <= settings.max_pixels;
      const source = await codecs.decode(file);
      const inputSize = { width: source.width, height: source.height };
      let blob;
      let detail;
      try {
        if (!validSize(inputSize)) return refuse('IMAGE_DIMENSIONS', 'The image exceeds the 80 megapixel limit.');
        if (!(await codecs.canEncode(mime))) return refuse('ENCODER_UNSUPPORTED', 'The installed browser cannot encode the requested image format.');
        if (resizing) {
          const { prepareRun, processOne } = await import('/vendor/abox/tools/resize-image/src/run.js');
          const { encodableTypes } = await import('/vendor/abox/tools/resize-image/src/codecs.js');
          const { batch } = prepareRun([{ file, size: inputSize }], {
            resize: { mode: 'pixels', width: settings.width, height: settings.height,
              fit: settings.fit, noEnlarge: !settings.allow_upscale },
            format: settings.format === 'keep' ? 'keep' : mime,
            quality: settings.quality, background: settings.background,
          }, await encodableTypes());
          const job = batch[0];
          if (!validSize(job.laid.canvas)) return refuse('IMAGE_DIMENSIONS', 'The resized image exceeds the 80 megapixel limit.');
          // The prepared upstream job owns both the crop and dimensions. Its
          // passthrough branch also preserves original bytes when nothing changes.
          codecs.release(source.bitmap);
          const result = await processOne(job);
          blob = result.blob;
          detail = { expected: job.laid.canvas, crop: result.crop, scale: result.scale,
            untouched: result.untouched, resized: job.laid.canvas.width !== inputSize.width
              || job.laid.canvas.height !== inputSize.height };
        } else if (mime === codecs.WEBP) {
          const result = await codecs.encodeWebp(source.bitmap, {
            ...inputSize, quality: settings.quality, lossless: settings.quality === 1,
          });
          blob = result.blob;
          detail = { expected: inputSize, untouched: false, lossless: result.lossless };
        } else {
          blob = await codecs.encode(source.bitmap, { ...inputSize, mime,
            quality: settings.quality, ...(mime === codecs.JPEG ? { background: settings.background } : {}) });
          detail = { expected: inputSize, untouched: false };
        }
      } finally {
        codecs.release(source.bitmap);
      }
      if (blob.type !== mime) return refuse('VERIFICATION_FAILED', 'The encoder returned a different image format.');
      if (!blob.size || blob.size > settings.max_bytes) return refuse('OUTPUT_SIZE', 'The encoded image exceeds the 128 MiB output limit.');
      const checked = await codecs.decode(blob);
      let actual;
      try {
        actual = { width: checked.width, height: checked.height };
        if (!validSize(actual) || actual.width !== detail.expected.width || actual.height !== detail.expected.height) {
          return refuse('VERIFICATION_FAILED', 'The encoded image dimensions did not match the prepared output.');
        }
      } finally {
        codecs.release(checked.bitmap);
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the encoded image.'));
        reader.readAsDataURL(blob);
      });
      delete detail.expected;
      return { data, mime, ...actual, input_width: inputSize.width, input_height: inputSize.height, ...detail };
    }, { settings: plan, resizing, mime });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  delete made.data;
  const checked = await supportedImage(data);
  if (checked.kind !== outputFormat || !data.length || data.length > MAX_INPUT_BYTES) {
    throw new AdapterError('VERIFICATION_FAILED', 'The encoded image bytes did not match the requested format or size limit.');
  }
  if (made.untouched && !data.equals(input.data)) {
    throw new AdapterError('VERIFICATION_FAILED', 'The unchanged image did not preserve the original bytes.');
  }
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: resizing ? 'resize-image' : 'convert-image',
    input_path: input.path, output_path: output, input_bytes: input.data.length,
    output_bytes: data.length, format: outputFormat, verified: true, ...made,
    quality: outputFormat === 'png' || made.untouched ? null : plan.quality,
    background: outputFormat === 'jpeg' && !made.untouched ? plan.background : null,
    ...(resizing ? { fit: plan.fit, allow_upscale: plan.allow_upscale } : {}),
    warnings: made.untouched
      ? ['The requested dimensions do not change this image; the original bytes and metadata were preserved.']
      : ['The image was re-encoded. Source metadata is not copied; color, precision, or partially transparent pixels can change.',
        ...(outputFormat === 'jpeg' ? [`Transparency is composited over ${plan.background} because JPEG cannot store alpha.`] : [])],
  };
}

export function resizeImage(args, options = {}) {
  return processImage(args, options, true);
}

export function convertImage(args, options = {}) {
  return processImage(args, options, false);
}
