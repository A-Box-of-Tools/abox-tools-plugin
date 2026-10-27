import path from 'node:path';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { fitFrame, measure, passes, printPixels, resampling } from '../vendor/abox/tools/id-photo/src/geometry.js';
import { bestSheet } from '../vendor/abox/tools/id-photo/src/sheet.js';
import { readDensity } from '../vendor/abox/tools/id-photo/src/jpeg.js';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_ID_PHOTO_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_ID_PHOTO_SETTINGS_BYTES = 16 * 1024;
export const MAX_ID_PHOTO_SIDE = 8192;
export const MAX_ID_PHOTO_INPUT_PIXELS = 32_000_000;
export const MAX_ID_PHOTO_OUTPUT_PIXELS = 16_000_000;
export const MAX_ID_PHOTO_COPIES = 100;
export const MAX_ID_PHOTO_OUTPUT_BYTES = 32 * 2 ** 20;
export const MAX_ID_PHOTO_WORKING_BYTES = 512 * 2 ** 20;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const inRange = (value, low, high) => finite(value) && value >= low && value <= high;
const setting = (value, fallback) => value === undefined ? fallback : value;
const invalid = () => { throw new AdapterError('ID_PHOTO_SETTINGS', 'Use the supported custom numeric settings and four finite landmark points. No country profiles or acceptance rules are inferred.'); };

function strictJson(text) {
  // The small configuration uses at most root/landmarks/point objects. Bound
  // recursive parser depth before reading any tree from an arbitrary file.
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '"') {
      for (at++; at < text.length; at++) { if (text[at] === '\\') at++; else if (text[at] === '"') break; }
    } else if (text[at] === '[' || text[at] === '{') { if (++depth > 4) invalid(); }
    else if (text[at] === ']' || text[at] === '}') depth = Math.max(0, depth - 1);
  }
  let tree;
  try { tree = parseJson(text); } catch { invalid(); }
  const nodes = [tree]; let count = 0;
  while (nodes.length) {
    const node = nodes.pop(); if (++count > 200) invalid();
    if (node.t === 'map') {
      const keys = node.pairs.map(pair => pair.key); if (new Set(keys).size !== keys.length) invalid();
      nodes.push(...node.pairs.map(pair => pair.value));
    } else if (node.t === 'seq') nodes.push(...node.items);
  }
  try { return JSON.parse(text); } catch { invalid(); }
}

function keys(object, allowed, required = []) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
      || Object.keys(object).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(object, key))) invalid();
}

function settingsFor(value) {
  const required = ['image_width', 'image_height', 'width_mm', 'height_mm', 'dpi', 'head_min_mm', 'head_max_mm', 'eye_min_mm', 'eye_max_mm', 'landmarks'];
  keys(value, [...required, 'paper_width_mm', 'paper_height_mm', 'margin_mm', 'gap_mm', 'background', 'quality', 'allow_upscale'], required);
  const settings = { ...value, paper_width_mm: setting(value.paper_width_mm, 152.4), paper_height_mm: setting(value.paper_height_mm, 101.6),
    margin_mm: setting(value.margin_mm, 3), gap_mm: setting(value.gap_mm, 2), background: setting(value.background, '#ffffff'),
    quality: setting(value.quality, 0.94), allow_upscale: setting(value.allow_upscale, false) };
  if (![settings.image_width, settings.image_height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_ID_PHOTO_SIDE)
      || settings.image_width * settings.image_height > MAX_ID_PHOTO_INPUT_PIXELS
      || !inRange(settings.width_mm, 10, 100) || !inRange(settings.height_mm, 10, 100)
      || !Number.isSafeInteger(settings.dpi) || !inRange(settings.dpi, 72, 600)
      || !inRange(settings.head_min_mm, 1, settings.height_mm) || !inRange(settings.head_max_mm, settings.head_min_mm, settings.height_mm)
      || !inRange(settings.eye_min_mm, 1, settings.height_mm - 1) || !inRange(settings.eye_max_mm, settings.eye_min_mm, settings.height_mm - 1)
      || !inRange(settings.paper_width_mm, 20, 500) || !inRange(settings.paper_height_mm, 20, 500)
      || !inRange(settings.margin_mm, 1, 30) || !inRange(settings.gap_mm, 1, 20)
      || !inRange(settings.quality, 0.8, 1) || typeof settings.allow_upscale !== 'boolean'
      || typeof settings.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.background)
      || (value.paper_width_mm === undefined) !== (value.paper_height_mm === undefined)) invalid();
  keys(settings.landmarks, ['crown', 'chin', 'left_eye', 'right_eye'], ['crown', 'chin', 'left_eye', 'right_eye']);
  for (const point of Object.values(settings.landmarks)) {
    keys(point, ['x', 'y'], ['x', 'y']);
    if (!inRange(point.x, 0, settings.image_width - 1) || !inRange(point.y, 0, settings.image_height - 1)) invalid();
  }
  const { crown, chin, left_eye: leftEye, right_eye: rightEye } = settings.landmarks, eyeY = (leftEye.y + rightEye.y) / 2;
  if (!(crown.y < eyeY && eyeY < chin.y && leftEye.x < rightEye.x)) invalid();
  return settings;
}

function outputSize(size) {
  if (![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_ID_PHOTO_SIDE)
      || size.width * size.height > MAX_ID_PHOTO_OUTPUT_PIXELS) {
    throw new AdapterError('ID_PHOTO_DIMENSIONS', 'Each ID-photo output must fit within 8192 pixels per side and 16 megapixels. Use a lower DPI or smaller paper.');
  }
}

function planFor(settings, inputBytes) {
  const source = { width: settings.image_width, height: settings.image_height }, marks = { crown: settings.landmarks.crown,
    chin: settings.landmarks.chin, leftEye: settings.landmarks.left_eye, rightEye: settings.landmarks.right_eye };
  const spec = { print: { widthMm: settings.width_mm, heightMm: settings.height_mm, dpi: settings.dpi },
    head: { min: settings.head_min_mm / settings.height_mm, max: settings.head_max_mm / settings.height_mm },
    eye: { min: settings.eye_min_mm / settings.height_mm, max: settings.eye_max_mm / settings.height_mm } };
  const fitted = fitFrame(marks, spec, source), metrics = measure(fitted.rect, marks, spec), photo = printPixels(spec);
  outputSize(photo);
  const rect = fitted.rect;
  if (!passes(metrics) || Object.values(fitted.short).some(value => value > 0)
      || Object.values(marks).some(point => point.x < rect.x || point.y < rect.y || point.x >= rect.x + rect.width || point.y >= rect.y + rect.height)) {
    throw new AdapterError('ID_PHOTO_FRAMING', 'The supplied landmarks cannot fit the requested head/eye bands inside this image with the source engine’s centering and three-degree eye-line checks. Use a better source or correct the custom settings.');
  }
  const resizing = resampling(rect, photo);
  if (!settings.allow_upscale && (photo.width > rect.width || photo.height > rect.height)) {
    throw new AdapterError('ID_PHOTO_UPSCALE', 'The print needs more pixels than the fitted crop contains. Use a larger source, lower DPI or explicitly allow_upscale.');
  }
  const sheet = bestSheet({ photo: spec.print, paper: { widthMm: settings.paper_width_mm, heightMm: settings.paper_height_mm },
    dpi: settings.dpi, marginMm: settings.margin_mm, gapMm: settings.gap_mm });
  outputSize(sheet.canvas);
  if (!sheet.count || sheet.count > MAX_ID_PHOTO_COPIES) throw new AdapterError('ID_PHOTO_COPIES', 'The paper must hold 1 to 100 complete copies. Choose a different paper, photo size or spacing.');
  for (const cell of sheet.cells) {
    if (![cell.x, cell.y, cell.width, cell.height].every(Number.isSafeInteger) || cell.x < 0 || cell.y < 0
        || cell.width !== photo.width || cell.height !== photo.height || cell.x + cell.width > sheet.canvas.width || cell.y + cell.height > sheet.canvas.height) {
      throw new AdapterError('VERIFICATION_FAILED', 'The source sheet plan did not retain complete print-sized copies. No output was written.');
    }
  }
  const photoRgba = photo.width * photo.height * 4, sheetRgba = sheet.canvas.width * sheet.canvas.height * 4;
  const working = Math.max(inputBytes + source.width * source.height * 4 + photoRgba,
    inputBytes + photoRgba + sheetRgba * 6 + MAX_ID_PHOTO_OUTPUT_BYTES * 3 + 32 * 2 ** 20);
  if (working > MAX_ID_PHOTO_WORKING_BYTES) throw new AdapterError('ID_PHOTO_WORKING_LIMIT', 'The requested source, sheet and verification buffers exceed the 512 MiB estimated working policy. Use a lower DPI or smaller paper.');
  return { source, fitted, metrics, photo, sheet, resizing, estimated_working_bytes: working };
}

async function render(input, settings, plan, options) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: `source.${input.kind}`, mimeType: MIME[input.kind], buffer: input.data });
    return page.evaluate(async ({ settings, plan, maxBytes }) => {
      const engine = await import('/vendor/abox/tools/id-photo/src/encode.js');
      const { readDensity } = await import('/vendor/abox/tools/id-photo/src/jpeg.js');
      const surfaces = []; let active;
      const refuse = (code, message) => ({ error: { code, message } });
      const verify = async (canvas, bytes, dpi) => {
        const density = readDensity(bytes);
        if (!bytes.length || bytes.length > maxBytes || !density || density.units !== 1 || density.x !== dpi || density.y !== dpi) return null;
        const decoded = await engine.decode(new Blob([bytes], { type: 'image/jpeg' }));
        let checked;
        try {
          if (decoded.width !== canvas.width || decoded.height !== canvas.height) return null;
          checked = document.createElement('canvas'); checked.width = canvas.width; checked.height = canvas.height;
          const context = checked.getContext('2d', { willReadFrequently: true }); context.drawImage(decoded.bitmap, 0, 0);
          const expected = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
          const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let error = 0;
          for (let at = 0; at < actual.length; at += 4) {
            if (actual[at + 3] !== 255) return null;
            for (let channel = 0; channel < 3; channel++) error += Math.abs(actual[at + channel] - expected[at + channel]);
          }
          const meanError = error / (canvas.width * canvas.height * 3);
          // JPEG has no universal per-pixel equality tolerance. This full-image
          // average is an explicit quality gate, not a claim of pixel identity.
          if (meanError > 35) return null;
          return { decoded: true, density: true, opaque: true, pixels_checked: canvas.width * canvas.height,
            mean_absolute_rgb_error: meanError, lossy: true, pixel_identity: false };
        } finally { engine.release(decoded.bitmap); if (checked) engine.free(checked); }
      };
      const dataUrl = bytes => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject;
        reader.readAsDataURL(new Blob([bytes], { type: 'image/jpeg' }));
      });
      try {
        active = await engine.decode(document.querySelector('#input').files[0]);
        if (active.width !== settings.image_width || active.height !== settings.image_height) {
          return refuse('ID_PHOTO_COORDINATES', 'The image_width/image_height settings do not match the decoded display dimensions. Landmarks from a scaled preview are never applied silently.');
        }
        const photo = engine.drawCrop(active.bitmap, plan.fitted.rect, plan.photo, { background: settings.background }); surfaces.push(photo);
        engine.release(active.bitmap); active = null;
        const encodedPhoto = await engine.encodePrint(photo, { dpi: settings.dpi, quality: settings.quality });
        const photoCheck = await verify(photo, encodedPhoto.bytes, settings.dpi);
        if (!photoCheck) return refuse('VERIFICATION_FAILED', 'The photo JPEG failed dimension, density, opacity or lossy pixel checks. No output was written.');
        const sheet = engine.drawSheet(plan.sheet, photo); surfaces.push(sheet);
        const encodedSheet = await engine.encodePrint(sheet, { dpi: settings.dpi, quality: settings.quality });
        const sheetCheck = await verify(sheet, encodedSheet.bytes, settings.dpi);
        if (!sheetCheck) return refuse('VERIFICATION_FAILED', 'The sheet JPEG failed dimension, density, opacity or lossy pixel checks. No output was written.');
        return { photo: { data: await dataUrl(encodedPhoto.bytes), ...photoCheck }, sheet: { data: await dataUrl(encodedSheet.bytes), ...sheetCheck } };
      } catch { return refuse('ID_PHOTO_RENDER_FAILED', 'The installed browser could not decode, crop, encode or verify the custom photo set. No output was written.'); }
      finally { engine.release(active?.bitmap); for (const canvas of surfaces) engine.free(canvas); }
    }, { settings, plan, maxBytes: MAX_ID_PHOTO_OUTPUT_BYTES });
  }, options);
}

async function verifyJpeg(data, size, dpi) {
  if (!data.length || data.length > MAX_ID_PHOTO_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'An ID-photo JPEG exceeds the 32 MiB output limit.');
  const image = await supportedImage(data), found = rasterInputDimensions(image), density = readDensity(data);
  if (image.kind !== 'jpeg' || found?.width !== size.width || found?.height !== size.height
      || density?.units !== 1 || density.x !== dpi || density.y !== dpi) {
    throw new AdapterError('VERIFICATION_FAILED', 'An ID-photo output did not retain the verified JPEG dimensions and print density. No output was written.');
  }
}

export async function makeIdPhoto(args, options = {}) {
  options.signal?.throwIfAborted();
  const directory = await newOutput(args.output_dir), config = await readInput(args.settings_path, { max_bytes: MAX_ID_PHOTO_SETTINGS_BYTES });
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(config.data); }
  catch { throw new AdapterError('ID_PHOTO_SETTINGS', 'The custom settings file must contain valid UTF-8 JSON.'); }
  const settings = settingsFor(strictJson(text)), input = await readInput(args.input_path, { max_bytes: MAX_ID_PHOTO_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const image = await supportedImage(input.data), declared = rasterInputDimensions(image);
  if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Custom ID-photo crops accept still JPEG, PNG and WebP. Animated input is refused.');
  }
  if (!declared || ![declared.width, declared.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_ID_PHOTO_SIDE)
      || declared.width * declared.height > MAX_ID_PHOTO_INPUT_PIXELS) {
    throw new AdapterError('ID_PHOTO_DIMENSIONS', 'The declared source image must fit within 8192 pixels per side and 32 megapixels.');
  }
  if (!(settings.image_width === declared.width && settings.image_height === declared.height
      || settings.image_width === declared.height && settings.image_height === declared.width)) {
    throw new AdapterError('ID_PHOTO_COORDINATES', 'The declared display dimensions must agree with the source header, allowing only an orientation swap before native verification. Scaled-preview coordinates are unsupported.');
  }
  const plan = planFor(settings, input.data.length), made = await render({ ...input, kind: image.kind }, settings, plan, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const photo = Buffer.from(made.photo.data, 'base64'), sheet = Buffer.from(made.sheet.data, 'base64'); delete made.photo.data; delete made.sheet.data;
  await verifyJpeg(photo, plan.photo, settings.dpi); await verifyJpeg(sheet, plan.sheet.canvas, settings.dpi);
  options.signal?.throwIfAborted(); await mkdir(directory);
  const photoPath = path.join(directory, 'photo.jpg'), sheetPath = path.join(directory, 'sheet.jpg'), reportPath = path.join(directory, 'measurements.json'), owned = [];
  try {
    for (const [filename, data] of [[photoPath, photo], [sheetPath, sheet]]) {
      options.signal?.throwIfAborted(); await writeNew(filename, data); owned.push(filename);
    }
    const report = { custom_settings: settings, plan, jpeg_verification: { photo: made.photo, sheet: made.sheet },
      regulatory_approval: false, warning: 'Only the supplied custom measurements and source-engine geometry are checked. No identity, document eligibility or authority acceptance is determined.' };
    options.signal?.throwIfAborted(); await writeNew(reportPath, `${JSON.stringify(report, null, 2)}\n`); owned.push(reportPath);
    options.signal?.throwIfAborted();
  } catch (error) {
    for (const filename of owned) await rm(filename, { force: true }).catch(() => {});
    await rmdir(directory).catch(() => {}); throw error;
  }
  return { ok: true, operation: 'make-id-photo', input_path: input.path, input_bytes: input.data.length, output_dir: directory,
    output_count: 3, copies: plan.sheet.count, dpi: settings.dpi, format: 'jpeg', verified: true, manifest_path: reportPath,
    outputs: [{ output_path: photoPath, output_bytes: photo.length, width: plan.photo.width, height: plan.photo.height },
      { output_path: sheetPath, output_bytes: sheet.length, width: plan.sheet.canvas.width, height: plan.sheet.canvas.height }],
    verification: { declared_display_dimensions: true, custom_geometry: true, jpeg_decoded: true, jfif_density: true,
      lossy_pixels_checked: made.photo.pixels_checked + made.sheet.pixels_checked, pixel_identity: false },
    estimated_working_bytes: plan.estimated_working_bytes,
    warnings: ['Custom measurements are user supplied. No government profile, identity check or promise of document acceptance is applied.',
      'Landmarks use the decoded display orientation. JPEG is lossy, and physical print dimensions are rounded to whole pixels at the requested DPI.',
      'The chosen background only fills source transparency; it does not replace an existing background. Expression, lighting, likeness and current application requirements need separate review.'] };
}
