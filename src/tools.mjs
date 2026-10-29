import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { findBrowser } from './browser.mjs';
import { compressImage } from './compress.mjs';
import { removeExif, inspectExif } from './exif.mjs';
import { editExif, MAX_EXIF_EDIT_INPUT_BYTES, MAX_EXIF_EDIT_OUTPUT_BYTES, MAX_EXIF_EDIT_CONFIG_BYTES, MAX_EXIF_EDIT_BYTES, MAX_EXIF_EDIT_TAGS, MAX_EXIF_EDIT_CHANGES } from './exif-edit.mjs';
import { hashLocalFile, MAX_HASH_BYTES } from './hash.mjs';
import { imagesToPdf, MAX_IMAGE_PDF_PAGES } from './images-pdf.mjs';
import { compressPdf } from './pdf-compress.mjs';
import { watermarkPdf } from './pdf-watermark.mjs';
import { imageToIco } from './icon.mjs';
import { svgToImage } from './svg.mjs';
import { layoutImages, MAX_LAYOUT_IMAGES, MAX_LAYOUT_SIDE, MAX_LAYOUT_PIXELS } from './image-layout.mjs';
import { pdfToCsv, MAX_CSV_DECOMPRESSED_STREAM_BYTES, MAX_CSV_DECOMPRESSED_BYTES, UNSUPPORTED_CSV_PDF_NAMES } from './pdf-csv.mjs';
import { formatJson, base64File, MAX_TEXT_INPUT_BYTES, MAX_TEXT_OUTPUT_BYTES, MAX_JSON_NODES } from './text.mjs';
import { imageToDataUri, MAX_DATA_URI_INPUT_BYTES, MAX_DATA_URI_OUTPUT_BYTES } from './data-uri.mjs';
import { convertYamlJson, formatXml, MAX_STRUCTURED_INPUT_BYTES, MAX_STRUCTURED_OUTPUT_BYTES, MAX_STRUCTURED_DEPTH, MAX_STRUCTURED_NODES } from './structured-text.mjs';
import { generateQr, generateBarcode, MAX_CODE_SIDE, MAX_CODE_PIXELS, MAX_QR_INPUT_BYTES, MAX_BARCODE_INPUT_BYTES } from './codes.mjs';
import { diffText, MAX_DIFF_INPUT_BYTES, MAX_DIFF_LINES, MAX_DIFF_OUTPUT_BYTES } from './text-diff.mjs';
import { formatCode, MAX_CODE_FORMAT_INPUT_BYTES, MAX_CODE_FORMAT_OUTPUT_BYTES, MAX_CODE_FORMAT_DEPTH, MAX_CODE_FORMAT_NODES } from './code-format.mjs';
import { convertXmlJson } from './xml-json.mjs';
import { renderMarkdown, MAX_MARKDOWN_INPUT_BYTES, MAX_MARKDOWN_OUTPUT_BYTES, MAX_MARKDOWN_LINES, MAX_MARKDOWN_LINE_LENGTH, MAX_MARKDOWN_NODES } from './markdown-html.mjs';
import { inspectGif, extractGifFrames, MAX_GIF_INPUT_BYTES, MAX_GIF_FRAMES, MAX_GIF_OUTPUTS, MAX_GIF_SIDE, MAX_GIF_PIXELS, MAX_GIF_DECODED_PIXELS, MAX_GIF_WALK_PIXELS, MAX_GIF_OUTPUT_BYTES, MAX_GIF_TOTAL_OUTPUT_BYTES } from './gif.mjs';
import { traceImageToSvg, stackImages, MAX_TRACE_PIXELS, MAX_TRACE_SIDE, MAX_TRACE_EDGES, MAX_TRACE_CONTOURS, MAX_TRACE_OUTPUT_BYTES, MAX_STACK_IMAGES, MAX_STACK_PIXELS, MAX_STACK_SIDE } from './image-vector-stack.mjs';
import { generatePasswords, redactImage, MAX_PASSWORD_CONFIG_BYTES, MAX_PASSWORD_OUTPUT_BYTES, MAX_PASSWORD_COUNT, MAX_REDACTION_CONFIG_BYTES, MAX_REDACTION_REGIONS, MAX_REDACTION_PIXELS, MAX_REDACTION_SIDE, MAX_REDACTION_WORK_PIXELS } from './password-redact.mjs';
import { readCodeImage, createGif, MAX_CODE_READ_INPUT_BYTES, MAX_CODE_READ_OUTPUT_BYTES, MAX_CODE_READ_SIDE, MAX_CODE_READ_PIXELS, MAX_GIF_CREATE_FRAMES, MAX_GIF_CREATE_SIDE, MAX_GIF_CREATE_TOTAL_PIXELS, MAX_GIF_CREATE_OUTPUT_BYTES } from './read-codes-gif-create.mjs';
import { protectPdf, unlockPdf, MAX_PDF_SECURITY_INPUT_BYTES, MAX_PDF_SECURITY_OUTPUT_BYTES, MAX_PDF_SECURITY_PAGES, MAX_PDF_PASSWORD_FILE_BYTES } from './pdf-security-redact.mjs';
import { editAudio, trimAudio, extractAudio, MAX_AUDIO_INPUT_BYTES, MAX_AUDIO_OUTPUT_BYTES, MAX_AUDIO_FRAMES, MAX_AUDIO_SAMPLES, MAX_AUDIO_DURATION, MAX_AUDIO_RANGES } from './audio.mjs';
import { inspectVideo, trimVideo, joinVideos, MAX_VIDEO_INPUT_BYTES, MAX_VIDEO_OUTPUT_BYTES, MAX_VIDEO_SAMPLES, MAX_VIDEO_CLIPS, MAX_VIDEO_RANGES, MAX_VIDEO_DURATION } from './video-copy.mjs';
import { rotateVideo, remuxVideo } from './video-rotate.mjs';
import { scanDocument, MAX_SCAN_CONFIG_BYTES, MAX_SCAN_PAGES, MAX_SCAN_SIDE, MAX_SCAN_PAGE_PIXELS, MAX_SCAN_TOTAL_PIXELS } from './document-scan.mjs';
import { makeIdPhoto, MAX_ID_PHOTO_INPUT_BYTES, MAX_ID_PHOTO_SETTINGS_BYTES, MAX_ID_PHOTO_SIDE, MAX_ID_PHOTO_INPUT_PIXELS, MAX_ID_PHOTO_OUTPUT_PIXELS, MAX_ID_PHOTO_COPIES } from './id-photo.mjs';
import { previewBusinessProfile, compareHeights, MAX_PREVIEW_CONFIG_BYTES, MAX_PREVIEW_OUTPUT_BYTES, MAX_HEIGHT_FIGURES } from './profile-heights.mjs';
import { extractReceipt, MAX_RECEIPT_INPUT_BYTES, MAX_RECEIPT_INPUT_PIXELS, MAX_RECEIPT_SIDE, MAX_RECEIPT_OUTPUT_BYTES } from './receipt-ocr.mjs';
import { inspectDicom, renderDicom, MAX_DICOM_INPUT_BYTES, MAX_DICOM_OUTPUT_BYTES, MAX_DICOM_SIDE, MAX_DICOM_PIXELS, MAX_DICOM_FRAMES, MAX_DICOM_TAGS, MAX_DICOM_RLE_FRAMES, MAX_DICOM_RLE_FRAGMENTS, MAX_DICOM_JPEG_FRAMES, MAX_DICOM_JPEG_FRAGMENTS } from './dicom.mjs';
import { imagesToVideo, gifToVideo, MAX_VIDEO_CREATE_IMAGES, MAX_VIDEO_CREATE_GIF_FRAMES, MAX_VIDEO_CREATE_GIF_BYTES, MAX_VIDEO_CREATE_GIF_PATCH_PIXELS, MAX_VIDEO_CREATE_SIDE, MAX_VIDEO_CREATE_PIXELS, MAX_VIDEO_CREATE_FRAMES, MAX_VIDEO_CREATE_SECONDS, MAX_VIDEO_CREATE_OUTPUT_BYTES } from './video-create.mjs';
import { resizeImage, convertImage } from './image.mjs';
import { convertHeic, convertAvif } from './heif-convert.mjs';
import { redactPdf } from './pdf-raster-redact.mjs';
import { compressVideo, cropVideo, grabVideoFrame, reverseVideo, timelapseVideo, videoToGif, bakeVideoRotation } from './video-decode.mjs';
import { MAX_HEIF_BYTES, MAX_HEIF_PIXELS, MAX_HEIF_SIDE, MAX_HEIF_ITEMS, MAX_HEIF_TOTAL_PIXELS } from './heif-admission.mjs';
import { splitPdf, mergePdf, selectPdfPages, rotatePdf, MAX_PAGES, MAX_OUTPUTS, MAX_PAGE_SELECTION_LENGTH } from './pdf.mjs';
import { MAX_INPUT_BYTES } from './files.mjs';
import { AdapterError } from './errors.mjs';
import { openShareSession, openCameraSession, openWalkieSession, openVoiceOncallSession, liveStatus, stopLiveSession, LIVE_LIMITS } from './live.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const filename = z.string().min(1).describe('Absolute local filesystem path. URLs and network shares are refused.');
const liveOptions = { room_name: z.string().max(80).regex(/^[^\u0000-\u001f\u007f]*$/).optional(), ttl_minutes: z.number().int().min(1).max(120).default(30) };
const shareSession = z.object({ role: z.enum(['host', 'reader']), ...liveOptions, room_name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional().describe('Optional share code; omit to generate it privately in the companion window.'), text_path: filename.optional(), input_paths: z.array(filename).max(LIVE_LIMITS.file_count).optional(), output_dir: filename.optional().describe('New directory for explicitly saved received content. Peer filenames are replaced with random safe names.') }).strict();
const cameraSession = z.object({ role: z.enum(['host', 'viewer']), ...liveOptions }).strict();
const walkieSession = z.object({ role: z.enum(['host', 'listener']), ...liveOptions }).strict();
const oncallSession = z.object({ role: z.enum(['host', 'sender']), ...liveOptions }).strict();
const liveSessionId = z.string().uuid();
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
const heicConvert = z.object({ input_path: filename, output_dir: filename, format: z.enum(['jpeg', 'png', 'webp']).default('jpeg'), quality: imageOptions.quality }).strict();
const avifConvert = z.object({ input_path: filename, output_path: filename, format: z.enum(['jpeg', 'png', 'webp']).default('png'), quality: imageOptions.quality }).strict();
const pdfRedact = z.object({ input_path: filename, output_path: filename, regions_path: filename, dpi: z.number().int().min(72).max(300).default(144) }).strict();
const videoCompressDecode = z.object({ input_path: filename, output_path: filename, target_bytes: z.number().int().min(100000).max(128 * 1024 * 1024), max_side: z.number().int().min(16).max(1920).default(1920), keep_audio: z.boolean().default(true) }).strict();
const videoCropDecode = z.object({ input_path: filename, output_path: filename, crop_path: filename, quality: z.enum(['low', 'medium', 'high']).default('medium'), keep_audio: z.boolean().default(true) }).strict();
const videoFrameDecode = z.object({ input_path: filename, output_path: filename, time_seconds: z.number().min(0).max(60).default(0) }).strict();
const audioExtract = z.object({ input_path: filename, output_path: filename, format: z.enum(['wav', 'm4a']).default('wav'), bits: z.union([z.literal(16), z.literal(32)]).optional(), channels: z.enum(['keep', 'mono']).optional() }).strict();
const videoReverseDecode = z.object({ input_path: filename, output_path: filename, quality: z.enum(['low', 'medium', 'high']).default('medium'), keep_audio: z.boolean().default(false) }).strict();
const videoTimelapseDecode = z.object({ input_path: filename, output_path: filename, speed: z.number().min(1.1).max(1000).default(10), fps: z.union([5, 10, 15, 24, 25, 30].map(value => z.literal(value))).default(30), max_side: z.number().int().min(16).max(1920).default(1280), quality: z.enum(['low', 'medium', 'high']).default('medium') }).strict();
const videoGifDecode = z.object({ input_path: filename, output_path: filename, start_seconds: z.number().min(0).max(60).default(0), end_seconds: z.number().min(0).max(60).optional(), fps: z.number().min(1).max(50).default(10), max_side: z.number().int().min(16).max(960).default(480), colors: z.number().int().min(4).max(255).default(255), dither: z.boolean().default(true), loop: z.boolean().default(true) }).strict();
const videoBakeDecode = z.object({ input_path: filename, output_path: filename, degrees: z.union([90, 180, 270].map(value => z.literal(value))).default(90), max_side: z.number().int().min(16).max(1920).default(1920), keep_audio: z.boolean().default(true) }).strict();
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
const dataUri = z.object({
  input_path: filename, output_path: filename,
  shape: z.enum(['uri', 'css-rule', 'css-var', 'html', 'markdown']).default('uri'),
  svg_encoding: z.enum(['auto', 'base64']).default('auto'),
  identifier: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/).optional(),
}).strict();
const yamlJson = z.object({
  input_path: filename, output_path: filename,
  direction: z.enum(['yaml-to-json', 'json-to-yaml']), indent: z.enum(['2', '4']).default('2'),
  sort_keys: z.boolean().default(false),
}).strict().refine(args => args.direction === 'yaml-to-json' || !args.sort_keys, {
  message: 'Key sorting is supported only for YAML to JSON conversion.',
});
const xml = z.object({
  input_path: filename, output_path: filename, minify: z.boolean().default(false),
  indent: z.enum(['2', '4', 'tab']).default('2'),
}).strict();
const codeStyle = {
  input_path: filename.describe('Absolute path of the UTF-8 payload file. Text is kept exact, including any final newline.'),
  output_path: filename, format: z.enum(['svg', 'png']).default('svg'),
  scale: z.number().int().min(1).max(32).default(4),
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
  background: imageOptions.background,
};
const qr = z.object({ ...codeStyle,
  level: z.enum(['L', 'M', 'Q', 'H']).default('M'), quiet: z.number().int().min(4).max(32).default(4),
}).strict();
const barcode = z.object({ ...codeStyle,
  symbology: z.enum(['code128', 'ean13', 'upca', 'ean8', 'itf14', 'itf', 'code39']).default('code128'),
  height: z.number().int().min(16).max(4096).default(100),
  text: z.boolean().default(true), code39_check: z.boolean().default(false),
}).strict();
const diff = z.object({
  left_path: filename, right_path: filename, output_path: filename,
  ignore_whitespace: z.boolean().default(false), ignore_case: z.boolean().default(false),
  ignore_blank_lines: z.boolean().default(false), context_lines: z.number().int().min(0).max(100).default(3),
}).strict();
const gifSplit = z.object({
  input_path: filename, output_dir: filename,
  mode: z.enum(['composited', 'stored']).default('composited'),
  frames: z.array(z.number().int().min(1).max(MAX_GIF_FRAMES)).min(1).max(MAX_GIF_OUTPUTS).optional()
    .refine(items => items === undefined || new Set(items).size === items.length, { message: 'Choose each GIF frame once.' }),
}).strict();
const gifInspect = z.object({
  input_path: filename, frame_offset: z.number().int().min(0).max(MAX_GIF_FRAMES - 1).default(0),
  frame_limit: z.number().int().min(1).max(100).default(20),
}).strict();
const trace = z.object({
  input_path: filename, output_path: filename,
  threshold: z.union([z.literal('otsu'), z.number().int().min(0).max(255)]).default('otsu'),
  invert: z.boolean().default(false),
  detail: z.union([z.literal('auto'), z.number().min(0.1).max(10)]).default('auto'),
  corner_angle: z.number().min(0).max(180).default(65), min_area: z.number().int().min(0).max(10000).default(2),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
}).strict();
const stack = z.object({
  input_paths: z.array(filename).min(2).max(MAX_STACK_IMAGES), output_path: filename,
  method: z.enum(['average', 'median', 'sigma', 'lighten', 'darken', 'add']).default('average'),
  format: z.enum(['png', 'jpeg']).default('png'), quality: z.number().min(0).max(1).default(0.92),
  kappa: z.number().min(0.1).max(10).optional(), gain: z.number().min(0.1).max(16).optional(),
}).strict().refine(args => args.kappa === undefined || args.method === 'sigma', { message: 'kappa applies only to sigma stacking.' })
  .refine(args => args.gain === undefined || args.method === 'add', { message: 'gain applies only to additive stacking.' });
const passwords = z.object({ output_path: filename, config_path: filename.optional().describe('Optional local UTF-8 JSON object. Common fields: mode=password or passphrase, count, password length, or passphrase words. Call capabilities for all supported configuration fields. Never place generated secrets in arguments.') }).strict();
const redact = z.object({ input_path: filename, output_path: filename,
  regions_path: filename.describe('Local UTF-8 JSON: {image_width, image_height, regions:[{x,y,width,height}]}. Dimensions must match decoded display pixels; whole 0-based rectangles must fit fully. Fixed black fill.'),
}).strict();
const codeRead = z.object({ input_path: filename, output_path: filename, thorough: z.boolean().default(true) }).strict();
const exifEdit = z.object({ input_path: filename, output_path: filename, edits_path: filename.describe('Local UTF-8 JSON with distinct set/remove EXIF tag instructions. Values stay in that file and the edited image.') }).strict();
const gifCreate = z.object({
  input_paths: z.array(filename).min(1).max(MAX_GIF_CREATE_FRAMES), output_path: filename,
  delay_ms: z.number().int().min(20).max(60000).optional(),
  delays_ms: z.array(z.number().int().min(20).max(60000)).min(1).max(MAX_GIF_CREATE_FRAMES).optional(),
  max_side: z.number().int().min(16).max(MAX_GIF_CREATE_SIDE).optional(),
  width: z.number().int().min(16).max(MAX_GIF_CREATE_SIDE).optional(), height: z.number().int().min(16).max(MAX_GIF_CREATE_SIDE).optional(),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'), background: imageOptions.background,
  colors: z.number().int().min(4).max(256).default(256), dither: z.boolean().default(true),
  shared_palette: z.boolean().default(false), transparent: z.boolean().default(false),
  loop: z.enum(['forever', 'once', 'count']).default('forever'), loop_count: z.number().int().min(1).max(65535).optional(),
}).strict().refine(args => args.delays_ms === undefined || args.delays_ms.length === args.input_paths.length, { message: 'Provide exactly one delay for each input image.' })
  .refine(args => (args.width === undefined) === (args.height === undefined), { message: 'Custom GIF width and height must be provided together.' })
  .refine(args => args.width === undefined || args.max_side === undefined, { message: 'Choose max_side or custom dimensions.' })
  .refine(args => (args.loop === 'count') === (args.loop_count !== undefined), { message: 'loop_count is required only for count mode.' });
const secretPath = filename.describe('Absolute path to an exact UTF-8 password file; contents, BOM and final newline are not trimmed. Never put the password itself into arguments.');
const pdfProtect = z.object({ input_path: filename, output_path: filename,
  open_password_file: secretPath.optional(), owner_password_file: secretPath.optional(),
  revision: z.union([z.literal(6), z.literal(4)]).default(6),
  restrict_print: z.boolean().default(false), restrict_copy: z.boolean().default(false), restrict_change: z.boolean().default(false),
}).strict();
const pdfUnlock = z.object({ input_path: filename, output_path: filename, password_file: secretPath.optional(), remove_metadata: z.boolean().default(true) }).strict();
const audioBits = z.union([z.literal(16), z.literal(32)]).default(16);
const timeRange = z.object({ start: z.number().min(0), end: z.number().positive() }).strict().refine(range => range.end > range.start, { message: 'A range end must follow its start.' });
const audioEdit = z.object({ input_path: filename, output_path: filename, bits: audioBits,
  reverse: z.boolean().default(false), speed: z.number().min(0.25).max(4).default(1), keep_pitch: z.boolean().default(true),
  volume_mode: z.enum(['gain', 'normalize']).default('gain'), gain_db: z.number().min(-60).max(24).optional(), normalize_db: z.number().min(-60).max(0).optional(),
}).strict().refine(args => args.volume_mode !== 'gain' || args.normalize_db === undefined, { message: 'normalize_db applies only to normalization.' })
  .refine(args => args.volume_mode !== 'normalize' || args.gain_db === undefined, { message: 'gain_db applies only to gain mode.' });
const audioTrim = z.object({ input_path: filename, output_path: filename, bits: audioBits,
  ranges: z.array(timeRange).min(1).max(MAX_AUDIO_RANGES), mode: z.enum(['keep', 'cut']).default('keep'), fade_ms: z.number().min(0).max(50).default(5),
}).strict();
const videoTrim = z.object({ input_path: filename, output_path: filename,
  ranges: z.array(timeRange).min(1).max(MAX_VIDEO_RANGES), keep_audio: z.boolean().default(true), allow_preroll: z.boolean().default(false),
}).strict();
const videoJoin = z.object({ input_paths: z.array(filename).min(2).max(MAX_VIDEO_CLIPS), output_path: filename, keep_audio: z.boolean().default(true) }).strict();

const scan = z.object({ input_paths: z.array(filename).min(1).max(MAX_SCAN_PAGES), output_path: filename, config_path: filename,
  format: z.enum(['pdf', 'png']).default('pdf'), mode: z.enum(['photo', 'colour', 'grey', 'mono']).default('colour'),
  strength: z.number().min(0).max(100).default(50), max_side: z.number().int().min(64).max(MAX_SCAN_SIDE).default(2800),
  page_size: z.enum(['fit', 'a4', 'a5', 'letter', 'legal']).optional(), dpi: z.number().min(36).max(1200).optional(),
  margin_mm: z.number().min(0).max(50).optional(), quality: z.number().min(0.3).max(1).optional(),
}).strict();
const idPhoto = z.object({ input_path: filename, output_dir: filename, settings_path: filename }).strict();
const previewOptions = { config_path: filename, output_path: filename, format: z.enum(['png', 'svg']).default('png'), scale: z.number().int().min(1).max(3).optional() };
const profile = z.object({ ...previewOptions, photo_path: filename.optional() }).strict();
const heights = z.object(previewOptions).strict();
const receipt = z.object({ input_path: filename, output_path: filename, format: z.enum(['json', 'csv']).default('json') }).strict();
const dicomRender = z.object({ input_path: filename, output_path: filename, frame: z.number().int().min(1).max(MAX_DICOM_FRAMES).default(1),
  window_center: z.number().min(-1e15).max(1e15).optional(), window_width: z.number().min(1).max(1e15).optional(), invert: z.boolean().default(false),
}).strict().refine(args => (args.window_center === undefined) === (args.window_width === undefined), { message: 'Provide window_center and window_width together.' });
const videoCreate = z.object({ input_paths: z.array(filename).min(1).max(MAX_VIDEO_CREATE_IMAGES), output_path: filename,
  width: z.number().int().min(16).max(MAX_VIDEO_CREATE_SIDE).default(1280), height: z.number().int().min(16).max(MAX_VIDEO_CREATE_SIDE).default(720),
  fps: z.union([1, 2, 5, 10, 15, 24, 25, 30].map(value => z.literal(value))).default(30),
  duration_ms: z.number().int().min(20).max(60000).default(1000), durations_ms: z.array(z.number().int().min(20).max(60000)).min(1).max(MAX_VIDEO_CREATE_IMAGES).optional(),
  fit: z.enum(['contain', 'cover', 'blur', 'stretch']).default('contain'), background: imageOptions.background,
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
}).strict().refine(args => args.width % 2 === 0 && args.height % 2 === 0 && args.width * args.height <= MAX_VIDEO_CREATE_PIXELS, { message: 'Video dimensions must be even and contain at most 1080p pixels.' })
  .refine(args => args.durations_ms === undefined || args.durations_ms.length === args.input_paths.length, { message: 'Provide exactly one duration for each image.' });
const gifVideo = z.object({ input_path: filename, output_path: filename, background: imageOptions.background,
  bitrate: z.number().int().min(400000).max(20000000).optional(),
}).strict();
const videoRotate = z.object({ input_path: filename, output_path: filename, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).default(90), keep_audio: z.boolean().default(true) }).strict();
const videoRemux = z.object({ input_path: filename, output_path: filename, keep_audio: z.boolean().default(true) }).strict();
const codeFormat = z.object({ input_path: filename, output_path: filename, language: z.enum(['html', 'css', 'yaml']),
  indent: z.enum(['2', '4', 'tab']).optional(), minify: z.boolean().optional(),
}).strict().refine(args => args.language !== 'yaml' || args.minify === undefined && args.indent !== 'tab', { message: 'YAML supports indent 2 or 4 and no minify option.' })
  .refine(args => !args.minify || args.indent === undefined, { message: 'Omit indent when minifying.' });
const xmlJson = z.object({ input_path: filename, output_path: filename, direction: z.enum(['xml-to-json', 'json-to-xml']), indent: z.enum(['2', '4', 'tab']).default('2') }).strict();
const markdown = z.object({ input_path: filename, output_path: filename }).strict();

export const tools = [
  { name: 'abox_share_session', title: 'Open a direct text and file sharing window', description: 'Open a visible local browser companion for abox.tools Share Text. Host may preload local files or a UTF-8 text file. The person clicks Start or Connect and approves each reader in the window. Existing abox.tools pairing sees IP addresses, timing and negotiation metadata; content goes directly over encrypted host-candidate WebRTC with no relay or discovery. Receive saves need a new output_dir and an explicit Save click; contents and pairing secrets are never returned to the agent. Requires directly reachable peers and an active graphical desktop. The window expires after 30 minutes by default.', schema: shareSession, run: openShareSession, openWorld: true },
  { name: 'abox_camera_session', title: 'Open a direct remote camera window', description: 'Open the local companion for abox.tools Remote Camera as host or viewer. The person clicks Start or Connect, grants camera permission, and approves viewers in the window. Pairing uses the existing abox.tools service; live media goes directly between peers with no relay or recording. No capture begins on opening the window. Pairing metadata reaches the service; no frames, notes or pairing secrets are returned to the agent.', schema: cameraSession, run: openCameraSession, openWorld: true },
  { name: 'abox_walkie_session', title: 'Open a direct voice broadcast window', description: 'Open the local companion for abox.tools Walkie Talkie as host or listener. The person starts pairing in the window. A host grants microphone permission and holds Talk to transmit; listeners need no microphone. The existing pairing service sees negotiation metadata; voice travels directly over encrypted host-candidate WebRTC with no relay, discovery or recording. Invitations and voice remain outside agent context.', schema: walkieSession, run: openWalkieSession, openWorld: true },
  { name: 'abox_voice_oncall_session', title: 'Open a direct voice inbox window', description: 'Open the local companion for abox.tools Voice Oncall as host or sender. The host listens and moderates incoming senders; a sender grants microphone permission and holds Talk. Start, invitations, optional passwords and approvals stay in the visible window. Existing abox.tools pairing receives negotiation metadata; voice goes directly between reachable peers, with no relay, discovery or recording. No sound or pairing secrets are returned to the agent.', schema: oncallSession, run: openVoiceOncallSession, openWorld: true },
  { name: 'abox_live_status', title: 'Check local live-session status', description: 'Return only session types, safe state, peer counts, capture kind, expiry and saved-file counts. Does not return pairing codes, invitations, received contents, device labels or media. Sessions belong to this adapter process.', schema: z.object({ session_id: liveSessionId.optional() }).strict(), run: liveStatus, readOnly: true },
  { name: 'abox_live_stop', title: 'Close a local live-session window', description: 'Close the selected companion browser, release capture and peer connections, and remove incomplete receive files. Completed local saves remain. Closing an already closed session is harmless.', schema: z.object({ session_id: liveSessionId }).strict(), run: stopLiveSession },
  { name: 'abox_video_reverse', title: 'Reverse a local H.264 video', description: 'Reverse admitted video frames into a new re-encoded H.264 MP4 and verify output timing and decoding. Silent by default. Explicit keep_audio:true also decodes and reverses matching-duration AAC using bounded packet audio processing and requires a native AAC encoder; requested sound is never silently dropped. Coded input geometry is checked before decoding. Requires a local browser and native codecs.', schema: videoReverseDecode, run: reverseVideo },
  { name: 'abox_video_timelapse', title: 'Make a local time-lapse video', description: 'Speed up admitted H.264 video into a silent new H.264 MP4 with explicit speed, frame rate, maximum side and quality. Reuses the website frame-selection and encoding engines, verifies decoded output frames and timing, and refuses fewer than two planned frames. Source audio and metadata are omitted. Requires a local browser and native H.264 encoding.', schema: videoTimelapseDecode, run: timelapseVideo },
  { name: 'abox_video_to_gif', title: 'Convert local video to GIF', description: 'Decode an admitted H.264 time range and write a bounded animated GIF using the website palette and encoding engines. Supports sampling rate, size, color count, dithering and looping. Verifies complete GIF streams, frame timing and quantized pixels. At most 200 frames and 16 million total frame pixels; color and timing are lossy, and sound is omitted. Requires a local browser.', schema: videoGifDecode, run: videoToGif },
  { name: 'abox_video_rotate_bake', title: 'Bake local video rotation into pixels', description: 'Decode admitted H.264 video and permanently turn its pixels by 90, 180 or 270 degrees into a newly encoded MP4 with identity display matrix. Verifies all generated frames and timing and exact copied AAC audio when requested. This applies source orientation as well as the additional turn; color and precision can change. Requires a local browser and native H.264 encoding.', schema: videoBakeDecode, run: bakeVideoRotation },
  { name: 'abox_audio_extract', title: 'Extract local audio', description: 'Extract admitted MP3 or AAC-LC audio into a new WAV, optionally mixing to mono, or copy AAC-LC packets exactly into a new audio-only M4A. Accepts bounded ordinary MP4/M4A/MOV audio tracks and AAC ADTS; ignores picture payloads and never decodes video. M4A copy needs no browser and refuses bits/channels controls. WAV uses bounded packet decoding in the installed local browser. No runtime encoder or dependency download.', schema: audioExtract, run: extractAudio },
  { name: 'abox_video_compress', title: 'Compress a local H.264 video', description: 'Decode an admitted H.264 MP4/MOV locally and re-encode a new MP4 toward a byte target using the website engine. Checks sequence headers and slice prefixes before decoding and verifies all generated frames and timestamps. Copies supported audio packets exactly when requested. Check fitted; the target can be missed and size or color can change. Requires an installed browser with native H.264 decode/encode support.', schema: videoCompressDecode, run: compressVideo },
  { name: 'abox_video_crop', title: 'Crop a local H.264 video', description: 'Crop an admitted H.264 MP4/MOV to exact local JSON coordinates in the decoded display image, then write a re-encoded MP4. Checks source coded geometry before decode, verifies all output frames/times and any copied audio packets. Color can change and unselected metadata is omitted. Requires a local browser with native H.264 support.', schema: videoCropDecode, run: cropVideo },
  { name: 'abox_video_frame', title: 'Extract a local video frame', description: 'Decode the admitted H.264 source frame at or before the requested time and save a new lossless PNG after source orientation. Checks coded geometry before decoding and compares every PNG pixel. Does not include audio, source text or metadata in the result. Requires a local browser with native H.264 decoding.', schema: videoFrameDecode, run: grabVideoFrame },
  { name: 'abox_pdf_redact', title: 'Permanently redact local PDF regions', description: 'Render every admitted unencrypted PDF page locally, replace explicitly selected rectangles with opaque black pixels, and write a fresh lossless image-only PDF. Local JSON supplies exact displayed page geometry and top-left point coordinates. Verifies every saved RGB sample, black masks and the new object graph; no source text, attachments, links, annotations or metadata objects are copied. All pages are flattened, searchable text and signatures are lost, and size can increase. Does not identify sensitive areas or prove selected coverage. Requires a local browser.', schema: pdfRedact, run: redactPdf },
  { name: 'abox_heic_convert', title: 'Convert local HEIC photos', description: 'Convert admitted HEVC still HEIC images, including one-level tiled grids, into a new directory of JPEG, PNG or WebP images. Uses the unchanged bundled website codec offline. Inspects all item extents, HEVC sequence dimensions and reference budgets before decode; verifies output dimensions and compares every output pixel. Includes all admitted top-level pictures. Metadata is omitted and output is 8-bit SDR; JPEG/WebP are lossy. Requires a local browser.', schema: heicConvert, run: convertHeic },
  { name: 'abox_avif_convert', title: 'Convert a local AVIF still image', description: 'Convert one admitted reduced-header AV1 still AVIF to a new PNG, JPEG or WebP using the website browser codecs. Inspects AV1 sequence and frame display dimensions before decoding and compares every output pixel. Refuses animation, movie tracks and unsupported derived layouts. Source metadata is omitted; color, HDR and precision may change. Requires a local browser.', schema: avifConvert, run: convertAvif },
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
  { name: 'abox_image_data_uri', title: 'Embed a local image as a data URI', description: 'Encode original image bytes into a new local .txt data URI, .css rule/custom property, .html image tag or .md image. Uses signature-based type detection and verifies byte preservation. Standalone UTF-8 SVG URIs can use percent encoding; SVG embedding shapes use Base64 to preserve bytes through their syntax. Keeps source metadata and SVG markup; does not verify rendering or sanitize SVG. Returns paths, sizes and metadata counts.', schema: dataUri, run: imageToDataUri },
  { name: 'abox_yaml_json', title: 'Convert local YAML and JSON files', description: 'Convert a local UTF-8 file between the website-supported YAML subset and JSON. Preserves ordered values, duplicate keys and large number tokens; formatting, string escapes and comments may change. YAML anchors, aliases, custom tags and multiple documents are unsupported. Optional natural key sorting on YAML to JSON. Writes and verifies a new .json or .yaml/.yml file; no contents returned.', schema: yamlJson, run: convertYamlJson },
  { name: 'abox_xml_format', title: 'Format a local XML file', description: 'Pretty-print or minify local UTF-8 XML using the existing website parser and printer. Preserves mixed content and xml:space behavior. Rejects DTDs and custom entities; no external resource resolution. Writes a new .xml file and verifies document structure and text. Formatting can change insignificant whitespace and quote spelling.', schema: xml, run: formatXml },
  { name: 'abox_qr_generate', title: 'Create a local QR code', description: 'Read exact UTF-8 payload text from a local file and generate a new SVG or PNG QR code using the website encoder. No redirect or hosted QR service. Verify by decoding the generated modules; PNG also verifies rendered pixels. SVG requires no browser; PNG uses the installed local browser. Payload contents never enter the tool result. Includes a minimum four-module quiet zone.', schema: qr, run: generateQr },
  { name: 'abox_barcode_generate', title: 'Create a local barcode', description: 'Read exact payload text from a local file and create a verified SVG or PNG Code 128, EAN-13, UPC-A, EAN-8, ITF-14, ITF or Code 39 barcode. Retail check digits are computed or validated; invalid supplied digits are refused. Source-defined quiet zones and optional human-readable labels. Verification capacity can limit long inputs. PNG requires a local browser. Payload and completed digits are not returned.', schema: barcode, run: generateBarcode },
  { name: 'abox_text_diff', title: 'Compare local text files', description: 'Compare two UTF-8 files and write a new unified .diff/.patch using the website bounded Myers engine. Verify that applying the patch to the left file exactly reconstructs the right, including line endings and final newlines. Ignore options affect comparison summaries only; the exported patch always describes the original files. Large rewrites can use coarse hunks. Returns counts and paths without source lines.', schema: diff, run: diffText },
  { name: 'abox_gif_inspect', title: 'Inspect a local GIF', description: 'Inspect bounded GIF headers, frame rectangles, timing, disposal and palette counts using the website analyzer. Does not decode or verify LZW pixels. Reports structural damage without modifying the input. Private comments, application text and palette values are excluded. Frame summaries are paginated using a zero-based offset.', schema: gifInspect, run: inspectGif, readOnly: true },
  { name: 'abox_gif_split', title: 'Extract local GIF frames', description: 'Extract selected or all GIF frames into a new local directory of lossless PNGs with a timing manifest. Default composited mode applies preceding frames and disposal; stored mode exports individual patches. Strict decoding refuses damaged or partial frames. Verifies each PNG pixel buffer. Requires the local browser for PNG encoding; does not scale frames.', schema: gifSplit, run: extractGifFrames },
  { name: 'abox_image_trace', title: 'Trace a local image into SVG', description: 'Trace a still JPEG, PNG or WebP into a single-color SVG path using the website mask, contour and curve engines. Best suited to logos and line art; this is a lossy shape interpretation. Supports automatic or explicit threshold, inversion and detail. Refuses overly complex traces. Writes and verifies a static path-only SVG; requires a local browser.', schema: trace, run: traceImageToSvg },
  { name: 'abox_image_stack', title: 'Stack local images', description: 'Combine 2 to 8 equal-size opaque still JPEG, PNG or WebP images using average, median, sigma-clipped, brightest, darkest or additive stacking from the website engine. No alignment, rescaling, RAW decoding or focus stacking in this version. Writes and verifies a new PNG/JPEG. Images must already line up; requires a local browser.', schema: stack, run: stackImages },
  { name: 'abox_password_generate', title: 'Generate passwords into a local file', description: 'Generate cryptographically random passwords or EFF-wordlist passphrases with the existing website engine. Writes secrets only to a new local .txt file; never returns secrets, secret hashes or samples. Defaults to one 24-character password. Optional bounded local JSON configuration selects supported settings. The output is plaintext; this is not a password vault.', schema: passwords, run: generatePasswords },
  { name: 'abox_image_redact', title: 'Redact regions in a local image', description: 'Permanently replace explicitly selected image rectangles with opaque black pixels using the website redaction engine. Read expected decoded image dimensions and rectangle coordinates from a local JSON file. Accepts still JPEG, PNG or WebP and writes a flattened PNG without copying source metadata. Verifies every decoded output pixel. Does not detect sensitive content or prove the chosen regions cover it. Requires the local browser.', schema: redact, run: redactImage },
  { name: 'abox_code_read', title: 'Read a code in a local image', description: 'Scan a still local JPEG, PNG or WebP for one QR code or supported linear barcode using the website readers. Write decoded text and parsed fields only into a new local JSON report. Tool results contain found/symbology and geometry, never payload text or URLs; links are never opened. A no-code image produces a found:false report. Requires a local browser.', schema: codeRead, run: readCodeImage },
  { name: 'abox_gif_create', title: 'Create a local animated GIF', description: 'Turn 1 to 32 ordered still JPEG, PNG or WebP images into a new GIF with per-frame timing, size, fit, palette, dithering, transparency and looping controls. Verifies complete LZW streams, timing, palette pixels and composited frames. GIF color quantization, resizing and centisecond timing are lossy. Requires a local browser.', schema: gifCreate, run: createGif },
  { name: 'abox_pdf_protect', title: 'Protect a local PDF', description: 'Encrypt an unencrypted or blank-open-password PDF with revision 6 AES-256 (default) or revision 4 AES-128, using passwords read from local UTF-8 files. Optional print/copy/change permission flags are advisory and depend on the viewer. Reopens and decrypts the new PDF to verify its reachable object graph and page count. Passwords never enter tool arguments or results. No password guessing.', schema: pdfProtect, run: protectPdf },
  { name: 'abox_pdf_unlock', title: 'Unlock a local PDF', description: 'Use a supplied local UTF-8 password file or a blank password to write a new unencrypted PDF with the existing website decryptor. Supports the source engine encryption revisions and verifies the reachable object graph after rewriting. Does not guess passwords. Standard metadata removal defaults to true; visible content and embedded metadata can remain. Signatures become invalid.', schema: pdfUnlock, run: unlockPdf },
  { name: 'abox_audio_edit', title: 'Edit local audio', description: 'Reverse, change speed with optional pitch preservation, apply gain or peak-normalize admitted PCM16/Float32 WAV, MP3 Layer III or AAC-LC ADTS/MP4/M4A/MOV audio. Compressed input is admitted and decoded in bounded packets. Writes PCM16 or Float32 WAV, verifies all encoded samples and reports clipping and bounded decoder priming omissions. Uses the existing website effects and local browser without network access.', schema: audioEdit, run: editAudio },
  { name: 'abox_audio_trim', title: 'Trim local audio', description: 'Keep ordered time ranges (including repeats) or cut marked ranges from admitted WAV, MP3 Layer III or AAC-LC audio. Fade joins by 5 ms by default; set fade_ms:0 for no fades. Times must fit the actual decoded audio, which can omit bounded priming samples. Source cut mode omits gaps of at most 1 ms. Writes a new WAV and verifies every encoded sample. Requires a local browser.', schema: audioTrim, run: trimAudio },
  { name: 'abox_video_inspect', title: 'Inspect a local MP4 or MOV', description: 'Inspect bounded MP4/MOV sample tables, track geometry, codecs and timing without decoding video or audio. Returns counts and technical headers without packet contents or metadata text. Incoming nonidentity edit lists are refused to avoid exposing hidden media. Requires no browser.', schema: inspect, run: inspectVideo, readOnly: true },
  { name: 'abox_video_trim', title: 'Trim local video without re-encoding', description: 'Copy selected MP4/MOV ranges into a new MP4 using the existing website sample-copy engine. Verifies every copied packet and output edit list. First non-keyframe cuts require explicit allow_preroll:true; later sections must start on keyframes. Encoded boundary footage can remain hidden by edit lists, so this is not redaction. Incoming edited timelines are refused. Requires no browser.', schema: videoTrim, run: trimVideo },
  { name: 'abox_video_join', title: 'Join local videos without re-encoding', description: 'Join 2 to 8 compatible MP4/MOV files in input order into a new MP4. Codec descriptions, dimensions, orientation and requested audio must agree. Verifies copied packet bytes, track descriptions and edit lists; performs no video or audio decoding. Incoming nonidentity edit lists are refused. Requires no browser.', schema: videoJoin, run: joinVideos },
  { name: 'abox_document_scan', title: 'Scan local document images', description: 'Perspective-correct explicit document corners from a local JSON file, then clean up photo, color, grayscale or monochrome pages into a new PDF or one PNG. Source warping insets edges by 3–6 pixels. Does not detect corners or perform OCR. Verifies rendered output pixels or PDF image payloads and page layout. Requires a local browser.', schema: scan, run: scanDocument },
  { name: 'abox_id_photo', title: 'Make a local ID photo and print sheet', description: 'Apply custom numeric photo rules and explicit crown, chin and eye landmarks from a local JSON settings file. Writes a JPEG photo, print sheet and measurement report into a new directory. No face detection, country rules or official approval. Checks geometry, DPI, output dimensions and lossy JPEG pixel error. Requires a local browser.', schema: idPhoto, run: makeIdPhoto },
  { name: 'abox_business_profile', title: 'Preview a local business profile', description: 'Render an illustrative business listing preview from a local JSON configuration into a passive SVG or PNG, using the website profile engine. Optional local photo is re-encoded. Does not contact or publish to Google or verify a real listing. Config text remains in the output file. Requires a local browser.', schema: profile, run: previewBusinessProfile },
  { name: 'abox_height_compare', title: 'Draw a local height comparison', description: 'Render locally configured figures, names and heights into a passive SVG or PNG using the existing website chart engine. Supports person silhouettes and plain object rectangles, technical ruler options and explicit units. Input names and heights remain in the output file. Requires a local browser.', schema: heights, run: compareHeights },
  { name: 'abox_receipt_extract', title: 'Extract a receipt into a local report', description: 'Run bundled English printed-text OCR on a local JPEG, PNG or WebP and write suggested receipt fields into JSON or CSV. All fields require human review; verification covers report structure, not recognition accuracy. Text, merchants and amounts stay in the local report. No uploads, model downloads, currency lookup or account access. Requires a local browser.', schema: receipt, run: extractReceipt },
  { name: 'abox_dicom_inspect', title: 'Inspect a local DICOM image', description: 'Inspect bounded flat PS3.10 DICOM files in known native transfer syntaxes or the strict one-frame RLE/JPEG-lossless subsets. Checks compressed geometry and complete stream structure before source decoding. Returns technical shape and counts without patient names, dates, private values or instance identifiers. Sequences and unsupported transforms are refused. Requires no browser.', schema: inspect, run: inspectDicom, readOnly: true },
  { name: 'abox_dicom_render', title: 'Render a local DICOM frame', description: 'Render one admitted integer monochrome or unsigned 8-bit RGB DICOM frame into PNG with an explicit or full-range technical window. Supports native pixels and strict one-frame/one-fragment RLE or JPEG-lossless. Independently checks stored samples and every output pixel. No diagnosis or clinical preset; burned-in identifiers can remain. Unsupported streams or source-decoder discrepancies are refused. Requires a local browser.', schema: dicomRender, run: renderDicom },
  { name: 'abox_images_to_video', title: 'Make a local video from images', description: 'Encode ordered still JPEG, PNG or WebP images into a silent H.264 MP4 with size, timing, fit and quality controls. Verifies all output frames, dimensions and timing. Limited to 60 seconds, 1800 frames and 1080p pixels. Requires a local browser with a supported native H.264 encoder; no external encoder download.', schema: videoCreate, run: imagesToVideo },
  { name: 'abox_gif_to_mp4', title: 'Convert a local GIF to MP4', description: 'Encode one verified GIF playback cycle into a silent H.264 MP4, preserving source frame timing and flattening transparency over a chosen background. Odd dimensions are padded. Verifies all output frames and timing. Requires a local browser with a supported native H.264 encoder; no external encoder download.', schema: gifVideo, run: gifToVideo },
  { name: 'abox_exif_edit', title: 'Edit local image EXIF tags', description: 'Set or remove selected EXIF tags in a JPEG, PNG or WebP using a bounded local JSON edits file. Reparse and verify exact raw tags, retained thumbnail, compressed picture payload and other container blocks. Other metadata remains; this is not anonymization. Rebuilt EXIF can invalidate undocumented maker-note offsets. Values never enter tool arguments or results. Requires no browser.', schema: exifEdit, run: editExif },
  { name: 'abox_video_rotate', title: 'Rotate a local video without re-encoding', description: 'Copy an admitted MP4/MOV video into a new MP4 with a 90, 180 or 270 degree display matrix rotation. Verifies every packet, timeline, description and matrix without decoding. Standard orientation and unsquashed geometry only; fragmented or edited timelines are refused. Sound must be AAC or explicitly omitted. Pixels are not baked into the new orientation; player support varies. Requires no browser.', schema: videoRotate, run: rotateVideo },
  { name: 'abox_video_remux', title: 'Repackage a local video as MP4', description: 'Copy admitted H.264 MP4/MOV picture packets and optional AAC sound into a new MP4 using the website conversion copy path. Preserves packet bytes, timing, descriptions and orientation; no re-encoding fallback. Fragmented or edited timelines and complex transforms are refused. Packet verification does not prove codec playback compatibility. Requires no browser.', schema: videoRemux, run: remuxVideo },
  { name: 'abox_code_format', title: 'Format local HTML, CSS or YAML', description: 'Pretty-print HTML/CSS/YAML or minify supported HTML/CSS with the existing website engines. Verifies protected raw text, supported syntax tokens or YAML values before saving. HTML formatting can change ordinary whitespace and implicit closing; this is not HTML sanitization or a promise of identical rendering. Never executes input or fetches linked resources. Requires no browser.', schema: codeFormat, run: formatCode },
  { name: 'abox_xml_json', title: 'Convert local XML and JSON', description: 'Convert XML to JSON using @ attributes, #text and repeated-child arrays, or JSON to XML under a fixed root element. Verifies the exact existing source mapping, which is lossy: XML values are strings, mixed child/text order and comments can be lost, and JSON null/empty containers collapse. Refuses ambiguous name collisions, DTDs and custom entities. Contents remain in the local output. Requires no browser.', schema: xmlJson, run: convertXmlJson },
  { name: 'abox_markdown_html', title: 'Render local Markdown to HTML', description: 'Render the website small Markdown dialect into a new standalone HTML file with a restrictive CSP. Verifies passive tag nesting and projected source text. Supports simple headings, flat lists, quotes, code, emphasis and safe-scheme links; no raw HTML, image rendering or automatic requests. Links remain clickable in the saved file and are never opened by the adapter. Requires no browser.', schema: markdown, run: renderMarkdown },
];

export async function capabilities() {
  const browser = await findBrowser();
  const upstream = JSON.parse(await readFile(new URL('../vendor/abox/provenance.json', import.meta.url), 'utf8'));
  return {
    ok: true, version: VERSION, publisher: 'Abox Technologies', processing: 'local-files-and-opt-in-live-sessions', file_processing: 'offline', max_input_bytes: MAX_INPUT_BYTES,
    live_sessions: { opt_in: true, visible_browser: true, starts_on_open: false, pairing_service: 'wss://rendezvous.abox.tools', metadata_logging_days: 7, content_transport: 'direct-host-candidate-webrtc', relay: false, discovery: false, recording: false, microphone_camera_permission: 'browser-user-prompt', limits: LIVE_LIMITS, default_ttl_minutes: 30, max_ttl_minutes: 120 },
    browser: { available: Boolean(browser), path: browser }, upstream_commit: upstream.commit,
    operations: [
      ...['abox_share_session', 'abox_camera_session', 'abox_walkie_session', 'abox_voice_oncall_session'].map(name => ({ name, processing: 'local-visible-companion', network_access: 'explicit-start-pairing-and-direct-peer', requires_browser: true, requires_graphical_desktop: true, returns_content: false, device_activation_on_open: false })),
      { name: 'abox_live_status', requires_browser: false, returns_content: false },
      { name: 'abox_live_stop', requires_browser: false, removes_incomplete_saves: true },
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
      { name: 'abox_image_data_uri', max_input_bytes: MAX_DATA_URI_INPUT_BYTES, max_output_bytes: MAX_DATA_URI_OUTPUT_BYTES, shapes: ['uri', 'css-rule', 'css-var', 'html', 'markdown'], bytes_preserved: true, rendering_verified: false, requires_browser: false },
      { name: 'abox_yaml_json', directions: ['yaml-to-json', 'json-to-yaml'], max_input_bytes: MAX_STRUCTURED_INPUT_BYTES, max_output_bytes: MAX_STRUCTURED_OUTPUT_BYTES, max_depth: MAX_STRUCTURED_DEPTH, max_nodes: MAX_STRUCTURED_NODES, requires_browser: false },
      { name: 'abox_xml_format', max_input_bytes: MAX_STRUCTURED_INPUT_BYTES, max_output_bytes: MAX_STRUCTURED_OUTPUT_BYTES, max_depth: MAX_STRUCTURED_DEPTH, max_nodes: MAX_STRUCTURED_NODES, dtd: false, external_entities: false, requires_browser: false },
      { name: 'abox_qr_generate', max_input_bytes: MAX_QR_INPUT_BYTES, formats: ['svg', 'png'], levels: ['L', 'M', 'Q', 'H'], minimum_quiet_modules: 4, max_side: MAX_CODE_SIDE, max_pixels: MAX_CODE_PIXELS, requires_browser_for: ['png'] },
      { name: 'abox_barcode_generate', max_input_bytes: MAX_BARCODE_INPUT_BYTES, formats: ['svg', 'png'], symbologies: ['code128', 'ean13', 'upca', 'ean8', 'itf14', 'itf', 'code39'], max_side: MAX_CODE_SIDE, max_pixels: MAX_CODE_PIXELS, verification_capacity_limits: true, requires_browser_for: ['png'] },
      { name: 'abox_text_diff', max_total_input_bytes: MAX_DIFF_INPUT_BYTES, max_total_lines: MAX_DIFF_LINES, max_output_bytes: MAX_DIFF_OUTPUT_BYTES, formats: ['diff', 'patch'], ignore_settings_affect_patch: false, minimality_guaranteed: false, requires_browser: false },
      { name: 'abox_gif_inspect', max_input_bytes: MAX_GIF_INPUT_BYTES, max_frames: MAX_GIF_FRAMES, header_only: true, lzw_verified: false, returns_metadata_text: false, requires_browser: false },
      { name: 'abox_gif_split', max_input_bytes: MAX_GIF_INPUT_BYTES, max_frames: MAX_GIF_FRAMES, max_outputs: MAX_GIF_OUTPUTS, max_side: MAX_GIF_SIDE, max_pixels: MAX_GIF_PIXELS, max_decoded_patch_pixels: MAX_GIF_DECODED_PIXELS, max_walk_pixels: MAX_GIF_WALK_PIXELS, max_output_bytes: MAX_GIF_OUTPUT_BYTES, max_total_output_bytes: MAX_GIF_TOTAL_OUTPUT_BYTES, modes: ['composited', 'stored'], output_format: 'png', requires_browser: true },
      { name: 'abox_image_trace', input_formats: ['jpeg', 'png', 'webp'], output_format: 'svg', max_side: MAX_TRACE_SIDE, max_pixels: MAX_TRACE_PIXELS, max_edges: MAX_TRACE_EDGES, max_contours: MAX_TRACE_CONTOURS, max_output_bytes: MAX_TRACE_OUTPUT_BYTES, single_color: true, requires_browser: true },
      { name: 'abox_image_stack', input_formats: ['jpeg', 'png', 'webp'], output_formats: ['png', 'jpeg'], max_inputs: MAX_STACK_IMAGES, max_side: MAX_STACK_SIDE, max_pixels: MAX_STACK_PIXELS, methods: ['average', 'median', 'sigma', 'lighten', 'darken', 'add'], equal_dimensions: true, opaque_inputs: true, alignment: false, raw_decode: false, requires_browser: true },
      { name: 'abox_password_generate', modes: ['password', 'passphrase'], max_config_bytes: MAX_PASSWORD_CONFIG_BYTES, max_output_bytes: MAX_PASSWORD_OUTPUT_BYTES, default_password_length: 24, default_passphrase_words: 6, max_count: MAX_PASSWORD_COUNT, returns_secrets: false, output_format: 'plaintext', requires_browser: false,
        configuration: { common: { mode: ['password', 'passphrase'], count: [1, MAX_PASSWORD_COUNT] },
          password: { length: [8, 128], lowercase: true, uppercase: true, digits: true, symbols: true, symbol_set: ['full', 'safe'], avoid_lookalikes: false, require_each: true },
          passphrase: { words: [4, 12], wordlist: ['long', 'short'], separator: ['hyphen', 'space', 'dot', 'underscore', 'none', 'digit'], capitalization: ['lower', 'title', 'upper'], add_digit: false, add_symbol: false } } },
      { name: 'abox_image_redact', input_formats: ['jpeg', 'png', 'webp'], output_format: 'png', max_config_bytes: MAX_REDACTION_CONFIG_BYTES, max_side: MAX_REDACTION_SIDE, max_pixels: MAX_REDACTION_PIXELS, max_regions: MAX_REDACTION_REGIONS, max_rectangle_work_pixels: MAX_REDACTION_WORK_PIXELS, solid_fill_only: true, sensitive_content_detection: false, requires_browser: true },
      { name: 'abox_code_read', input_formats: ['jpeg', 'png', 'webp'], output_format: 'json', max_input_bytes: MAX_CODE_READ_INPUT_BYTES, max_output_bytes: MAX_CODE_READ_OUTPUT_BYTES, max_side: MAX_CODE_READ_SIDE, max_pixels: MAX_CODE_READ_PIXELS, max_results: 1, returns_payload: false, requires_browser: true },
      { name: 'abox_gif_create', input_formats: ['jpeg', 'png', 'webp'], output_format: 'gif', max_inputs: MAX_GIF_CREATE_FRAMES, max_side: MAX_GIF_CREATE_SIDE, max_total_frame_pixels: MAX_GIF_CREATE_TOTAL_PIXELS, max_output_bytes: MAX_GIF_CREATE_OUTPUT_BYTES, requires_browser: true },
      { name: 'abox_pdf_protect', revisions: [6, 4], max_input_bytes: MAX_PDF_SECURITY_INPUT_BYTES, max_output_bytes: MAX_PDF_SECURITY_OUTPUT_BYTES, max_pages: MAX_PDF_SECURITY_PAGES, max_password_file_bytes: MAX_PDF_PASSWORD_FILE_BYTES, passwords_from_local_files: true, permission_flags_advisory: true, requires_browser: false },
      { name: 'abox_pdf_unlock', max_input_bytes: MAX_PDF_SECURITY_INPUT_BYTES, max_output_bytes: MAX_PDF_SECURITY_OUTPUT_BYTES, max_pages: MAX_PDF_SECURITY_PAGES, max_password_file_bytes: MAX_PDF_PASSWORD_FILE_BYTES, password_guessing: false, requires_browser: false },
      { name: 'abox_audio_edit', input_formats: ['wav-pcm16-or-float32', 'mp3-layer3', 'aac-lc-adts', 'mp4-m4a-mov-aac-lc'], output_formats: ['wav-pcm16', 'wav-float32'], max_input_bytes: MAX_AUDIO_INPUT_BYTES, max_output_bytes: MAX_AUDIO_OUTPUT_BYTES, max_duration_seconds: MAX_AUDIO_DURATION, max_frames: MAX_AUDIO_FRAMES, max_channel_samples: MAX_AUDIO_SAMPLES, max_channels: 2, max_packets: 24000, sample_rate_range: [8000, 96000], requires_browser: true },
      { name: 'abox_audio_trim', input_formats: ['wav-pcm16-or-float32', 'mp3-layer3', 'aac-lc-adts', 'mp4-m4a-mov-aac-lc'], max_ranges: MAX_AUDIO_RANGES, max_duration_seconds: MAX_AUDIO_DURATION, max_frames: MAX_AUDIO_FRAMES, max_channel_samples: MAX_AUDIO_SAMPLES, max_packets: 24000, requires_browser: true },
      { name: 'abox_video_inspect', input_formats: ['mp4', 'm4v', 'mov'], max_input_bytes: MAX_VIDEO_INPUT_BYTES, max_samples: MAX_VIDEO_SAMPLES, max_duration_seconds: MAX_VIDEO_DURATION, header_only: true, requires_browser: false },
      { name: 'abox_video_trim', input_formats: ['mp4', 'm4v', 'mov'], output_format: 'mp4', max_input_bytes: MAX_VIDEO_INPUT_BYTES, max_output_bytes: MAX_VIDEO_OUTPUT_BYTES, max_samples: MAX_VIDEO_SAMPLES, max_ranges: MAX_VIDEO_RANGES, reencoded: false, incoming_edit_lists: 'identity-only', secure_erasure: false, requires_browser: false },
      { name: 'abox_video_join', input_formats: ['mp4', 'm4v', 'mov'], output_format: 'mp4', max_inputs: MAX_VIDEO_CLIPS, max_total_input_bytes: MAX_VIDEO_INPUT_BYTES, max_output_bytes: MAX_VIDEO_OUTPUT_BYTES, max_samples: MAX_VIDEO_SAMPLES, requires_matching_codecs: true, reencoded: false, requires_browser: false },
      { name: 'abox_document_scan', input_formats: ['jpeg', 'png', 'webp'], output_formats: ['pdf', 'png'], max_config_bytes: MAX_SCAN_CONFIG_BYTES, max_pages: MAX_SCAN_PAGES, max_side: MAX_SCAN_SIDE, max_page_pixels: MAX_SCAN_PAGE_PIXELS, max_total_pixels: MAX_SCAN_TOTAL_PIXELS, explicit_corners: true, edge_inset_pixels: [3, 6], ocr: false, requires_browser: true },
      { name: 'abox_id_photo', max_input_bytes: MAX_ID_PHOTO_INPUT_BYTES, max_config_bytes: MAX_ID_PHOTO_SETTINGS_BYTES, max_side: MAX_ID_PHOTO_SIDE, max_input_pixels: MAX_ID_PHOTO_INPUT_PIXELS, max_output_pixels: MAX_ID_PHOTO_OUTPUT_PIXELS, max_copies: MAX_ID_PHOTO_COPIES, custom_rules_only: true, face_detection: false, official_approval: false, requires_browser: true },
      { name: 'abox_business_profile', max_config_bytes: MAX_PREVIEW_CONFIG_BYTES, max_output_bytes: MAX_PREVIEW_OUTPUT_BYTES, output_formats: ['png', 'svg'], publishes_listing: false, requires_browser: true },
      { name: 'abox_height_compare', max_config_bytes: MAX_PREVIEW_CONFIG_BYTES, max_output_bytes: MAX_PREVIEW_OUTPUT_BYTES, max_figures: MAX_HEIGHT_FIGURES, output_formats: ['png', 'svg'], requires_browser: true },
      { name: 'abox_receipt_extract', max_input_bytes: MAX_RECEIPT_INPUT_BYTES, max_output_bytes: MAX_RECEIPT_OUTPUT_BYTES, max_side: MAX_RECEIPT_SIDE, max_pixels: MAX_RECEIPT_INPUT_PIXELS, output_formats: ['json', 'csv'], language: 'eng', review_required: true, returns_recognized_text: false, network_access: false, requires_browser: true },
      { name: 'abox_dicom_inspect', max_input_bytes: MAX_DICOM_INPUT_BYTES, max_side: MAX_DICOM_SIDE, max_pixels: MAX_DICOM_PIXELS, max_frames: MAX_DICOM_FRAMES, max_tags: MAX_DICOM_TAGS, sequence_depth: 0, compressed_pixel_formats: ['rle', 'jpeg-lossless'], max_rle_frames: MAX_DICOM_RLE_FRAMES, max_rle_fragments: MAX_DICOM_RLE_FRAGMENTS, max_jpeg_frames: MAX_DICOM_JPEG_FRAMES, max_jpeg_fragments: MAX_DICOM_JPEG_FRAGMENTS, empty_compressed_offset_table: true, empty_rle_offset_table: true, returns_patient_fields: false, requires_browser: false },
      { name: 'abox_dicom_render', max_input_bytes: MAX_DICOM_INPUT_BYTES, max_output_bytes: MAX_DICOM_OUTPUT_BYTES, max_side: MAX_DICOM_SIDE, max_pixels: MAX_DICOM_PIXELS, max_frames: MAX_DICOM_FRAMES, compressed_pixel_formats: ['rle', 'jpeg-lossless'], anonymizes_pixels: false, clinical_interpretation: false, requires_browser: true },
      { name: 'abox_images_to_video', max_inputs: MAX_VIDEO_CREATE_IMAGES, max_side: MAX_VIDEO_CREATE_SIDE, max_pixels: MAX_VIDEO_CREATE_PIXELS, max_frames: MAX_VIDEO_CREATE_FRAMES, max_seconds: MAX_VIDEO_CREATE_SECONDS, max_output_bytes: MAX_VIDEO_CREATE_OUTPUT_BYTES, codec: 'h264', requires_native_encoder: true, requires_browser: true },
      { name: 'abox_gif_to_mp4', max_input_bytes: MAX_VIDEO_CREATE_GIF_BYTES, max_gif_frames: MAX_VIDEO_CREATE_GIF_FRAMES, max_decoded_patch_pixels: MAX_VIDEO_CREATE_GIF_PATCH_PIXELS, max_pixels: MAX_VIDEO_CREATE_PIXELS, max_seconds: MAX_VIDEO_CREATE_SECONDS, max_output_bytes: MAX_VIDEO_CREATE_OUTPUT_BYTES, cycles: 1, codec: 'h264', requires_native_encoder: true, requires_browser: true },
      { name: 'abox_exif_edit', input_formats: ['jpeg', 'png', 'webp'], max_input_bytes: MAX_EXIF_EDIT_INPUT_BYTES, max_output_bytes: MAX_EXIF_EDIT_OUTPUT_BYTES, max_config_bytes: MAX_EXIF_EDIT_CONFIG_BYTES, max_exif_bytes: MAX_EXIF_EDIT_BYTES, max_tags: MAX_EXIF_EDIT_TAGS, max_changes: MAX_EXIF_EDIT_CHANGES, compressed_picture_preserved: true, returns_tag_values: false, requires_browser: false },
      { name: 'abox_video_rotate', input_formats: ['mp4', 'm4v', 'mov'], output_format: 'mp4', degrees: [90, 180, 270], max_input_bytes: MAX_VIDEO_INPUT_BYTES, max_output_bytes: MAX_VIDEO_OUTPUT_BYTES, max_samples: MAX_VIDEO_SAMPLES, max_side: 32767, reencoded: false, baked_pixels: false, audio: 'aac-or-omit', requires_browser: false },
      { name: 'abox_video_remux', input_formats: ['mp4', 'm4v', 'mov'], output_format: 'mp4', picture_codecs: ['avc1', 'avc3'], max_input_bytes: MAX_VIDEO_INPUT_BYTES, max_output_bytes: MAX_VIDEO_OUTPUT_BYTES, max_samples: MAX_VIDEO_SAMPLES, max_side: 32767, reencoded: false, audio: 'aac-or-omit', requires_browser: false },
      { name: 'abox_code_format', languages: ['html', 'css', 'yaml'], minify_languages: ['html', 'css'], max_input_bytes: MAX_CODE_FORMAT_INPUT_BYTES, max_output_bytes: MAX_CODE_FORMAT_OUTPUT_BYTES, max_depth: MAX_CODE_FORMAT_DEPTH, max_nodes: MAX_CODE_FORMAT_NODES, sanitizes_html: false, requires_browser: false },
      { name: 'abox_xml_json', directions: ['xml-to-json', 'json-to-xml'], max_input_bytes: MAX_STRUCTURED_INPUT_BYTES, max_output_bytes: MAX_STRUCTURED_OUTPUT_BYTES, max_depth: MAX_STRUCTURED_DEPTH, max_nodes: MAX_STRUCTURED_NODES, mapping_lossy: true, semantic_round_trip: false, dtd: false, external_entities: false, requires_browser: false },
      { name: 'abox_markdown_html', max_input_bytes: MAX_MARKDOWN_INPUT_BYTES, max_output_bytes: MAX_MARKDOWN_OUTPUT_BYTES, max_lines: MAX_MARKDOWN_LINES, max_line_characters: MAX_MARKDOWN_LINE_LENGTH, max_nodes: MAX_MARKDOWN_NODES, output_format: 'html', raw_html: false, images: false, automatic_requests: false, requires_browser: false },
      { name: 'abox_heic_convert', input_format: 'heic-hevc-still', output_formats: ['jpeg', 'png', 'webp'], max_input_bytes: MAX_HEIF_BYTES, max_side: MAX_HEIF_SIDE, max_image_pixels: MAX_HEIF_PIXELS, max_items: MAX_HEIF_ITEMS, max_combined_image_pixels: MAX_HEIF_TOTAL_PIXELS, max_pictures: 16, tiled_grid: true, metadata_copied: false, requires_browser: true, runtime_downloads: false },
      { name: 'abox_pdf_redact', max_input_bytes: 32 * 1024 * 1024, max_config_bytes: 64 * 1024, max_pages: 32, max_side: 8192, max_page_pixels: 8_000_000, max_combined_pixels: 64_000_000, max_regions: 256, dpi: [72, 300], output_format: 'pdf-image-only-lossless', max_output_bytes: 128 * 1024 * 1024, copies_source_objects: false, detects_sensitive_content: false, requires_browser: true, runtime_downloads: false },
      { name: 'abox_avif_convert', input_format: 'avif-av1-reduced-still', output_formats: ['jpeg', 'png', 'webp'], max_input_bytes: MAX_HEIF_BYTES, max_side: MAX_HEIF_SIDE, max_image_pixels: MAX_HEIF_PIXELS, max_items: MAX_HEIF_ITEMS, max_combined_image_pixels: MAX_HEIF_TOTAL_PIXELS, max_pictures: 1, animation: false, metadata_copied: false, requires_browser: true },
      { name: 'abox_audio_extract', input_formats: ['wav-pcm16-or-float32', 'mp3-layer3', 'aac-lc-adts', 'mp4-m4a-mov-aac-lc'], output_formats: ['wav', 'm4a-aac-copy'], max_input_bytes: MAX_AUDIO_INPUT_BYTES, max_output_bytes: MAX_AUDIO_OUTPUT_BYTES, max_frames: MAX_AUDIO_FRAMES, max_channel_samples: MAX_AUDIO_SAMPLES, max_duration_seconds: MAX_AUDIO_DURATION, max_packets: 24000, video_decoded: false, requires_browser_for: ['wav'], exact_packet_copy: 'm4a' },
      ...['abox_video_compress', 'abox_video_crop', 'abox_video_frame', 'abox_video_reverse', 'abox_video_timelapse', 'abox_video_to_gif', 'abox_video_rotate_bake'].map(name => ({ name, input_formats: ['mp4', 'mov', 'm4v'], codec: 'h264-progressive-8bit-420', max_input_bytes: 64 * 1024 * 1024, max_coded_side: 4096, max_coded_pixels: 4_194_304, max_reference_frames: 4, max_frames: 1800, max_seconds: 60, max_output_bytes: ['abox_video_to_gif', 'abox_video_frame'].includes(name) ? 32 * 1024 * 1024 : 128 * 1024 * 1024, output_format: name === 'abox_video_frame' ? 'png' : name === 'abox_video_to_gif' ? 'gif' : 'mp4', max_output_video_pixels: 2_073_600, requires_browser: true, requires_native_encoder: !['abox_video_frame', 'abox_video_to_gif'].includes(name), ...(name === 'abox_video_to_gif' ? { max_gif_frames: 200, max_total_gif_frame_pixels: 16_000_000, max_gif_side: 960 } : {}), ...(name === 'abox_video_reverse' ? { max_total_frame_pixels: 96_000_000 } : {}), ...(name === 'abox_video_crop' ? { max_config_bytes: 16384 } : {}) })),
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
