import path from 'node:path';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_RECEIPT_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_RECEIPT_INPUT_PIXELS = 4_000_000;
export const MAX_RECEIPT_SIDE = 4096;
export const MAX_RECEIPT_OUTPUT_BYTES = 2 * 2 ** 20;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export async function extractReceipt(args, options = {}) {
  options.signal?.throwIfAborted();
  const format = args.format === undefined ? 'json' : args.format;
  if (!['json', 'csv'].includes(format)) throw new AdapterError('INVALID_ARGUMENTS', 'Receipt output format must be json or csv.');
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== `.${format}`) throw new AdapterError('OUTPUT_EXTENSION', `Use a new .${format} output file.`);
  const input = await readInput(args.input_path, { max_bytes: MAX_RECEIPT_INPUT_BYTES }), image = await supportedImage(input.data);
  if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Receipt OCR accepts still JPEG, PNG or WebP images.');
  }
  const dimensions = rasterInputDimensions(image);
  if (!dimensions || ![dimensions.width, dimensions.height].every(value => Number.isInteger(value) && value > 0 && value <= MAX_RECEIPT_SIDE)
      || dimensions.width * dimensions.height > MAX_RECEIPT_INPUT_PIXELS) {
    throw new AdapterError('IMAGE_DIMENSIONS', 'Receipt OCR inputs must fit within 4096 pixels per side and 4 megapixels.');
  }
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: `source.${image.kind}`, mimeType: MIME[image.kind], buffer: input.data });
    return page.evaluate(async ({ format, maxSide, maxPixels, maxBytes }) => {
      const { recognize, terminateOcr } = await import('/vendor/abox/tools/receipt-invoice-extractor/src/ocr.js');
      const { receiptFromRecognition } = await import('/vendor/abox/tools/receipt-invoice-extractor/src/ocr-results.js');
      const { buildCsv } = await import('/vendor/abox/tools/receipt-invoice-extractor/src/receipt.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      let decoded, canvas;
      try {
        decoded = await codecs.decode(document.querySelector('#input').files[0]);
        const { width, height } = decoded;
        if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= maxSide) || width * height > maxPixels) {
          return { error: { code: 'IMAGE_DIMENSIONS', message: 'The decoded receipt exceeds the admitted dimensions.' } };
        }
        // A fixed upright page bounds every OCR recovery pass. The model and
        // WASM bytes are bundled scripts; connect-src remains disabled.
        const scale = Math.min(1, 2000 / Math.max(width, height));
        canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(decoded.bitmap, 0, 0, canvas.width, canvas.height); codecs.release(decoded.bitmap); decoded = null;
        const recognition = await recognize(canvas), receipt = receiptFromRecognition(recognition);
        const text = String(recognition.text ?? recognition.bodyText ?? '');
        if (!text.trim()) return { error: { code: 'OCR_NO_TEXT', message: 'The bundled English printed-text model found no readable text. No output was written.' } };
        const fields = ['merchant', 'date', 'reference', 'currency', 'amount'];
        const record = { filename: 'source-image', ...receipt, confirmed: false };
        const report = { schema_version: 1, language: 'eng', review_required: true, confirmed: false,
          image: { width, height, ocr_width: canvas.width, ocr_height: canvas.height },
          confidence: Number.isFinite(recognition.confidence) ? recognition.confidence : null, receipt,
          text, body_text: String(recognition.bodyText ?? ''), recovery_text: String(recognition.recoveryText ?? '') };
        const output = format === 'json' ? JSON.stringify(report, null, 2) + '\n' : '\ufeff' + buildCsv([record]);
        const bytes = new TextEncoder().encode(output);
        if (bytes.length > maxBytes) return { error: { code: 'OUTPUT_SIZE', message: 'The receipt report exceeds 2 MiB. No output was written.' } };
        return { text: output, width, height, ocr_width: canvas.width, ocr_height: canvas.height,
          recognized_characters: text.length, suggested_field_count: fields.filter(key => Boolean(receipt[key])).length,
          confidence: report.confidence };
      } catch { return { error: { code: 'OCR_FAILED', message: 'The bundled offline English OCR engine could not process this image. Image text is excluded from errors.' } }; }
      finally { terminateOcr(); codecs.release(decoded?.bitmap); if (canvas) canvas.width = canvas.height = 0; }
    }, { format, maxSide: MAX_RECEIPT_SIDE, maxPixels: MAX_RECEIPT_INPUT_PIXELS, maxBytes: MAX_RECEIPT_OUTPUT_BYTES });
  }, { ...options, wasm: true, workers: true });
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.text, 'utf8'); delete made.text;
  if (!data.length || data.length > MAX_RECEIPT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The receipt report exceeds 2 MiB.');
  if (format === 'json') {
    const report = JSON.parse(data.toString('utf8'));
    if (report.review_required !== true || report.confirmed !== false || typeof report.text !== 'string') {
      throw new AdapterError('VERIFICATION_FAILED', 'The local receipt report has an unexpected structure.');
    }
  } else if (!data.toString('utf8').startsWith('\ufeff"filename","merchant","date","reference","currency","amount","confirmed"\r\n')) {
    throw new AdapterError('VERIFICATION_FAILED', 'The local receipt CSV has an unexpected structure.');
  }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'receipt-extract', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format, language: 'eng', review_required: true,
    confirmed: false, verified: true, verification: { report_structure: true, extraction_accuracy: false, network_requests: false }, ...made,
    warnings: ['OCR and receipt fields are suggestions, not a verified ledger. Compare the saved text and every amount, currency and date with the original before using them.',
      'The bundled model reads English printed text. Handwriting, other scripts, tables and merchant logos may be wrong or incomplete. No exchange-rate service or account connection is used.',
      'Recognized text and financial values remain in the local report and are excluded from tool results.'] };
}
