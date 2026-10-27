import { stat, realpath } from 'node:fs/promises';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { MAX_INPUT_BYTES, localPath, readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { MAX_IMAGE_PIXELS } from './image.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_LAYOUT_IMAGES = 32;
export const MAX_LAYOUT_SIDE = 8192;
export const MAX_LAYOUT_PIXELS = 32_000_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function settings(args) {
  const layout = args.layout ?? 'grid';
  const width = args.width ?? 1600;
  const columns = args.columns ?? 2;
  const ratio = args.ratio ?? (layout === 'grid' ? 'square' : 'original');
  const gap = args.gap ?? 16, padding = args.padding ?? 16;
  const fit = args.fit ?? 'contain';
  const format = args.format ?? 'png';
  const quality = args.quality ?? 0.92;
  const background = args.background ?? (format === 'jpeg' ? '#ffffff' : null);
  if (!Array.isArray(args.input_paths) || args.input_paths.length < 2 || args.input_paths.length > MAX_LAYOUT_IMAGES
      || !['grid', 'horizontal', 'vertical'].includes(layout)
      || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(columns) || columns < 1 || columns > MAX_LAYOUT_IMAGES
      || !['square', 'landscape', 'portrait', 'original'].includes(ratio) || (layout === 'grid' && ratio === 'original')
      || !Number.isSafeInteger(gap) || gap < 0 || gap > MAX_LAYOUT_SIDE
      || !Number.isSafeInteger(padding) || padding < 0 || padding > MAX_LAYOUT_SIDE
      || !['contain', 'cover'].includes(fit) || !Object.hasOwn(MIME, format)
      || typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1
      || (background !== null && (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose 2 to 32 local images, a grid or strip layout, supported cell settings, PNG/JPEG/WebP, and an optional six-digit background color.');
  }
  if (width > MAX_LAYOUT_SIDE) throw new AdapterError('IMAGE_DIMENSIONS', 'Image layouts support at most 8192 pixels per side and 32 megapixels overall.');
  return { layout, width, columns, ratio, gap, padding, fit, format, quality, background };
}

export async function layoutImages(args, options = {}) {
  options.signal?.throwIfAborted();
  const plan = settings(args);
  const output = await newOutput(args.output_path);
  const mime = MIME[plan.format];
  requireExtension(output, mime);
  const paths = [];
  let declaredBytes = 0;
  for (const value of args.input_paths) {
    options.signal?.throwIfAborted();
    const input = localPath(await realpath(localPath(value)));
    const info = await stat(input);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Every layout input must be a regular file.');
    declaredBytes += info.size;
    if (!info.size || declaredBytes > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The combined layout inputs must contain 1 to 128 MiB of data.');
    paths.push(input);
  }
  const inputs = [];
  let inputBytes = 0;
  for (const inputPath of paths) {
    options.signal?.throwIfAborted();
    const input = await readInput(inputPath);
    inputBytes += input.data.length;
    if (inputBytes > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The combined layout inputs grew beyond 128 MiB.');
    const image = await supportedImage(input.data);
    if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
      throw new AdapterError('ANIMATED_IMAGE', 'Image layouts support still JPEG, PNG and WebP. Animated inputs are refused to preserve animation.');
    }
    const dimensions = rasterInputDimensions(image);
    if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
        || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
      throw new AdapterError('IMAGE_DIMENSIONS', 'A layout input has missing, inconsistent or unsupported dimensions, or exceeds 80 megapixels.');
    }
    inputs.push({ ...input, format: image.kind });
  }
  const made = await withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(inputs.map((input, index) => ({
      name: `source-${index}.${input.format}`, mimeType: MIME[input.format], buffer: input.data,
    })));
    return page.evaluate(async ({ settings, mime, maxInputPixels, maxOutputPixels, maxSide, maxBytes }) => {
      const { arrange, renderLayout } = await import('/vendor/abox/tools/image-layout/src/arrange.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      const items = [];
      let canvas, checked, sample;
      try {
        for (const file of document.querySelector('#input').files) {
          const decoded = await codecs.decode(file);
          try {
            if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
                || decoded.width < 1 || decoded.height < 1 || decoded.width * decoded.height > maxInputPixels) {
              return refuse('IMAGE_DIMENSIONS', 'Each layout image must fit within the 80 megapixel input limit.');
            }
            items.push({ file, width: decoded.width, height: decoded.height });
          } finally { codecs.release(decoded.bitmap); }
        }
        let laid;
        try { laid = arrange(items, settings); }
        catch (error) {
          if (error.message === 'errorSpace') return refuse('LAYOUT_SPACE', 'The requested width has insufficient room for the cells, gaps and padding.');
          if (error.message === 'errorSize') return refuse('IMAGE_DIMENSIONS', 'The layout exceeds 8192 pixels per side or 32 megapixels.');
          return refuse('INVALID_ARGUMENTS', 'The requested layout settings are unsupported.');
        }
        if (!laid || laid.width > maxSide || laid.height > maxSide || laid.width * laid.height > maxOutputPixels) {
          return refuse('IMAGE_DIMENSIONS', 'The layout exceeds 8192 pixels per side or 32 megapixels.');
        }
        if (!(await codecs.canEncode(mime))) return refuse('ENCODER_UNSUPPORTED', 'The installed browser cannot encode this image format.');
        // The website engine owns geometry, clipping, sequential full-size
        // decodes and release. Its raster pixels are never replaced by previews.
        canvas = await renderLayout(items, { ...settings, transparent: settings.background === null,
          background: settings.background ?? '#ffffff' });
        if (!canvas || canvas.width !== laid.width || canvas.height !== laid.height) {
          return refuse('VERIFICATION_FAILED', 'The rendered canvas did not match the existing layout plan.');
        }
        const blob = await codecs.encode(canvas, { width: laid.width, height: laid.height, mime,
          quality: settings.quality, ...(settings.background !== null ? { background: settings.background } : {}) });
        if (blob.type !== mime) return refuse('VERIFICATION_FAILED', 'The encoder returned a different image format.');
        if (!blob.size || blob.size > maxBytes) return refuse('OUTPUT_SIZE', 'The combined image exceeds the 128 MiB output limit.');
        checked = await codecs.decode(blob);
        if (checked.width !== laid.width || checked.height !== laid.height) return refuse('VERIFICATION_FAILED', 'The encoded image dimensions did not match the layout plan.');
        sample = document.createElement('canvas'); sample.width = 1; sample.height = 1;
        const actualContext = sample.getContext('2d', { willReadFrequently: true });
        const expectedContext = canvas.getContext('2d', { willReadFrequently: true });
        let alphaSamples = 0, pixelSamples = 0;
        for (let row = 0; row < 7; row++) {
          for (let column = 0; column < 7; column++) {
            const x = Math.round((laid.width - 1) * column / 6), y = Math.round((laid.height - 1) * row / 6);
            actualContext.clearRect(0, 0, 1, 1);
            actualContext.drawImage(checked.bitmap, x, y, 1, 1, 0, 0, 1, 1);
            const actual = actualContext.getImageData(0, 0, 1, 1).data;
            const expected = expectedContext.getImageData(x, y, 1, 1).data;
            if (mime === 'image/jpeg') {
              if (actual[3] !== 255) return refuse('VERIFICATION_FAILED', 'JPEG output did not decode as opaque pixels.');
            } else {
              if (Math.abs(actual[3] - expected[3]) > 1) return refuse('VERIFICATION_FAILED', 'The combined image did not preserve rendered transparency.');
              alphaSamples++;
            }
            if (mime === 'image/png') {
              if ([0, 1, 2].some(channel => Math.abs(actual[channel] * actual[3] / 255 - expected[channel] * expected[3] / 255) > 1)) {
                return refuse('VERIFICATION_FAILED', 'The PNG output did not preserve its rendered pixels.');
              }
              pixelSamples++;
            }
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('The combined image could not be read.'));
          reader.readAsDataURL(blob);
        });
        return { data, width: laid.width, height: laid.height, columns: laid.columns, rows: laid.rows,
          verification: { format: true, dimensions: true, decoded: true, alpha_samples: alphaSamples, png_pixel_samples: pixelSamples } };
      } catch {
        return refuse('LAYOUT_RENDER_FAILED', 'The installed browser could not decode, arrange or encode these images.');
      } finally {
        codecs.release(checked?.bitmap);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        if (sample) { sample.width = 0; sample.height = 0; }
      }
    }, { settings: plan, mime, maxInputPixels: MAX_IMAGE_PIXELS, maxOutputPixels: MAX_LAYOUT_PIXELS,
      maxSide: MAX_LAYOUT_SIDE, maxBytes: MAX_INPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  const checked = await supportedImage(data);
  if (checked.kind !== plan.format || !data.length || data.length > MAX_INPUT_BYTES) {
    throw new AdapterError('VERIFICATION_FAILED', 'The combined output format or byte limit could not be verified.');
  }
  delete made.data;
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'image-layout', input_paths: inputs.map(input => input.path), output_path: output,
    input_bytes: inputBytes, output_bytes: data.length, image_count: inputs.length, format: plan.format,
    verified: true, ...made, layout: plan.layout, ratio: plan.ratio, fit: plan.fit, gap: plan.gap,
    padding: plan.padding, background: plan.background, quality: plan.format === 'png' ? null : plan.quality,
    warnings: ['The layout contains newly rendered 8-bit SDR pixels. Scaling, cropping, colors and precision can change; source metadata is not copied.',
      ...(plan.format === 'jpeg' ? [`Transparency is composited over ${plan.background}.`] : [])],
  };
}
