import path from 'node:path';
import { makeQr } from '../vendor/abox/shared/js/qr.js';
import { makeBarcode, SYMBOLOGIES } from '../vendor/abox/tools/qr-barcode/src/barcode.js';
import { qrSvg, barcodeSvg, sizeOfSvg } from '../vendor/abox/tools/qr-barcode/src/render.js';
import { scanAdvisories } from '../vendor/abox/tools/qr-barcode/src/scan-advice.js';
import { decodeMatrix } from '../vendor/abox/tools/qr-barcode-reader/src/qr-decode.js';
import { readLinear } from '../vendor/abox/tools/qr-barcode-reader/src/linear.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_CODE_SIDE = 8192;
export const MAX_CODE_PIXELS = 32_000_000;
export const MAX_QR_INPUT_BYTES = 4096;
export const MAX_BARCODE_INPUT_BYTES = 256;
export const MAX_CODE_OUTPUT_BYTES = 16 * 1024 * 1024;

const failVerification = () => { throw new AdapterError('VERIFICATION_FAILED', 'The generated code could not be verified. No output was written.'); };

function settings(args, qr) {
  const plan = { format: args.format ?? 'svg', scale: args.scale ?? 4,
    foreground: args.foreground ?? '#000000', background: args.background ?? '#ffffff' };
  if (!['svg', 'png'].includes(plan.format) || !Number.isSafeInteger(plan.scale) || plan.scale < 1 || plan.scale > 32
      || [plan.foreground, plan.background].some(value => typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose SVG or PNG, an integer scale from 1 to 32, and six-digit hexadecimal foreground and background colors.');
  }
  plan.foreground = plan.foreground.toLowerCase();
  plan.background = plan.background.toLowerCase();
  if (plan.foreground === plan.background) throw new AdapterError('CODE_COLORS', 'The foreground and background must have different colors.');
  if (qr) {
    plan.level = args.level ?? 'M'; plan.quiet = args.quiet ?? 4;
    if (!['L', 'M', 'Q', 'H'].includes(plan.level) || !Number.isSafeInteger(plan.quiet) || plan.quiet < 4 || plan.quiet > 32) {
      throw new AdapterError('INVALID_ARGUMENTS', 'Choose QR correction level L/M/Q/H and an integer quiet margin from 4 to 32 modules.');
    }
  } else {
    plan.symbology = args.symbology ?? 'code128'; plan.height = args.height ?? 100;
    plan.text = args.text ?? true; plan.code39Check = args.code39_check ?? false;
    if (!SYMBOLOGIES.some(entry => entry.id === plan.symbology)
        || !Number.isSafeInteger(plan.height) || plan.height < 16 || plan.height > 4096
        || typeof plan.text !== 'boolean' || typeof plan.code39Check !== 'boolean'
        || plan.code39Check && plan.symbology !== 'code39') {
      throw new AdapterError('INVALID_ARGUMENTS', 'Choose a supported barcode symbology, an integer bar height from 16 to 4096, and boolean text/code39_check options. Code 39 checks apply only to Code 39.');
    }
  }
  return plan;
}

function dimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_CODE_SIDE)
      || width * height > MAX_CODE_PIXELS) {
    throw new AdapterError('CODE_DIMENSIONS', 'Code output exceeds the 8192-pixel side or 32 megapixel limit. Use a smaller scale or shorter payload.');
  }
  return { width, height };
}

async function payload(args, plan, qr) {
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== `.${plan.format}`) {
    throw new AdapterError('OUTPUT_EXTENSION', 'Use an output extension matching the requested SVG or PNG format.');
  }
  const input = await readInput(args.input_path, { max_bytes: qr ? MAX_QR_INPUT_BYTES : MAX_BARCODE_INPUT_BYTES });
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.data); }
  catch { throw new AdapterError('INPUT_ENCODING', 'The payload must be valid UTF-8 text. No output was written.'); }
  if (!qr && plan.text && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) {
    throw new AdapterError('BARCODE_LABEL', 'The payload contains characters that cannot appear in an XML barcode label. Disable text labels or use a supported payload.');
  }
  return { input, output, text };
}

function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function verifyRoot(svg, size, plan) {
  const root = /^<svg\s+([^>]*)>/.exec(svg);
  const got = root && attributes(root[1]);
  const found = sizeOfSvg(svg);
  if (!got || got.xmlns !== 'http://www.w3.org/2000/svg' || got.viewBox !== `0 0 ${size.width} ${size.height}`
      || found.width !== size.width || found.height !== size.height || !svg.endsWith('</svg>')
      || /<(?:script|image|style|foreignObject)\b/i.test(svg)
      || [...svg.matchAll(/<[^>]+>/g)].some(tag => /\s(?:on[\w-]+|href)\s*=/i.test(tag[0]))
      || !svg.includes(`<rect width="${size.width}" height="${size.height}" fill="${plan.background}"/>`)) failVerification();
}

function qrModulesFromSvg(svg, code, plan) {
  const paths = [...svg.matchAll(/<path\s+([^>]*)\/>/g)];
  if (paths.length !== 1) failVerification();
  const drawn = attributes(paths[0][1]);
  if (drawn.fill !== plan.foreground || typeof drawn.d !== 'string') failVerification();
  const modules = new Uint8Array(code.size * code.size);
  let consumed = 0;
  for (const run of drawn.d.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)) {
    if (run.index !== consumed) failVerification();
    consumed += run[0].length;
    const [x, y, width, height, back] = run.slice(1).map(Number);
    const column = x / plan.scale - plan.quiet, row = y / plan.scale - plan.quiet, count = width / plan.scale;
    if (![column, row, count].every(Number.isSafeInteger) || height !== plan.scale || back !== width
        || column < 0 || row < 0 || row >= code.size || count < 1 || column + count > code.size) failVerification();
    for (let at = 0; at < count; at++) {
      const index = row * code.size + column + at;
      if (modules[index]) failVerification();
      modules[index] = 1;
    }
  }
  if (consumed !== drawn.d.length || !Buffer.from(modules).equals(Buffer.from(code.modules))) failVerification();
  return modules;
}

function barcodeModulesFromSvg(svg, code, plan) {
  const modules = new Uint8Array(code.modules.length);
  let bars = 0;
  for (const rect of svg.matchAll(/<rect\s+([^>]*)\/>/g)) {
    const drawn = attributes(rect[1]);
    if (drawn.x === undefined) continue;
    const x = Number(drawn.x), width = Number(drawn.width), height = Number(drawn.height);
    const start = x / plan.scale, count = width / plan.scale;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1
        || start + count > modules.length || drawn.y !== '0' || drawn.fill !== plan.foreground
        || !Number.isSafeInteger(height) || height < plan.height) failVerification();
    for (let at = 0; at < count; at++) {
      if (modules[start + at]) failVerification();
      modules[start + at] = 1;
    }
    bars++;
  }
  const unescape = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const labels = [...svg.matchAll(/<text\s+[^>]*>([^<]*)<\/text>/g)].map(match => unescape(match[1]));
  if (!bars || !Buffer.from(modules).equals(Buffer.from(code.modules))
      || labels.length !== (plan.text ? code.labels.length : 0)
      || plan.text && labels.some((label, at) => label !== code.labels[at].text)) failVerification();
  return modules;
}

function verifyBarcode(modules, code, plan) {
  let runs = 1;
  for (let at = 1; at < modules.length; at++) if (modules[at] !== modules[at - 1]) runs++;
  if (runs > 400 || plan.symbology === 'itf' && (code.text.length < 4 || code.text.length > 40)) {
    throw new AdapterError('CODE_VERIFICATION_LIMIT', 'The barcode exceeds the independent reader limits: at most 400 alternating runs, and 4 to 40 digits for plain ITF. Use a shorter supported payload.');
  }
  const bits = new Uint8Array(modules.length * 3);
  for (let row = 0; row < 3; row++) bits.set(modules, row * modules.length);
  const decoded = readLinear(bits, modules.length, 3, 3);
  const expected = plan.symbology === 'code39' ? code.labels[0].text.slice(1, -1) : code.text;
  const equivalent = decoded && (decoded.format === plan.symbology && decoded.text === expected
    || plan.symbology === 'ean13' && expected.startsWith('0') && decoded.format === 'upca' && decoded.text === expected.slice(1)
    || plan.symbology === 'upca' && decoded.format === 'ean13' && decoded.text === `0${expected}`
    || ['itf', 'itf14'].includes(plan.symbology) && ['itf', 'itf14'].includes(decoded.format) && decoded.text === expected);
  if (!equivalent) failVerification();
}

async function encodeOutput(svg, modules, size, plan, qrSize, options) {
  const vector = Buffer.from(svg, 'utf8');
  if (!vector.length || vector.length > MAX_CODE_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The generated code exceeds the output byte limit.');
  if (plan.format === 'svg') return { data: vector, samples: 0 };
  const made = await withBrowser(page => page.evaluate(async ({ svg, bits, size, style, qrSize, maxBytes }) => {
    const { svgToPng } = await import('/vendor/abox/tools/qr-barcode/src/render.js');
    let bitmap, sample;
    try {
      const blob = await svgToPng(svg);
      if (blob.type !== 'image/png' || !blob.size || blob.size > maxBytes) return { error: 'output' };
      bitmap = await createImageBitmap(blob);
      if (bitmap.width !== size.width || bitmap.height !== size.height) return { error: 'dimensions' };
      sample = document.createElement('canvas'); sample.width = sample.height = 1;
      const context = sample.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      const color = hex => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).concat(255);
      const dark = color(style.foreground), light = color(style.background);
      const columns = qrSize ? qrSize + style.quiet * 2 : bits.length;
      const rows = qrSize ? columns : 1;
      let samples = 0;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const inside = !qrSize || row >= style.quiet && row < style.quiet + qrSize && column >= style.quiet && column < style.quiet + qrSize;
          const index = qrSize ? (row - style.quiet) * qrSize + column - style.quiet : column;
          const expected = inside && bits[index] === 1 ? dark : light;
          const x = column * style.scale + Math.floor(style.scale / 2);
          const y = qrSize ? row * style.scale + Math.floor(style.scale / 2) : Math.floor(style.height / 2);
          context.clearRect(0, 0, 1, 1); context.drawImage(bitmap, x, y, 1, 1, 0, 0, 1, 1);
          const actual = context.getImageData(0, 0, 1, 1).data;
          if (expected.some((value, at) => Math.abs(actual[at] - value) > 1)) return { error: 'pixels' };
          samples++;
        }
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject; reader.readAsDataURL(blob);
      });
      return { data, samples };
    } catch { return { error: 'render' }; }
    finally { bitmap?.close(); if (sample) sample.width = sample.height = 0; }
  }, { svg, bits: Array.from(modules), size, style: plan, qrSize, maxBytes: MAX_CODE_OUTPUT_BYTES }), options);
  if (made.error) failVerification();
  const data = Buffer.from(made.data, 'base64');
  if (data.length < 24 || data.length > MAX_CODE_OUTPUT_BYTES
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== size.width || data.readUInt32BE(20) !== size.height) failVerification();
  return { data, samples: made.samples };
}

function warnings(plan) {
  return [
    'Test the saved code with the intended scanner before printing or relying on it. Geometry and payload verification do not guarantee every scanner or print condition.',
    ...(scanAdvisories(plan).includes('scan.low') ? ['The selected colors have low contrast and may be difficult to scan.'] : []),
  ];
}

export async function generateQr(args, options = {}) {
  options.signal?.throwIfAborted();
  const plan = settings(args, true);
  const { input, output, text } = await payload(args, plan, true);
  options.signal?.throwIfAborted();
  let code;
  try { code = makeQr(text, { level: plan.level }, key => key); }
  catch { throw new AdapterError('QR_CAPACITY', 'The payload does not fit a QR code at the requested correction level. Use a shorter payload or a different level.'); }
  const side = (code.size + plan.quiet * 2) * plan.scale;
  const size = dimensions(side, side);
  const svg = qrSvg(code, plan);
  verifyRoot(svg, size, plan);
  const modules = qrModulesFromSvg(svg, code, plan);
  try {
    const decoded = decodeMatrix(code.size, modules);
    // The source reader treats an initial UTF-8 BOM as an encoding marker. Its
    // byte-segment count still verifies that the exact input bytes were stored.
    const expected = text.startsWith('\ufeff') ? text.slice(1) : text;
    if (decoded.text !== expected || decoded.level !== plan.level || decoded.corrections !== 0
        || text.startsWith('\ufeff') && (decoded.segments.length !== 1 || decoded.segments[0].mode !== 'byte'
          || decoded.segments[0].characters !== input.data.length)) failVerification();
  } catch { failVerification(); }
  const made = await encodeOutput(svg, modules, size, plan, code.size, options);
  options.signal?.throwIfAborted();
  await writeNew(output, made.data);
  return { ok: true, operation: 'qr-generate', input_path: input.path, input_bytes: input.data.length,
    output_path: output, output_bytes: made.data.length, format: plan.format, ...size,
    level: plan.level, version: code.version, modules_per_side: code.size, scale: plan.scale, quiet: plan.quiet,
    foreground: plan.foreground, background: plan.background, verified: true,
    verification: { svg_geometry: true, payload_decoded: true, png_pixel_samples: made.samples }, warnings: warnings(plan) };
}

export async function generateBarcode(args, options = {}) {
  options.signal?.throwIfAborted();
  const plan = settings(args, false);
  const { input, output, text } = await payload(args, plan, false);
  options.signal?.throwIfAborted();
  let code;
  try { code = makeBarcode(text, { symbology: plan.symbology, code39Check: plan.code39Check }, key => key); }
  catch { throw new AdapterError('BARCODE_PAYLOAD', 'The payload is unsupported for the selected barcode symbology, or its supplied check digit is invalid.'); }
  const fontSize = plan.text ? Math.max(8, plan.scale * 7) : 0;
  const size = dimensions(code.modules.length * plan.scale, plan.height + (plan.text ? fontSize + Math.round(fontSize * 0.25) : 0));
  const svg = barcodeSvg(code, plan);
  verifyRoot(svg, size, plan);
  const modules = barcodeModulesFromSvg(svg, code, plan);
  verifyBarcode(modules, code, plan);
  const made = await encodeOutput(svg, modules, size, plan, null, options);
  options.signal?.throwIfAborted();
  await writeNew(output, made.data);
  return { ok: true, operation: 'barcode-generate', input_path: input.path, input_bytes: input.data.length,
    output_path: output, output_bytes: made.data.length, format: plan.format, ...size,
    symbology: plan.symbology, scale: plan.scale, bar_height: plan.height, text: plan.text, code39_check: plan.code39Check,
    check_digit_added: ['ean13', 'ean8', 'upca', 'itf14'].includes(plan.symbology) && code.text.length > text.length,
    text_normalized: plan.symbology === 'code39' && text !== text.toUpperCase(),
    quiet: { ...code.quiet }, foreground: plan.foreground, background: plan.background, verified: true,
    verification: { svg_geometry: true, payload_decoded: true, png_pixel_samples: made.samples }, warnings: warnings(plan) };
}
