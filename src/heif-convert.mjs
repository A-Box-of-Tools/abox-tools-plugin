import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { withBrowser } from './browser.mjs';
import { readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { supportedImage } from './exif.mjs';
import { admitHeif, MAX_HEIF_BYTES } from './heif-admission.mjs';
import { AdapterError } from './errors.mjs';

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
function settings(args) {
  const format = args.format ?? 'jpeg', quality = args.quality ?? 0.92;
  if (!Object.hasOwn(MIME, format) || !Number.isFinite(quality) || quality < 0 || quality > 1) throw new AdapterError('INVALID_ARGUMENTS', 'Choose jpeg, png or webp and quality between zero and one.');
  return { format, quality, mime: MIME[format] };
}
async function convert(args, options, codec) {
  const plan = settings({ ...args, format: args.format ?? (codec === 'avif' ? 'png' : 'jpeg') }); options.signal?.throwIfAborted();
  const input = await readInput(args.input_path, { max_bytes: MAX_HEIF_BYTES });
  const admitted = admitHeif(input.data, codec);
  if (codec === 'avif' && admitted.pictures.length !== 1) throw new AdapterError('UNSUPPORTED_HEIF', 'AVIF conversion requires one top-level still image.');
  const output = await newOutput(codec === 'heic' ? args.output_dir : args.output_path);
  if (codec === 'avif') requireExtension(output, plan.mime);
  let made;
  try {
    made = await withBrowser(async page => {
      await page.locator('#input').setInputFiles({ name: codec === 'heic' ? 'input.heic' : 'input.avif', mimeType: `image/${codec}`, buffer: input.data });
      return page.evaluate(async ({ codec, plan, admitted, maxBytes }) => {
        const file = document.querySelector('#input').files[0];
        const common = await import('/vendor/abox/shared/js/image-convert.js');
        const heic = codec === 'heic' ? await import('/vendor/abox/tools/heic-to-jpg/src/heif.js') : null;
        const writer = await import('/vendor/abox/tools/heic-to-jpg/src/codecs.js');
        if (!(await common.canEncode(plan.mime))) return { error: 'ENCODER_UNSUPPORTED' };
        const pictures = [];
        if (heic) pictures.push(...await heic.decodeHeic(new Uint8Array(await file.arrayBuffer())));
        else {
          const decoded = await common.decode(file);
          try { const canvas = document.createElement('canvas'); canvas.width = decoded.width; canvas.height = decoded.height; const ctx = canvas.getContext('2d'); ctx.drawImage(decoded.bitmap, 0, 0); pictures.push({ width: decoded.width, height: decoded.height, pixels: ctx.getImageData(0, 0, decoded.width, decoded.height).data }); canvas.width = canvas.height = 0; }
          finally { common.release(decoded.bitmap); }
        }
        if (pictures.length !== admitted.pictures.length) return { error: 'VERIFICATION_FAILED' };
        const outputs = []; let total = 0;
        for (let i = 0; i < pictures.length; i++) {
          const picture = pictures[i], expected = admitted.pictures[i];
          if (picture.width !== expected.width || picture.height !== expected.height || picture.pixels.length !== picture.width * picture.height * 4) return { error: 'VERIFICATION_FAILED' };
          const canvas = document.createElement('canvas'); canvas.width = picture.width; canvas.height = picture.height;
          const ctx = canvas.getContext('2d'); ctx.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
          // Compare canonical canvas samples, which account for premultiplication
          // of transparent color before a lossless image is encoded.
          let canonical;
          if (plan.mime === 'image/jpeg') {
            const white = document.createElement('canvas'); white.width = picture.width; white.height = picture.height;
            const wctx = white.getContext('2d'); wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, picture.width, picture.height); wctx.drawImage(canvas, 0, 0); canonical = wctx.getImageData(0, 0, picture.width, picture.height).data; white.width = white.height = 0;
          } else canonical = ctx.getImageData(0, 0, picture.width, picture.height).data;
          canvas.width = canvas.height = 0;
          const blob = await writer.encodePixels(picture, { mime: plan.mime, quality: plan.quality });
          total += blob.size; if (blob.type !== plan.mime || !blob.size || total > maxBytes * 2) return { error: 'OUTPUT_SIZE' };
          const check = await common.decode(blob); let mae = 0, maxError = 0;
          try {
            if (check.width !== picture.width || check.height !== picture.height) return { error: 'VERIFICATION_FAILED' };
            const c = document.createElement('canvas'); c.width = check.width; c.height = check.height;
            const x = c.getContext('2d'); x.drawImage(check.bitmap, 0, 0); const actual = x.getImageData(0, 0, c.width, c.height).data;
            for (let j = 0; j < actual.length; j++) { const error = Math.abs(actual[j] - canonical[j]); mae += error; maxError = Math.max(maxError, error); }
            mae /= actual.length; c.width = c.height = 0;
          } finally { common.release(check.bitmap); }
          if ((plan.format === 'png' && maxError !== 0) || (plan.format !== 'png' && mae > 40)) return { error: 'VERIFICATION_FAILED' };
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
          outputs.push({ data, width: picture.width, height: picture.height, pixel_mean_absolute_error: mae, primary: expected.primary });
        }
        return { outputs };
      }, { codec, plan, admitted, maxBytes: MAX_HEIF_BYTES });
    }, { ...options, wasm: codec === 'heic' });
  } catch (error) {
    if (error instanceof AdapterError || options.signal?.aborted) throw error;
    throw new AdapterError('HEIF_CONVERSION_FAILED', 'The admitted still image could not be decoded and verified locally.');
  }
  if (made.error) throw new AdapterError(made.error, 'The local image encoder could not produce a verified output within the supported limits.');
  const outputs = [];
  for (const [i, item] of made.outputs.entries()) {
    const data = Buffer.from(item.data, 'base64'); const checked = await supportedImage(data);
    if (checked.kind !== plan.format || !data.length || data.length > MAX_HEIF_BYTES * 2) throw new AdapterError('VERIFICATION_FAILED', 'The image output failed its container check.');
    outputs.push({ ...item, data, output_path: codec === 'heic' ? path.join(output, `image-${String(i + 1).padStart(3, '0')}.${EXT[plan.format]}`) : output });
  }
  options.signal?.throwIfAborted();
  if (codec === 'heic') await mkdir(output);
  try { for (const item of outputs) await writeNew(item.output_path, item.data); }
  catch (error) { if (codec === 'heic') await rm(output, { recursive: true, force: true }); throw error; }
  return { ok: true, operation: codec === 'heic' ? 'convert-heic' : 'convert-avif', input_path: input.path,
    ...(codec === 'heic' ? { output_dir: output } : { output_path: output }), input_bytes: input.data.length, format: plan.format,
    outputs: outputs.map(({ data, ...item }) => ({ ...item, output_bytes: data.length })), verified: true,
    verification: { codec_geometry_admitted_before_decode: true, output_dimensions: true, all_output_pixels_compared: true, lossless_pixels: plan.format === 'png', metadata_copied: false },
    warnings: ['Outputs are 8-bit SDR image copies. Color, HDR and precision can change; no source EXIF or other metadata is copied.', ...(plan.format === 'png' ? [] : ['Image encoding is lossy and can increase file size.'])] };
}
export function convertHeic(args, options = {}) { return convert(args, options, 'heic'); }
export function convertAvif(args, options = {}) { return convert(args, options, 'avif'); }
