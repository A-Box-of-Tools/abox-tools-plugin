import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { localPath, MAX_INPUT_BYTES, newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_IMAGE_PDF_PAGES = 5000;
export const MAX_IMAGE_PDF_PIXELS = 80000000;
const PAGE_SIZES = ['fit', 'a3', 'a4', 'a5', 'letter', 'legal', 'tabloid'];

function settingsFor(args) {
  const settings = {
    pageSize: args.page_size ?? 'a4', orientation: args.orientation ?? 'auto',
    fit: args.fit ?? 'contain', margin: args.margin_mm ?? 0, dpi: args.dpi ?? 150,
    mode: args.image_mode ?? 'keep', quality: args.quality ?? 0.9,
    maxSide: args.max_side ?? 0, background: args.background ?? '#ffffff',
    title: '', author: '', dated: false,
  };
  if (!PAGE_SIZES.includes(settings.pageSize) || !['auto', 'portrait', 'landscape'].includes(settings.orientation)
      || !['contain', 'cover', 'stretch'].includes(settings.fit) || !['keep', 'jpeg', 'lossless'].includes(settings.mode)
      || !Number.isFinite(settings.margin) || settings.margin < 0 || settings.margin > 50
      || !Number.isFinite(settings.dpi) || settings.dpi < 18 || settings.dpi > 1200
      || !Number.isFinite(settings.quality) || settings.quality < 0.3 || settings.quality > 1
      || !Number.isInteger(settings.maxSide) || settings.maxSide < 0 || settings.maxSide > 16384
      || typeof settings.background !== 'string' || !/^#[a-f0-9]{6}$/i.test(settings.background)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose supported PDF page, image encoding, resolution, margin, and background settings.');
  }
  return settings;
}

async function inputPaths(values, signal) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_IMAGE_PDF_PAGES) {
    throw new AdapterError('PDF_INPUT_LIMIT', `Provide 1 to ${MAX_IMAGE_PDF_PAGES} input images, in page order.`);
  }
  const paths = [];
  let total = 0;
  // Check the whole batch before retaining file bytes or starting a browser.
  for (const value of values) {
    signal?.throwIfAborted();
    const input = localPath(await realpath(localPath(value)));
    const info = await stat(input);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
    if (!info.size || info.size > MAX_INPUT_BYTES) {
      throw new AdapterError('INPUT_SIZE', `Input files must contain 1 to ${MAX_INPUT_BYTES} bytes.`);
    }
    total += info.size;
    if (total > MAX_INPUT_BYTES) throw new AdapterError('PDF_TOTAL_SIZE', `The combined image inputs must not exceed ${MAX_INPUT_BYTES} bytes.`);
    paths.push(input);
  }
  return paths;
}

export async function imagesToPdf(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.pdf') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .pdf.');
  const paths = await inputPaths(args.input_paths, options.signal);
  const files = [];
  let inputBytes = 0;
  for (const filename of paths) {
    options.signal?.throwIfAborted();
    const input = await readInput(filename);
    inputBytes += input.data.length;
    if (inputBytes > MAX_INPUT_BYTES) throw new AdapterError('PDF_TOTAL_SIZE', `The combined image inputs must not exceed ${MAX_INPUT_BYTES} bytes.`);
    const item = await supportedImage(input.data);
    if (item.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
      throw new AdapterError('ANIMATED_IMAGE', 'Images to PDF supports still images. Animated PNG and WebP are refused to avoid dropping frames.');
    }
    files.push({ name: path.basename(input.path),
      mimeType: { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[item.kind], buffer: input.data });
  }
  const made = await withBrowser(async page => {
    await page.locator('#input').evaluate(input => { input.multiple = true; });
    await page.locator('#input').setInputFiles(files);
    return page.evaluate(async ({ settings: plan, pixelLimit }) => {
      const { buildDocument } = await import('/vendor/abox/tools/images-to-pdf/src/document.js');
      const { inspectJpeg } = await import('/vendor/abox/tools/images-to-pdf/src/jpeg.js');
      const { displaySize, layoutPage } = await import('/vendor/abox/tools/images-to-pdf/src/layout.js');
      const items = [];
      for (const file of document.querySelector('#input').files) {
        let bitmap;
        try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch { return { error: { code: 'IMAGE_DECODE_FAILED', message: 'The local browser could not decode an input image.' } }; }
        try {
          if (bitmap.width * bitmap.height > pixelLimit) {
            return { error: { code: 'IMAGE_PIXEL_LIMIT', message: 'Each image must contain at most 80 megapixels.' } };
          }
          const jpeg = /^image\/jpe?g$/i.test(file.type)
            ? inspectJpeg(new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer())) : null;
          items.push({ file, name: file.name, width: jpeg?.width ?? bitmap.width,
            height: jpeg?.height ?? bitmap.height, orientation: jpeg?.orientation ?? 1, rotate: 0 });
        } finally { bitmap.close(); }
      }
      const result = await buildDocument(items, plan);
      // Layout uses the encoded dimensions, including optional downscaling. The writer also corrects copied JPEG orientation.
      const pages = items.map(item => {
        const seen = displaySize(item.width, item.height, item.orientation, 0);
        const scale = plan.maxSide ? Math.min(1, plan.maxSide / Math.max(seen.width, seen.height)) : 1;
        const encoded = { width: Math.max(1, Math.round(seen.width * scale)),
          height: Math.max(1, Math.round(seen.height * scale)), orientation: 1, rotate: 0 };
        const layout = layoutPage(encoded, plan);
        return { width_pt: layout.width, height_pt: layout.height };
      });
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('The encoded PDF could not be read.'));
        reader.readAsDataURL(result.blob);
      });
      return { data, page_count: result.pages, copied_jpegs: result.copied, pages };
    }, { settings, pixelLimit: MAX_IMAGE_PDF_PIXELS });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  let doc;
  let pages;
  try {
    doc = await PdfDocument.open(new Uint8Array(data));
    pages = readSource(doc, path.basename(output)).pages;
  } catch { throw new AdapterError('VERIFICATION_FAILED', 'The output PDF could not be reopened.'); }
  if (made.page_count !== paths.length || doc.countPages() !== paths.length || pages.length !== paths.length
      || made.pages.length !== paths.length || pages.some((page, index) => {
        const expected = made.pages[index];
        return Math.abs(page.box[2] - page.box[0] - expected.width_pt) > 0.01
          || Math.abs(page.box[3] - page.box[1] - expected.height_pt) > 0.01;
      })) {
    throw new AdapterError('VERIFICATION_FAILED', 'The output PDF had unexpected page counts or dimensions.');
  }
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: 'images-to-pdf', input_count: paths.length, input_bytes: inputBytes,
    output_path: output, output_bytes: data.length, page_count: pages.length,
    pages: made.pages.slice(0, 20).map((page, index) => ({ input_path: paths[index], ...page })),
    pages_truncated: pages.length > 20, copied_jpegs: made.copied_jpegs,
    page_size: settings.pageSize, image_mode: settings.mode, dimensions_verified: true, verified: true,
    warnings: [
      ...(made.copied_jpegs ? ['Copied JPEG streams retain their original embedded metadata. Remove image metadata first if a clean copy is required.'] : []),
      ...(settings.mode === 'keep' ? ['Keep mode copies supported JPEGs and may re-encode opaque images from other formats. Choose lossless to preserve decoded pixels.'] : []),
    ],
  };
}
