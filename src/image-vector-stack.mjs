import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { MAX_INPUT_BYTES, localPath, newOutput, readInput, requireExtension, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_TRACE_SIDE = 4096;
export const MAX_TRACE_PIXELS = 4_000_000;
export const MAX_TRACE_EDGES = 100_000;
export const MAX_TRACE_CONTOURS = 1000;
export const MAX_TRACE_OUTPUT_BYTES = 400_000;
export const MAX_STACK_IMAGES = 8;
export const MAX_STACK_SIDE = 4096;
export const MAX_STACK_PIXELS = 4_000_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const STACK_METHODS = { average: 'mean', median: 'median', sigma: 'sigma', lighten: 'max', darken: 'min', add: 'sum' };

function traceSettings(args) {
  const settings = { threshold: args.threshold ?? 'otsu', invert: args.invert ?? false,
    detail: args.detail ?? 'auto', corner_angle: args.corner_angle ?? 65,
    min_area: args.min_area ?? 2, fill: args.fill ?? '#000000' };
  if ((settings.threshold !== 'otsu' && (!Number.isInteger(settings.threshold) || settings.threshold < 0 || settings.threshold > 255))
      || typeof settings.invert !== 'boolean'
      || (settings.detail !== 'auto' && (typeof settings.detail !== 'number' || !Number.isFinite(settings.detail) || settings.detail < 0.1 || settings.detail > 10))
      || typeof settings.corner_angle !== 'number' || !Number.isFinite(settings.corner_angle) || settings.corner_angle < 0 || settings.corner_angle > 180
      || !Number.isInteger(settings.min_area) || settings.min_area < 0 || settings.min_area > 10000
      || typeof settings.fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.fill)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Use an Otsu or 0–255 threshold, boolean invert, automatic or 0.1–10 detail, a 0–180 degree corner angle, 0–10000 minimum area, and a six-digit fill color.');
  }
  return settings;
}

function stackSettings(args) {
  const settings = { method: args.method ?? 'average', format: args.format ?? 'png',
    quality: args.quality ?? 0.92, kappa: args.kappa ?? 2, gain: args.gain ?? 1 };
  if (!Array.isArray(args.input_paths) || args.input_paths.length < 2 || args.input_paths.length > MAX_STACK_IMAGES
      || !Object.hasOwn(STACK_METHODS, settings.method) || !['png', 'jpeg'].includes(settings.format)
      || typeof settings.quality !== 'number' || !Number.isFinite(settings.quality) || settings.quality < 0 || settings.quality > 1
      || typeof settings.kappa !== 'number' || !Number.isFinite(settings.kappa) || settings.kappa < 0.1 || settings.kappa > 10
      || typeof settings.gain !== 'number' || !Number.isFinite(settings.gain) || settings.gain < 0.1 || settings.gain > 16
      || (args.kappa !== undefined && settings.method !== 'sigma') || (args.gain !== undefined && settings.method !== 'add')) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose 2–8 local frames, average/median/sigma/lighten/darken/add, PNG or JPEG, and quality 0–1. Kappa 0.1–10 applies only to sigma; gain 0.1–16 applies only to add.');
  }
  return { ...settings, source_method: STACK_METHODS[settings.method] };
}

async function inputsFor(values, kind, signal) {
  const paths = [];
  let total = 0;
  for (const value of values) {
    signal?.throwIfAborted();
    const filename = localPath(await realpath(localPath(value)));
    const info = await stat(filename);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Every input must be a regular local image file.');
    total += info.size;
    if (!info.size || total > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The combined image inputs must contain 1 to 128 MiB of data.');
    paths.push(filename);
  }
  const inputs = [];
  total = 0;
  const maxSide = kind === 'trace' ? MAX_TRACE_SIDE : MAX_STACK_SIDE;
  const maxPixels = kind === 'trace' ? MAX_TRACE_PIXELS : MAX_STACK_PIXELS;
  for (const filename of paths) {
    signal?.throwIfAborted();
    const input = await readInput(filename);
    total += input.data.length;
    if (total > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The combined image inputs grew beyond 128 MiB.');
    const image = await supportedImage(input.data);
    if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
      throw new AdapterError('ANIMATED_IMAGE', 'Tracing and stacking support still JPEG, PNG and WebP. Animated inputs are refused to preserve animation.');
    }
    const size = rasterInputDimensions(image);
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
        || size.width < 1 || size.height < 1 || size.width > maxSide || size.height > maxSide || size.width * size.height > maxPixels) {
      throw new AdapterError('IMAGE_DIMENSIONS', 'Each image must have consistent dimensions within 4096 pixels per side and 4 megapixels.');
    }
    inputs.push({ ...input, format: image.kind });
  }
  return { inputs, total };
}

async function render(inputs, job, options) {
  return withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(inputs.map((input, index) => ({
      name: `source-${index}.${input.format}`, mimeType: MIME[input.format], buffer: input.data,
    })));
    return page.evaluate(async request => {
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const files = Array.from(document.querySelector('#input').files);
      const refuse = (code, message) => ({ error: { code, message } });
      const surfaces = [];
      const canvas = (width, height) => {
        const result = document.createElement('canvas'); result.width = width; result.height = height;
        surfaces.push(result);
        return result;
      };
      const context = target => target.getContext('2d', { willReadFrequently: true });
      const validSize = size => Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
        && size.width > 0 && size.height > 0 && size.width <= request.maxSide && size.height <= request.maxSide
        && size.width * size.height <= request.maxPixels;
      let active, checked, svgUrl;
      try {
        if (request.kind === 'trace') {
          const { maskFromImage } = await import('/vendor/abox/tools/image-to-svg/src/mask.js');
          const { traceMask } = await import('/vendor/abox/tools/image-to-svg/src/trace.js');
          active = await codecs.decode(files[0]);
          if (!validSize(active)) return refuse('IMAGE_DIMENSIONS', 'The decoded image exceeds 4096 pixels per side or 4 megapixels.');
          const { width, height } = active;
          const source = canvas(width, height), sourceContext = context(source);
          sourceContext.drawImage(active.bitmap, 0, 0);
          codecs.release(active.bitmap); active = null;
          const mask = maskFromImage(sourceContext.getImageData(0, 0, width, height), request.settings);
          // Every contour follows these ink/paper cracks. Counting them before
          // fitting bounds noisy inputs without changing the pinned tracer.
          let edges = 0;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const at = y * width + x;
              if (!mask.bits[at]) continue;
              if (x === 0 || !mask.bits[at - 1]) edges++;
              if (x === width - 1 || !mask.bits[at + 1]) edges++;
              if (y === 0 || !mask.bits[at - width]) edges++;
              if (y === height - 1 || !mask.bits[at + width]) edges++;
              if (edges > request.maxEdges) return refuse('TRACE_COMPLEXITY', 'The image has too many boundary edges for a bounded shape trace. Use a simpler logo, drawing or silhouette.');
            }
          }
          const out = traceMask(mask, { epsilon: request.settings.detail, cornerAngle: request.settings.corner_angle,
            minArea: request.settings.min_area, fill: request.settings.fill });
          if (!out.stats.contours || !out.d) return refuse('EMPTY_TRACE', 'The chosen threshold and minimum area produced no traced shape.');
          if (out.stats.contours > request.maxContours || new TextEncoder().encode(out.svg).length > request.maxBytes) {
            return refuse('TRACE_COMPLEXITY', 'The trace exceeds 1000 contours or 400000 SVG bytes. Use a simpler logo, drawing or silhouette.');
          }
          const parsed = new DOMParser().parseFromString(out.svg, 'image/svg+xml');
          const root = parsed.documentElement, shape = root.firstElementChild;
          if (parsed.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg'
              || root.getAttribute('viewBox') !== `0 0 ${width} ${height}` || root.children.length !== 1
              || shape?.localName !== 'path' || shape.getAttribute('fill') !== request.settings.fill
              || shape.getAttribute('d') !== out.d || !/^[MLCz\d .e+\-]+$/.test(out.d)) {
            return refuse('VERIFICATION_FAILED', 'The traced SVG did not have the expected passive single-path structure.');
          }
          svgUrl = URL.createObjectURL(new Blob([out.svg], { type: 'image/svg+xml' }));
          const image = new Image(); image.src = svgUrl; await image.decode();
          if (image.naturalWidth !== width || image.naturalHeight !== height) return refuse('VERIFICATION_FAILED', 'The SVG decoded at unexpected dimensions.');
          const rendered = canvas(width, height), expected = canvas(width, height);
          context(rendered).drawImage(image, 0, 0);
          const expectedContext = context(expected);
          expectedContext.fillStyle = request.settings.fill; expectedContext.fill(new Path2D(out.d));
          const actualPixels = context(rendered).getImageData(0, 0, width, height).data;
          const expectedPixels = expectedContext.getImageData(0, 0, width, height).data;
          let painted = 0;
          for (let at = 0; at < actualPixels.length; at += 4) {
            if (actualPixels[at + 3]) painted++;
            for (let channel = 0; channel < 4; channel++) {
              const actual = channel === 3 ? actualPixels[at + 3] : actualPixels[at + channel] * actualPixels[at + 3] / 255;
              const wanted = channel === 3 ? expectedPixels[at + 3] : expectedPixels[at + channel] * expectedPixels[at + 3] / 255;
              if (Math.abs(actual - wanted) > 2) return refuse('VERIFICATION_FAILED', 'The SVG pixels did not match its traced path.');
            }
          }
          if (!painted) return refuse('EMPTY_TRACE', 'The traced shape produced no visible pixels at the original image size.');
          return { svg: out.svg, width, height, contours: out.stats.contours, boundary_edges: edges,
            vertices: out.stats.vertices, threshold_used: mask.threshold,
            verification: { passive_single_path: true, svg_decoded: true, path_pixel_checks: width * height } };
        }

        const { createStack } = await import('/vendor/abox/tools/stack-images/src/stack.js');
        const mime = request.settings.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        if (!(await codecs.canEncode(mime))) return refuse('ENCODER_UNSUPPORTED', 'The installed browser cannot encode the requested stack format.');
        let width, height, stack, working, workingContext;
        const samplePoints = [], values = [];
        const passes = request.settings.method === 'sigma' ? 2 : 1;
        for (let pass = 0; pass < passes; pass++) {
          for (let index = 0; index < files.length; index++) {
            active = await codecs.decode(files[index]);
            if (!validSize(active)) return refuse('IMAGE_DIMENSIONS', 'Every decoded frame must fit within 4096 pixels per side and 4 megapixels.');
            if (width === undefined) {
              ({ width, height } = active);
              working = canvas(width, height); workingContext = context(working);
              for (let row = 0; row < 7; row++) for (let column = 0; column < 7; column++) {
                const point = Math.round((height - 1) * row / 6) * width + Math.round((width - 1) * column / 6);
                samplePoints.push(point); values.push([]);
              }
            }
            if (active.width !== width || active.height !== height) return refuse('STACK_DIMENSIONS', 'Stack frames must have the same decoded width and height. This operation does not align or resize frames.');
            workingContext.clearRect(0, 0, width, height); workingContext.drawImage(active.bitmap, 0, 0);
            codecs.release(active.bitmap); active = null;
            const pixels = workingContext.getImageData(0, 0, width, height).data;
            for (let at = 3; at < pixels.length; at += 4) {
              if (pixels[at] !== 255) return refuse('STACK_TRANSPARENCY', 'Stack frames must be fully opaque. Composite transparency onto a chosen background before stacking.');
            }
            if (!stack) {
              stack = createStack(request.settings.source_method, { width, height, frames: files.length,
                kappa: request.settings.kappa, gain: request.settings.method === 'add' ? request.settings.gain : 1 });
              if (stack.passes !== passes) return refuse('VERIFICATION_FAILED', 'The pinned stack engine reported unexpected passes.');
            }
            if (index === 0) stack.beginPass(pass);
            stack.add(pixels, index, pass);
            if (pass === 0) for (let sample = 0; sample < samplePoints.length; sample++) {
              const at = samplePoints[sample] * 4;
              values[sample].push([pixels[at], pixels[at + 1], pixels[at + 2]]);
            }
          }
          stack.endPass(pass);
        }
        const result = stack.result();
        if (!(result instanceof Uint8ClampedArray) || result.length !== width * height * 4) return refuse('VERIFICATION_FAILED', 'The stack engine returned an unexpected pixel buffer.');
        const clamp = value => new Uint8ClampedArray([value])[0];
        for (let sample = 0; sample < samplePoints.length; sample++) {
          const at = samplePoints[sample] * 4;
          if (result[at + 3] !== 255) return refuse('VERIFICATION_FAILED', 'The stack engine returned unexpected transparency.');
          for (let channel = 0; channel < 3; channel++) {
            const channelValues = values[sample].map(value => value[channel]);
            const total = channelValues.reduce((sum, value) => sum + value, 0);
            let expected;
            switch (request.settings.method) {
              case 'average': expected = total / channelValues.length; break;
              case 'add': expected = total * request.settings.gain; break;
              case 'lighten': expected = Math.max(...channelValues); break;
              case 'darken': expected = Math.min(...channelValues); break;
              case 'median': {
                channelValues.sort((a, b) => a - b);
                const middle = channelValues.length >> 1;
                expected = channelValues.length % 2 ? channelValues[middle] : (channelValues[middle - 1] + channelValues[middle]) / 2;
                break;
              }
              case 'sigma': {
                const mean = total / channelValues.length;
                const variance = Math.max(0, channelValues.reduce((sum, value) => sum + value * value, 0) / channelValues.length - mean * mean);
                const center = Math.round(mean), spread = Math.min(255, Math.round(Math.sqrt(variance) * request.settings.kappa * 8)) / 8;
                const kept = channelValues.filter(value => Math.abs(value - center) <= spread);
                expected = kept.length ? kept.reduce((sum, value) => sum + value, 0) / kept.length : center;
                break;
              }
            }
            if (result[at + channel] !== clamp(expected)) return refuse('VERIFICATION_FAILED', 'The stacked pixels did not match independently computed sample values.');
          }
        }
        workingContext.putImageData(new ImageData(result, width, height), 0, 0);
        const blob = await codecs.encode(working, { width, height, mime, quality: request.settings.quality });
        if (blob.type !== mime || !blob.size || blob.size > request.maxBytes) return refuse('OUTPUT_SIZE', 'The stack encoder returned an unsupported format or exceeded 128 MiB.');
        checked = await codecs.decode(blob);
        if (checked.width !== width || checked.height !== height) return refuse('VERIFICATION_FAILED', 'The encoded stack dimensions changed.');
        const encoded = canvas(width, height), encodedContext = context(encoded);
        encodedContext.drawImage(checked.bitmap, 0, 0);
        const encodedPixels = encodedContext.getImageData(0, 0, width, height).data;
        for (let at = 0; at < encodedPixels.length; at++) {
          if ((at % 4 === 3 && encodedPixels[at] !== 255)
              || (mime === 'image/png' && encodedPixels[at] !== result[at])) {
            return refuse('VERIFICATION_FAILED', 'The encoded stack did not preserve opaque PNG pixels or JPEG opacity.');
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('output-read')); reader.readAsDataURL(blob);
        });
        return { data, width, height, passes,
          verification: { dimensions: true, format: true, decoded: true, opaque: true,
            accumulator_samples: samplePoints.length, png_pixel_checks: mime === 'image/png' ? width * height : 0 } };
      } catch {
        return refuse(request.kind === 'trace' ? 'TRACE_RENDER_FAILED' : 'STACK_RENDER_FAILED',
          request.kind === 'trace' ? 'The installed browser could not decode, trace or verify this image.' : 'The installed browser could not decode, stack or encode these frames.');
      } finally {
        codecs.release(active?.bitmap); codecs.release(checked?.bitmap);
        if (svgUrl) URL.revokeObjectURL(svgUrl);
        for (const surface of surfaces) { surface.width = 0; surface.height = 0; }
      }
    }, { ...job, maxSide: job.kind === 'trace' ? MAX_TRACE_SIDE : MAX_STACK_SIDE,
      maxPixels: job.kind === 'trace' ? MAX_TRACE_PIXELS : MAX_STACK_PIXELS,
      maxEdges: MAX_TRACE_EDGES, maxContours: MAX_TRACE_CONTOURS,
      maxBytes: job.kind === 'trace' ? MAX_TRACE_OUTPUT_BYTES : MAX_INPUT_BYTES });
  }, options);
}

export async function traceImageToSvg(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = traceSettings(args);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.svg') throw new AdapterError('OUTPUT_EXTENSION', 'Traced output must use the .svg extension.');
  const { inputs, total } = await inputsFor([args.input_path], 'trace', options.signal);
  const made = await render(inputs, { kind: 'trace', settings }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.svg, 'utf8');
  if (!data.length || data.length > MAX_TRACE_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The traced SVG exceeds 400000 bytes.');
  delete made.svg;
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'image-trace', input_path: inputs[0].path, output_path: output,
    input_bytes: total, output_bytes: data.length, format: 'svg', verified: true, ...settings, ...made,
    warnings: ['This is a one-color shape trace for logos, drawings and silhouettes. Photographs, gradients, fine detail and colors are not preserved.',
      'Verification checks the passive SVG structure and its rendered path; it does not prove the chosen threshold or approximation matches the intended subject. Source metadata is not copied.'] };
}

export async function stackImages(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = stackSettings(args);
  const output = await newOutput(args.output_path);
  requireExtension(output, MIME[settings.format]);
  const { inputs, total } = await inputsFor(args.input_paths, 'stack', options.signal);
  const made = await render(inputs, { kind: 'stack', settings }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  const checked = await supportedImage(data);
  const size = rasterInputDimensions(checked);
  if (!data.length || data.length > MAX_INPUT_BYTES || checked.kind !== settings.format
      || size?.width !== made.width || size?.height !== made.height) {
    throw new AdapterError('VERIFICATION_FAILED', 'The stacked output format, dimensions or byte limit could not be verified.');
  }
  delete made.data;
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'image-stack', input_paths: inputs.map(input => input.path), output_path: output,
    input_bytes: total, output_bytes: data.length, image_count: inputs.length, format: settings.format,
    method: settings.method, quality: settings.format === 'jpeg' ? settings.quality : null,
    kappa: settings.method === 'sigma' ? settings.kappa : null, gain: settings.method === 'add' ? settings.gain : null,
    alignment: 'none', verified: true, ...made,
    warnings: ['Frames are combined at their decoded positions with no alignment, resizing or RAW development. Use opaque frames of the same dimensions from a steady camera.',
      'The output contains newly rendered 8-bit SDR RGB values. Stacking and additive blending use encoded channel values rather than linear light; colors and precision can change, and source metadata is not copied.'] };
}
