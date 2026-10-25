import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { findBrowser } from './browser.mjs';
import { compressImage } from './compress.mjs';
import { removeExif } from './exif.mjs';
import { resizeImage, convertImage } from './image.mjs';
import { splitPdf, mergePdf, selectPdfPages, MAX_PAGES, MAX_OUTPUTS, MAX_PAGE_SELECTION_LENGTH } from './pdf.mjs';
import { MAX_INPUT_BYTES } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const filename = z.string().min(1).describe('Absolute local filesystem path. URLs and network shares are refused.');
const image = z.object({
  input_path: filename, output_path: filename,
  target_bytes: z.number().int().positive().max(MAX_INPUT_BYTES),
  format: z.enum(['keep', 'auto', 'jpeg', 'png', 'webp']).default('keep'),
  allow_resize: z.boolean().default(true),
}).strict();
const pdf = z.object({
  input_path: filename, output_dir: filename,
  mode: z.enum(['each', 'every', 'ranges']).default('each'),
  pages_per_file: z.number().int().min(1).max(MAX_PAGES).optional(),
  ranges: z.array(z.string().min(1).max(2000)).min(1).max(MAX_OUTPUTS).optional(),
  keep_bookmarks: z.boolean().default(true),
}).strict();
const exif = z.object({
  input_path: filename, output_path: filename,
  keep_orientation: z.boolean().default(true), keep_icc: z.boolean().default(true),
}).strict();
const imageOptions = {
  quality: z.number().min(0).max(1).default(0.92),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
};
const resize = z.object({
  input_path: filename, output_path: filename,
  width: z.number().int().min(1).max(32768).optional(),
  height: z.number().int().min(1).max(32768).optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
  allow_upscale: z.boolean().default(false),
  format: z.enum(['keep', 'jpeg', 'png', 'webp']).default('keep'),
  ...imageOptions,
}).strict().refine(args => args.width !== undefined || args.height !== undefined, {
  message: 'Specify width, height, or both.',
});
const convert = z.object({
  input_path: filename, output_path: filename,
  format: z.enum(['jpeg', 'png', 'webp']), ...imageOptions,
}).strict();
const merge = z.object({
  input_paths: z.array(filename).min(2).max(32), output_path: filename,
  keep_bookmarks: z.boolean().default(true),
}).strict();
const select = z.object({
  input_path: filename, output_path: filename,
  pages: z.string().min(1).max(MAX_PAGE_SELECTION_LENGTH).describe('1-based page terms in output order, such as 3,1-2,3. Ranges expand ascending; repeated terms retain duplicates.'),
  keep_bookmarks: z.boolean().default(true),
}).strict();

export const tools = [
  { name: 'abox_capabilities', title: 'abox.tools local capabilities', description: 'List supported local operations, limits, and installed browser availability. Does not read user files.', schema: z.object({}).strict(), run: capabilities, readOnly: true },
  { name: 'abox_image_compress', title: 'Compress a local image', description: 'Compress a still JPEG, PNG, or WebP to a target byte count using the existing abox.tools search and local browser codecs. Writes a new local file. Check fitted; a target can be missed. Already-small files pass through with metadata. Auto can adjust the output extension.', schema: image, run: compressImage },
  { name: 'abox_image_resize', title: 'Resize a local image', description: 'Resize a still JPEG, PNG, or WebP with the existing abox.tools geometry and codecs. Specify width, height, or both. Contain fits the whole image; cover crops centrally. Upscaling is disabled by default. Writes and verifies a new local image; re-encoding may remove metadata.', schema: resize, run: resizeImage },
  { name: 'abox_image_convert', title: 'Convert a local image', description: 'Convert a still JPEG, PNG, or WebP into JPEG, PNG, or WebP using the existing abox.tools codecs. JPEG transparency is filled with the requested background. Writes a new local image and verifies its format and dimensions. Re-encoding may remove metadata.', schema: convert, run: convertImage },
  { name: 'abox_pdf_split', title: 'Split a local PDF', description: 'Split an unencrypted local PDF into one file per page, batches, or explicit range groups (1-based). Writes a new directory and reopens every PDF to count pages. Preserves page content but omits document tags, labels, attachments, metadata and unsupported actions; signatures become invalid.', schema: pdf, run: splitPdf },
  { name: 'abox_pdf_merge', title: 'Merge local PDFs', description: 'Combine 2 to 32 unencrypted local PDFs in input order into a new PDF. Total inputs are limited to 128 MiB and 5000 pages. Reopens the output and verifies its page count. Document tags, labels, attachments and metadata may be omitted; signatures become invalid.', schema: merge, run: mergePdf },
  { name: 'abox_pdf_select', title: 'Select and reorder local PDF pages', description: 'Extract, reorder or duplicate pages from an unencrypted local PDF into one new PDF. Page terms retain their order and duplicates; ranges expand ascending. Example: 3,1-2,3 produces four pages. Reopens the output and verifies its page count. Document-level structure may be omitted; signatures become invalid.', schema: select, run: selectPdfPages },
  { name: 'abox_exif_remove', title: 'Remove local image metadata', description: 'Remove supported metadata from JPEG, PNG, or WebP containers without re-encoding image data. Re-inspects output. Defaults preserve an orientation-only EXIF block and ICC color profile when present. Writes a new local file; does not anonymize visible content.', schema: exif, run: removeExif },
];

export async function capabilities() {
  const browser = await findBrowser();
  const upstream = JSON.parse(await readFile(new URL('../vendor/abox/provenance.json', import.meta.url), 'utf8'));
  return {
    ok: true, version: VERSION, publisher: 'Abox Technologies', processing: 'local', max_input_bytes: MAX_INPUT_BYTES,
    browser: { available: Boolean(browser), path: browser }, upstream_commit: upstream.commit,
    operations: [
      { name: 'abox_image_compress', formats: ['jpeg', 'png', 'webp'], animated: false, max_megapixels: 80, requires_browser: true },
      { name: 'abox_image_resize', formats: ['jpeg', 'png', 'webp'], animated: false, fits: ['contain', 'cover'], max_megapixels: 80, requires_browser: true, defaults: { allow_upscale: false } },
      { name: 'abox_image_convert', input_formats: ['jpeg', 'png', 'webp'], output_formats: ['jpeg', 'png', 'webp'], animated: false, max_megapixels: 80, requires_browser: true },
      { name: 'abox_pdf_split', modes: ['each', 'every', 'ranges'], encrypted: false, max_pages: MAX_PAGES, max_outputs: MAX_OUTPUTS },
      { name: 'abox_pdf_merge', encrypted: false, max_inputs: 32, max_total_input_bytes: MAX_INPUT_BYTES, max_pages: MAX_PAGES },
      { name: 'abox_pdf_select', encrypted: false, max_pages: MAX_PAGES, preserves_requested_order: true, preserves_duplicates: true },
      { name: 'abox_exif_remove', formats: ['jpeg', 'png', 'webp'], defaults: { keep_orientation: true, keep_icc: true } },
    ],
  };
}

export async function execute(name, input = {}, options = {}) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new AdapterError('UNKNOWN_TOOL', `Unknown operation: ${name}`);
  const args = tool.schema.parse(input);
  if (name === 'abox_pdf_split') {
    if (args.mode === 'every' && args.pages_per_file === undefined) throw new AdapterError('INVALID_ARGUMENTS', 'pages_per_file is required for mode every.');
    if (args.mode === 'ranges' && !args.ranges?.length) throw new AdapterError('INVALID_ARGUMENTS', 'ranges is required for mode ranges.');
    if (args.mode !== 'ranges' && args.ranges !== undefined) throw new AdapterError('INVALID_ARGUMENTS', 'ranges is only valid with mode ranges.');
    if (args.mode !== 'every' && args.pages_per_file !== undefined) throw new AdapterError('INVALID_ARGUMENTS', 'pages_per_file is only valid with mode every.');
  }
  options.signal?.throwIfAborted();
  return tool.run(args, options);
}
