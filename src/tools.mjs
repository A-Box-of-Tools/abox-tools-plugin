import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { findBrowser } from './browser.mjs';
import { compressImage } from './compress.mjs';
import { removeExif, inspectExif } from './exif.mjs';
import { hashLocalFile, MAX_HASH_BYTES } from './hash.mjs';
import { imagesToPdf, MAX_IMAGE_PDF_PAGES } from './images-pdf.mjs';
import { compressPdf } from './pdf-compress.mjs';
import { watermarkPdf } from './pdf-watermark.mjs';
import { imageToIco } from './icon.mjs';
import { svgToImage } from './svg.mjs';
import { layoutImages, MAX_LAYOUT_IMAGES, MAX_LAYOUT_SIDE, MAX_LAYOUT_PIXELS } from './image-layout.mjs';
import { pdfToCsv, MAX_CSV_DECOMPRESSED_STREAM_BYTES, MAX_CSV_DECOMPRESSED_BYTES, UNSUPPORTED_CSV_PDF_NAMES } from './pdf-csv.mjs';
import { formatJson, base64File, MAX_TEXT_INPUT_BYTES, MAX_TEXT_OUTPUT_BYTES, MAX_JSON_NODES } from './text.mjs';
import { resizeImage, convertImage } from './image.mjs';
import { splitPdf, mergePdf, selectPdfPages, rotatePdf, MAX_PAGES, MAX_OUTPUTS, MAX_PAGE_SELECTION_LENGTH } from './pdf.mjs';
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
const rotate = z.object({
  input_path: filename, output_path: filename,
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
  pages: z.string().min(1).max(MAX_PAGE_SELECTION_LENGTH).default('all').describe('All pages, or a 1-based selection such as 1,3-5. The entire document is retained in its original order.'),
  keep_bookmarks: z.boolean().default(true),
}).strict();
const inspect = z.object({ input_path: filename }).strict();
const imagesPdf = z.object({
  input_paths: z.array(filename).min(1).max(MAX_IMAGE_PDF_PAGES), output_path: filename,
  page_size: z.enum(['fit', 'a3', 'a4', 'a5', 'letter', 'legal', 'tabloid']).default('a4'),
  orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  margin_mm: z.number().min(0).max(50).default(0),
  dpi: z.number().min(18).max(1200).default(150),
  image_mode: z.enum(['keep', 'jpeg', 'lossless']).default('keep'),
  quality: z.number().min(0.3).max(1).default(0.9),
  max_side: z.number().int().min(0).max(16384).default(0),
  background: imageOptions.background,
}).strict();
const hash = z.object({
  input_path: filename,
  algorithms: z.array(z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512'])).min(1).max(5).default(['sha256'])
    .refine(items => new Set(items).size === items.length, { message: 'Choose each algorithm once.' }),
}).strict();
const pdfCompress = z.object({
  input_path: filename, output_path: filename,
  preset: z.enum(['smallest', 'screen', 'print', 'gentle']).default('screen'),
  dpi: z.number().min(0).max(1200).optional().describe('Optional resolution override. Zero disables image downsampling.'),
  quality: z.number().min(0.3).max(0.95).optional(),
  strip_metadata: z.boolean().default(true),
}).strict();
const watermark = z.object({
  input_path: filename, output_path: filename,
  text: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/).describe('One line of watermark text, at most 200 characters.'),
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  color: z.enum(['grey', 'red', 'blue']).default('grey'),
  opacity: z.number().min(0.05).max(1).default(0.2),
  diagonal: z.boolean().default(true), tiled: z.boolean().default(false),
  first_page_only: z.boolean().default(false),
}).strict();
const clearBackground = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null);
const ico = z.object({
  input_path: filename, output_path: filename,
  sizes: z.array(z.union([16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map(size => z.literal(size))))
    .min(1).max(10).default([16, 32, 48, 256])
    .refine(items => new Set(items).size === items.length, { message: 'Choose each icon size once.' }),
  fit: z.enum(['pad', 'crop', 'stretch']).default('pad'),
  storage: z.enum(['auto', 'png', 'bmp']).default('auto'), background: clearBackground,
}).strict();
const svg = z.object({
  input_path: filename, output_path: filename,
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  width: z.number().int().min(1).max(16384).optional(),
  height: z.number().int().min(1).max(16384).optional(),
  fit: z.enum(['fit', 'pad', 'stretch']).default('fit'),
  quality: z.number().min(0).max(1).default(0.92), background: clearBackground,
}).strict().refine(args => !args.width || !args.height || args.width * args.height <= 80000000, {
  message: 'SVG raster output must contain at most 80 megapixels.',
});
const layout = z.object({
  input_paths: z.array(filename).min(2).max(MAX_LAYOUT_IMAGES), output_path: filename,
  layout: z.enum(['grid', 'horizontal', 'vertical']).default('grid'),
  width: z.number().int().min(1).max(MAX_LAYOUT_SIDE).default(1600),
  columns: z.number().int().min(1).max(MAX_LAYOUT_IMAGES).optional(),
  ratio: z.enum(['square', 'landscape', 'portrait', 'original']).optional(),
  gap: z.number().int().min(0).max(MAX_LAYOUT_SIDE).default(16),
  padding: z.number().int().min(0).max(MAX_LAYOUT_SIDE).default(16),
  fit: z.enum(['contain', 'cover']).default('contain'),
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  quality: z.number().min(0).max(1).default(0.92), background: clearBackground,
}).strict().refine(args => args.layout !== 'grid' || args.ratio !== 'original', {
  message: 'Grid cells need a square, landscape or portrait ratio.',
}).refine(args => args.layout === 'grid' || args.columns === undefined, {
  message: 'Columns are only configurable for grid layouts.',
});
const csv = z.object({
  input_path: filename, output_path: filename,
  pages: z.string().min(1).max(MAX_PAGE_SELECTION_LENGTH).default('all')
    .describe('All pages, or an ascending unique 1-based selection such as 1,3-5.'),
  table_index: z.number().int().min(1).max(1000).optional().describe('Optional 1-based detected table; omitted exports all tables.'),
  date_order: z.enum(['auto', 'dmy', 'mdy']).default('auto'),
  include_headers: z.boolean().default(true), spreadsheet_safe: z.boolean().default(true),
}).strict();
const json = z.object({
  input_path: filename, output_path: filename, minify: z.boolean().default(false),
  indent: z.enum(['2', '4', 'tab']).default('2'), sort_keys: z.boolean().default(false),
}).strict();
const base64 = z.object({
  input_path: filename, output_path: filename, mode: z.enum(['encode', 'decode']),
  url_safe: z.boolean().default(false), canonical: z.boolean().default(false),
}).strict().refine(args => args.mode === 'decode' || !args.canonical, {
  message: 'Canonical validation applies only when decoding.',
});

export const tools = [
  { name: 'abox_capabilities', title: 'abox.tools local capabilities', description: 'List supported local operations, limits, and installed browser availability. Does not read user files.', schema: z.object({}).strict(), run: capabilities, readOnly: true },
  { name: 'abox_image_compress', title: 'Compress a local image', description: 'Compress a still JPEG, PNG, or WebP to a target byte count using the existing abox.tools search and local browser codecs. Writes a new local file. Check fitted; a target can be missed. Already-small files pass through with metadata. Auto can adjust the output extension.', schema: image, run: compressImage },
  { name: 'abox_image_resize', title: 'Resize a local image', description: 'Resize a still JPEG, PNG, or WebP with the existing abox.tools geometry and codecs. Specify width, height, or both. Contain fits the whole image; cover crops centrally. Upscaling is disabled by default. Writes and verifies a new local image; re-encoding may remove metadata.', schema: resize, run: resizeImage },
  { name: 'abox_image_convert', title: 'Convert a local image', description: 'Convert a still JPEG, PNG, or WebP into JPEG, PNG, or WebP using the existing abox.tools codecs. JPEG transparency is filled with the requested background. Writes a new local image and verifies its format and dimensions. Re-encoding may remove metadata.', schema: convert, run: convertImage },
  { name: 'abox_pdf_split', title: 'Split a local PDF', description: 'Split an unencrypted local PDF into one file per page, batches, or explicit range groups (1-based). Writes a new directory and reopens every PDF to count pages. Preserves page content but omits document tags, labels, attachments, metadata and unsupported actions; signatures become invalid.', schema: pdf, run: splitPdf },
  { name: 'abox_pdf_merge', title: 'Merge local PDFs', description: 'Combine 2 to 32 unencrypted local PDFs in input order into a new PDF. Total inputs are limited to 128 MiB and 5000 pages. Reopens the output and verifies its page count. Document tags, labels, attachments and metadata may be omitted; signatures become invalid.', schema: merge, run: mergePdf },
  { name: 'abox_pdf_select', title: 'Select and reorder local PDF pages', description: 'Extract, reorder or duplicate pages from an unencrypted local PDF into one new PDF. Page terms retain their order and duplicates; ranges expand ascending. Example: 3,1-2,3 produces four pages. Reopens the output and verifies its page count. Document-level structure may be omitted; signatures become invalid.', schema: select, run: selectPdfPages },
  { name: 'abox_pdf_rotate', title: 'Rotate local PDF pages', description: 'Rotate selected pages clockwise by 90, 180 or 270 degrees while retaining every page in its original order. Reopens the new PDF and verifies page rotations and geometry. Document-level structure may be omitted; signatures become invalid.', schema: rotate, run: rotatePdf },
  { name: 'abox_images_to_pdf', title: 'Create a PDF from local images', description: 'Place still JPEG, PNG or WebP images into a new PDF in the requested order, one per page. Supports paper sizes, margins and lossless or JPEG encoding with local browser codecs. Reopens and verifies page counts and dimensions. Keep mode can embed original JPEG metadata.', schema: imagesPdf, run: imagesToPdf },
  { name: 'abox_exif_inspect', title: 'Inspect local image metadata', description: 'Read the metadata inventory of a local JPEG, PNG or WebP without modifying it. Reports presence and counts of supported metadata blocks; private tag values and image bytes are not returned.', schema: inspect, run: inspectExif, readOnly: true },
  { name: 'abox_exif_remove', title: 'Remove local image metadata', description: 'Remove supported metadata from JPEG, PNG, or WebP containers without re-encoding image data. Re-inspects output. Defaults preserve an orientation-only EXIF block and ICC color profile when present. Writes a new local file; does not anonymize visible content.', schema: exif, run: removeExif },
  { name: 'abox_file_hash', title: 'Calculate local file checksums', description: 'Stream a local file through the existing abox.tools checksum engines. Supports empty files and files up to 8 GiB. Returns selected hexadecimal digests without file contents or modifications. SHA-256 is the default.', schema: hash, run: hashLocalFile, readOnly: true },
  { name: 'abox_pdf_compress', title: 'Compress a local PDF', description: 'Recompress supported PDF images and rewrite structure using the existing abox.tools engine. Presets trade image resolution and quality for size. Keeps page content streams and verifies page order and geometry; image pixels can change. Reports actual savings and may produce a larger file. No byte-target search. Writes a new unencrypted PDF; signatures become invalid.', schema: pdfCompress, run: compressPdf },
  { name: 'abox_pdf_watermark', title: 'Watermark a local PDF', description: 'Overlay one line of rasterized text on all pages or the first page of a local unencrypted PDF. Supports centered diagonal or horizontal stamps and tiled repeats. Uses installed browser fonts. Writes a new PDF and verifies stamp placement and page geometry. A watermark does not redact content or prevent editing; signatures become invalid.', schema: watermark, run: watermarkPdf },
  { name: 'abox_image_to_ico', title: 'Create a local ICO icon', description: 'Convert a still JPEG, PNG or WebP into one ICO containing requested icon sizes. Uses the existing abox.tools image rendering and ICO encoder, with padding, crop or stretch and transparent or solid background. Writes a new ICO and verifies its directory and image entries.', schema: ico, run: imageToIco },
  { name: 'abox_svg_to_image', title: 'Rasterize a local SVG', description: 'Render a local static self-contained SVG into PNG, JPEG or WebP using the existing abox.tools sizing and codecs. Refuses active content, animation and external resources. Supports intrinsic dimensions or a requested box, transparency and JPEG background. Writes and verifies a new raster image. Installed fonts can affect appearance.', schema: svg, run: svgToImage },
  { name: 'abox_image_layout', title: 'Combine local images into a layout', description: 'Arrange 2 to 32 still JPEG, PNG or WebP images in input order as a grid or horizontal/vertical strip using the existing abox.tools engine. Supports gaps, padding, contain or cover, cell ratios and transparency. Writes a new PNG/JPEG/WebP up to 8192 pixels per side and 32 megapixels. Grid defaults to two square columns; strips preserve original ratios. Re-encoding can change pixels and removes source metadata.', schema: layout, run: layoutImages },
  { name: 'abox_pdf_to_csv', title: 'Extract local PDF tables to CSV', description: 'Infer selectable-text tables in an unencrypted local PDF. Writes UTF-8 BOM CSV, comma delimiter, CRLF, blank rows between tables. No OCR. Dates and amounts may be normalized; ambiguous auto dates use day/month/year. Formula-like text is escaped by default. Review the CSV; structural verification does not prove accuracy. Conservative filter preflight accepts unfiltered/Flate without predictors and can also refuse blocked PDF names printed in text.', schema: csv, run: pdfToCsv },
  { name: 'abox_json_format', title: 'Format a local JSON file', description: 'Pretty-print or minify UTF-8 JSON using the existing abox.tools parser. Preserves numeric spellings, large integers, duplicate keys, escaped string tokens and object key order. Optional natural key sorting. Writes a new JSON file with a final newline and verifies tokens and structure. Input up to 8 MiB and 256 nesting levels; output up to 32 MiB. File contents are not returned.', schema: json, run: formatJson },
  { name: 'abox_base64', title: 'Encode or decode a local Base64 file', description: 'Encode arbitrary local file bytes as Base64 text or decode Base64 into a new binary file using the existing abox.tools byte codec. Supports standard padded or URL-safe unpadded encoding. Relaxed decoding accepts whitespace, either alphabet and missing padding; canonical decoding requires the requested exact spelling and zero unused bits. Supports empty files, verifies a byte round trip, and never returns file contents.', schema: base64, run: base64File },
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
      { name: 'abox_pdf_rotate', encrypted: false, max_pages: MAX_PAGES, degrees: [90, 180, 270], retains_all_pages: true },
      { name: 'abox_images_to_pdf', formats: ['jpeg', 'png', 'webp'], animated: false, max_inputs: MAX_IMAGE_PDF_PAGES, max_total_input_bytes: MAX_INPUT_BYTES, max_megapixels_per_image: 80, requires_browser: true, defaults: { page_size: 'a4', image_mode: 'keep' } },
      { name: 'abox_exif_inspect', formats: ['jpeg', 'png', 'webp'], read_only: true, returns_tag_values: false },
      { name: 'abox_exif_remove', formats: ['jpeg', 'png', 'webp'], defaults: { keep_orientation: true, keep_icc: true } },
      { name: 'abox_file_hash', algorithms: ['md5', 'sha1', 'sha256', 'sha384', 'sha512'], default_algorithm: 'sha256', max_input_bytes: MAX_HASH_BYTES, streaming: true, read_only: true },
      { name: 'abox_pdf_compress', encrypted: false, presets: ['smallest', 'screen', 'print', 'gentle'], max_pages: MAX_PAGES, max_megapixels_per_image: 80, requires_browser: true, defaults: { preset: 'screen', strip_metadata: true }, byte_target_search: false, jpeg_filters: ['DCTDecode', 'FlateDecode+DCTDecode'], jpeg_exif_orientation: 1 },
      { name: 'abox_pdf_watermark', encrypted: false, max_pages: MAX_PAGES, max_text_length: 200, max_stamp_count: 100000, requires_browser: true, rasterized: true, colors: ['grey', 'red', 'blue'] },
      { name: 'abox_image_to_ico', input_formats: ['jpeg', 'png', 'webp'], output_format: 'ico', sizes: [16, 20, 24, 32, 40, 48, 64, 96, 128, 256], max_megapixels: 80, requires_browser: true },
      { name: 'abox_svg_to_image', input_format: 'svg', output_formats: ['png', 'jpeg', 'webp'], animated: false, external_resources: false, max_side: 16384, max_megapixels: 80, requires_browser: true },
      { name: 'abox_image_layout', input_formats: ['jpeg', 'png', 'webp'], output_formats: ['png', 'jpeg', 'webp'], layouts: ['grid', 'horizontal', 'vertical'], max_inputs: MAX_LAYOUT_IMAGES, max_total_input_bytes: MAX_INPUT_BYTES, max_side: MAX_LAYOUT_SIDE, max_output_pixels: MAX_LAYOUT_PIXELS, max_megapixels_per_image: 80, animated: false, requires_browser: true },
      { name: 'abox_pdf_to_csv', encrypted: false, ocr: false, max_pages: MAX_PAGES, max_tables: 1000, max_output_bytes: 16 * 1024 * 1024, max_decompressed_stream_bytes: MAX_CSV_DECOMPRESSED_STREAM_BYTES, max_cumulative_decompressed_bytes: MAX_CSV_DECOMPRESSED_BYTES, refused_pdf_names: UNSUPPORTED_CSV_PDF_NAMES, conservative_filter_preflight: true, delimiter: ',', encoding: 'utf-8-bom', date_orders: ['auto', 'dmy', 'mdy'], defaults: { spreadsheet_safe: true, include_headers: true } },
      { name: 'abox_json_format', input_format: 'utf-8-json', max_input_bytes: MAX_TEXT_INPUT_BYTES, max_output_bytes: MAX_TEXT_OUTPUT_BYTES, max_depth: 256, max_syntax_nodes: MAX_JSON_NODES, preserves_numeric_tokens: true, preserves_duplicate_keys: true, requires_browser: false },
      { name: 'abox_base64', modes: ['encode', 'decode'], max_input_bytes: MAX_TEXT_INPUT_BYTES, max_output_bytes: MAX_TEXT_OUTPUT_BYTES, binary: true, empty_files: true, requires_browser: false },
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
