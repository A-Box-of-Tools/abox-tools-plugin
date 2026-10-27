import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { sniff } from '../vendor/abox/tools/image-to-data-uri/src/sniff.js';
import { base64DataUri, svgDataUri, svgTextForUri } from '../vendor/abox/tools/image-to-data-uri/src/encode.js';
import { render, bundle, identifiers } from '../vendor/abox/tools/image-to-data-uri/src/shapes.js';
import { metadata, INSPECTS } from '../vendor/abox/tools/image-to-data-uri/src/metadata.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_DATA_URI_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_DATA_URI_OUTPUT_BYTES = 32 * 1024 * 1024;
const EXTENSIONS = { uri: '.txt', 'css-rule': '.css', 'css-var': '.css', html: '.html', markdown: '.md' };
const TYPES = { 'kind.exif': 'EXIF', 'kind.xmp': 'XMP', 'kind.icc': 'ICC', 'kind.iptc': 'IPTC',
  'kind.comment': 'comment', 'kind.text': 'text', 'kind.time': 'time' };

function encode(bytes, settings) {
  const kind = sniff(bytes);
  if (!kind) throw new AdapterError('UNSUPPORTED_IMAGE', 'The website engine does not recognize this image signature.');
  const svg = kind.mime === 'image/svg+xml';
  const sourceText = svg ? svgTextForUri(bytes) : null;
  // SVG's readable spelling is a URI, not an escaped HTML/CSS/Markdown string.
  // Base64 keeps each embedding layer from interpreting &, backslashes or spaces.
  const readable = svg && settings.svg_encoding === 'auto' && sourceText !== null && settings.shape === 'uri';
  const uri = readable ? svgDataUri(sourceText) : base64DataUri(bytes, kind.mime);
  const comma = uri.indexOf(',');
  const decoded = readable ? Buffer.from(decodeURIComponent(uri.slice(comma + 1)), 'utf8')
    : Buffer.from(uri.slice(comma + 1), 'base64');
  if (uri.slice(0, comma) !== `data:${kind.mime}${readable ? '' : ';base64'}`
      || !decoded.equals(Buffer.from(bytes))) {
    throw new AdapterError('VERIFICATION_FAILED', 'The generated data URI did not retain the original file bytes.');
  }
  const result = { uri, ident: settings.identifier, svg, width: 0, height: 0 };
  const text = settings.shape === 'css-var' ? bundle(settings.shape, [result]) : render(settings.shape, result);
  if (Buffer.byteLength(text) + 1 > MAX_DATA_URI_OUTPUT_BYTES || !text.includes(uri)) {
    throw new AdapterError('OUTPUT_SIZE', 'The generated image embedding exceeds the 32 MiB output limit.');
  }
  const scan = metadata(bytes, kind.mime);
  const inspected = INSPECTS.includes(kind.mime) && (!scan || scan.bytes <= bytes.length);
  return { data: new TextEncoder().encode(`${text}\n`), summary: {
    mime: kind.mime, encoding: readable ? 'percent' : 'base64', uri_characters: uri.length,
    bytes_preserved: true, image_decode_verified: false,
    metadata: { inspected, present: inspected ? Boolean(scan) : null,
      bytes: inspected ? scan?.bytes ?? 0 : null,
      kinds: inspected ? (scan?.kinds ?? []).map(key => TYPES[key] ?? 'other') : [] },
    warnings: [
      'Encoding preserves original bytes and metadata. Image type is identified by signature; rendering and file validity are not established.',
      ...(svg ? ['SVG markup is preserved without sanitizing its active content or external references.'] : []),
      ...(svg && sourceText === null && settings.svg_encoding === 'auto' ? ['This SVG is not exact UTF-8. Original-byte Base64 was used.'] : []),
      ...(svg && settings.shape !== 'uri' && settings.svg_encoding === 'auto' ? ['SVG embedding shapes use Base64 so HTML entities, CSS escapes and Markdown syntax cannot change its original bytes.'] : []),
      ...(kind.note ? ['This image format has limited browser rendering support.'] : []),
      ...(!inspected ? ['This image format or malformed container was not inspected for metadata.'] : []),
    ],
  } };
}

async function inWorker(bytes, settings, options) {
  const payload = Uint8Array.from(bytes);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-data-uri', bytes: payload, settings },
    transferList: [payload.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => {
        worker.removeAllListeners();
        error ? reject(error) : resolve(result);
      });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Image data URI encoding exceeded the two-minute limit. Use a smaller file.')), 120000);
    worker.on('message', message => message.error
      ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('IMAGE_ENCODING_FAILED', 'The isolated image encoding worker could not finish within its resource limits.')));
    worker.on('exit', () => finish(new AdapterError('IMAGE_ENCODING_FAILED', 'The image encoding worker stopped before producing an output.')));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function imageToDataUri(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = { shape: args.shape ?? 'uri', svg_encoding: args.svg_encoding ?? 'auto', identifier: args.identifier };
  if (!Object.hasOwn(EXTENSIONS, settings.shape) || !['auto', 'base64'].includes(settings.svg_encoding)
      || (settings.identifier !== undefined && (typeof settings.identifier !== 'string'
        || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(settings.identifier)))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose a supported embedding shape, auto/base64 SVG encoding and an optional simple CSS identifier up to 64 characters.');
  }
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== EXTENSIONS[settings.shape]) {
    throw new AdapterError('OUTPUT_EXTENSION', `Use an output filename ending in ${EXTENSIONS[settings.shape]}.`);
  }
  const input = await readInput(args.input_path, { max_bytes: MAX_DATA_URI_INPUT_BYTES });
  settings.identifier ??= identifiers([path.basename(input.path)])[0];
  // Each source byte needs at most three percent-encoded characters, plus the
  // bounded MIME/shape envelope. Reject expansion before constructing strings.
  if (input.data.length * 3 + settings.identifier.length + 512 > MAX_DATA_URI_OUTPUT_BYTES) {
    throw new AdapterError('OUTPUT_SIZE', 'The image exceeds the supported data URI expansion limit.');
  }
  options.signal?.throwIfAborted();
  const made = await inWorker(input.data, settings, options);
  const data = Buffer.from(made.data);
  if (!data.length || data.length > MAX_DATA_URI_OUTPUT_BYTES) throw new AdapterError('VERIFICATION_FAILED', 'The generated embedding has an unsupported size.');
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'image-to-data-uri', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, shape: settings.shape,
    identifier: ['css-rule', 'css-var'].includes(settings.shape) ? settings.identifier : null,
    verified: true, ...made.summary };
}

if (!isMainThread && workerData?.kind === 'abox-data-uri') {
  try {
    const result = encode(workerData.bytes, workerData.settings);
    parentPort.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'IMAGE_ENCODING_FAILED', message: 'The existing image embedding engine could not encode this input.' } });
  } finally { parentPort.close(); }
}
