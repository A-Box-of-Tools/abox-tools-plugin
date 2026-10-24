import path from 'node:path';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { AdapterError } from './errors.mjs';

export async function compressImage(args, options = {}) {
  const input = await readInput(args.input_path);
  let output = await newOutput(args.output_path);
  const item = await supportedImage(input.data);
  if (item.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Compression supports still images. Animated PNG and WebP are refused to preserve animation.');
  }
  const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[item.kind];
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: path.basename(input.path), mimeType: mime, buffer: input.data });
    return page.evaluate(async settings => {
      const { compressOne, captureSettings } = await import('/vendor/abox/tools/compress-image/src/process.js');
      const { decode, release, encodableTypes } = await import('/vendor/abox/tools/compress-image/src/codecs.js');
      const file = document.querySelector('#input').files[0];
      const decoded = await decode(file);
      const size = { width: decoded.width, height: decoded.height };
      release(decoded.bitmap);
      if (size.width * size.height > 80000000) throw new Error('The image exceeds the 80 megapixel limit.');
      const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      const writable = await encodableTypes();
      const format = formats[settings.format] ?? settings.format;
      if (formats[settings.format] && !writable.has(format)) throw new Error('The installed browser cannot encode the requested format.');
      const plan = captureSettings({ targetBytes: settings.target_bytes, format, allowResize: settings.allow_resize }, writable);
      const result = await compressOne({ file, size }, plan, () => {});
      const checked = await decode(result.blob);
      const actual = { width: checked.width, height: checked.height };
      release(checked.bitmap);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the encoded image.'));
        reader.readAsDataURL(result.blob);
      });
      return {
        data, mime: result.mime, width: actual.width, height: actual.height,
        fitted: result.fitted, untouched: result.untouched, resized: Boolean(result.resized),
        encodes: result.encodes ?? 0, quality: result.quality ?? null,
        similarity: result.match ? { ssim: result.match.ssim, psnr_db: Number.isFinite(result.match.psnr) ? result.match.psnr : null } : null,
      };
    }, args);
  }, options);
  const data = Buffer.from(made.data, 'base64');
  delete made.data;
  if ((data.length <= args.target_bytes) !== made.fitted) throw new AdapterError('VERIFICATION_FAILED', 'The encoder size result was inconsistent.');
  // Auto explicitly permits a different format; the extension must describe the bytes.
  if (args.format === 'auto') {
    const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[made.mime];
    if (!extension) throw new AdapterError('VERIFICATION_FAILED', 'The encoder returned an unsupported format.');
    const current = path.extname(output);
    const stem = current ? output.slice(0, -current.length) : output;
    output = await newOutput(`${stem}${extension}`);
  }
  requireExtension(output, made.mime);
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: 'compress-image', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, target_bytes: args.target_bytes,
    verified: true, ...made,
    warnings: [
      ...(made.untouched ? ['The original already fits and was copied byte for byte; its metadata remains.'] : []),
      ...(!made.fitted ? ['The requested byte limit could not be met with these settings.'] : []),
    ],
  };
}
