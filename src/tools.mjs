import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { findBrowser } from './browser.mjs';
import { compressImage } from './compress.mjs';
import { removeExif } from './exif.mjs';
import { splitPdf, MAX_PAGES, MAX_OUTPUTS } from './pdf.mjs';
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

export const tools = [
  { name: 'abox_capabilities', title: 'abox.tools local capabilities', description: 'List supported local operations, limits, and installed browser availability. Does not read user files.', schema: z.object({}).strict(), run: capabilities, readOnly: true },
  { name: 'abox_image_compress', title: 'Compress a local image', description: 'Compress a still JPEG, PNG, or WebP to a target byte count using the existing abox.tools search and local browser codecs. Writes a new local file. Check fitted; a target can be missed. Already-small files pass through with metadata. Auto can adjust the output extension.', schema: image, run: compressImage },
  { name: 'abox_pdf_split', title: 'Split a local PDF', description: 'Split an unencrypted local PDF into one file per page, batches, or explicit range groups (1-based). Writes a new directory and reopens every PDF to count pages. Preserves page content but omits document tags, labels, attachments, metadata and unsupported actions; signatures become invalid.', schema: pdf, run: splitPdf },
  { name: 'abox_exif_remove', title: 'Remove local image metadata', description: 'Remove supported metadata from JPEG, PNG, or WebP containers without re-encoding image data. Re-inspects output. Defaults preserve an orientation-only EXIF block and ICC color profile when present. Writes a new local file; does not anonymize visible content.', schema: exif, run: removeExif },
];

export async function capabilities() {
  const browser = await findBrowser();
  const upstream = JSON.parse(await readFile(new URL('../vendor/abox/provenance.json', import.meta.url), 'utf8'));
  return {
    ok: true, version: VERSION, processing: 'local', max_input_bytes: MAX_INPUT_BYTES,
    browser: { available: Boolean(browser), path: browser }, upstream_commit: upstream.commit,
    operations: [
      { name: 'abox_image_compress', formats: ['jpeg', 'png', 'webp'], animated: false, max_megapixels: 80, requires_browser: true },
      { name: 'abox_pdf_split', modes: ['each', 'every', 'ranges'], encrypted: false, max_pages: MAX_PAGES, max_outputs: MAX_OUTPUTS },
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
