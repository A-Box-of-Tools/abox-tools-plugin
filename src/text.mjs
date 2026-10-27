import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { parseJson, printJson } from '../vendor/abox/shared/js/parse-json.js';
import { ParseError, positionOf } from '../vendor/abox/shared/js/parse-errors.js';
import { bytesToBase64, base64ToBytes, CodecError } from '../vendor/abox/tools/base64/src/encode.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_TEXT_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_DEPTH = 256;
export const MAX_JSON_NODES = 250_000;
const TIMEOUT_MS = 120_000;

function settingsFor(args, kind) {
  if (kind === 'json') {
    const settings = { minify: args.minify ?? false, indent: args.indent ?? '2', sort_keys: args.sort_keys ?? false };
    if (typeof settings.minify !== 'boolean' || !['2', '4', 'tab'].includes(settings.indent) || typeof settings.sort_keys !== 'boolean') {
      throw new AdapterError('INVALID_ARGUMENTS', 'Choose boolean minify/sort_keys and indent 2, 4 or tab.');
    }
    return settings;
  }
  const settings = { mode: args.mode, url_safe: args.url_safe ?? false, canonical: args.canonical ?? false };
  if (!['encode', 'decode'].includes(settings.mode) || typeof settings.url_safe !== 'boolean' || typeof settings.canonical !== 'boolean') {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose encode or decode, with boolean url_safe and canonical settings.');
  }
  if (settings.mode === 'encode' && settings.canonical) throw new AdapterError('INVALID_ARGUMENTS', 'canonical is a decoding validation setting. Encoded output already uses canonical spelling.');
  return settings;
}

function utf8(bytes) {
  try {
    // Preserve a BOM as a real input character. Canonical Base64 must not gain
    // an invisible prefix exemption, and JSON's source parser owns its syntax.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw new AdapterError('INVALID_UTF8', 'The input must contain valid UTF-8 text.'); }
}

function jsonLimit(text, index, message) {
  const position = positionOf(text, index);
  const error = new AdapterError('JSON_LIMIT', `${message} At line ${position.line}, column ${position.column}.`);
  error.line = position.line; error.column = position.column;
  throw error;
}

function preflightJson(text) {
  let depth = 0, maximum = 0, nodes = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (' \t\r\n,:'.includes(char)) continue;
    if (char === '}' || char === ']') { depth = Math.max(0, depth - 1); continue; }
    nodes++;
    if (nodes > MAX_JSON_NODES) jsonLimit(text, at, 'JSON supports at most 250000 syntax nodes, including object keys.');
    if (char === '{' || char === '[') {
      depth++; maximum = Math.max(maximum, depth);
      if (depth > MAX_JSON_DEPTH) jsonLimit(text, at, 'JSON supports at most 256 nested containers.');
    } else if (char === '"') {
      for (at++; at < text.length; at++) {
        if (text[at] === '\\') at++;
        else if (text[at] === '"') break;
      }
    } else {
      // This is only an allocation preflight. The unchanged source parser
      // remains responsible for accepting tokens and reporting syntax errors.
      while (at + 1 < text.length && !' \t\r\n,:{}[]"'.includes(text[at + 1])) at++;
    }
  }
  return { node_count: nodes, max_depth: maximum };
}

function jsonOutputBytes(root, indent) {
  const indentation = indent.length, gap = indentation ? 1 : 0;
  const stack = [{ node: root, depth: 0 }];
  let bytes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (node.t === 'map' || node.t === 'seq') {
      const entries = node.t === 'map' ? node.pairs : node.items;
      const count = entries.length;
      bytes += 2;
      if (count) {
        bytes += gap * 2 + depth * indentation + (count - 1) * (1 + gap) + count * (depth + 1) * indentation;
        for (const entry of entries) {
          if (node.t === 'map') {
            bytes += Buffer.byteLength(entry.keyRaw, 'utf8') + (gap ? 2 : 1);
            stack.push({ node: entry.value, depth: depth + 1 });
          } else stack.push({ node: entry, depth: depth + 1 });
        }
      }
    } else if (node.t === 'str') bytes += Buffer.byteLength(node.raw, 'utf8');
    else if (node.t === 'num') bytes += node.raw.length;
    else if (node.t === 'bool') bytes += node.value ? 4 : 5;
    else bytes += 4;
    if (bytes > MAX_TEXT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'Formatted JSON exceeds the 32 MiB output limit. Use minify or smaller indentation.');
  }
  return bytes;
}

function formatJsonBytes(bytes, settings) {
  const decoded = utf8(bytes);
  const text = decoded.startsWith('\ufeff') ? decoded.slice(1) : decoded;
  const summary = preflightJson(text);
  const tree = parseJson(text);
  const indent = settings.minify ? '' : settings.indent === 'tab' ? '\t' : ' '.repeat(Number(settings.indent));
  const expectedBytes = jsonOutputBytes(tree, indent) + 1;
  if (expectedBytes > MAX_TEXT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'Formatted JSON exceeds the 32 MiB output limit including its final newline.');
  const options = { indent, sortKeys: settings.sort_keys };
  const formatted = printJson(tree, options);
  const output = `${formatted}\n`;
  if (Buffer.byteLength(output, 'utf8') !== expectedBytes) {
    throw new AdapterError('VERIFICATION_FAILED', 'The JSON formatter did not produce its predicted bounded output.');
  }
  const reparsed = parseJson(output);
  const canonical = { indent: '', sortKeys: settings.sort_keys };
  if (printJson(reparsed, canonical) !== printJson(tree, canonical) || printJson(reparsed, options) !== formatted) {
    throw new AdapterError('VERIFICATION_FAILED', 'The formatted JSON did not retain its ordered values and source tokens.');
  }
  return { data: new TextEncoder().encode(output), summary };
}

function base64Bytes(bytes, settings) {
  const profile = { urlSafe: settings.url_safe };
  let output;
  if (settings.mode === 'encode') {
    const maximum = Math.ceil(bytes.length / 3) * 4;
    if (maximum > MAX_TEXT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'Base64 output exceeds the 32 MiB limit.');
    const text = bytesToBase64(bytes, profile);
    const checked = base64ToBytes(text, { ...profile, canonical: true });
    if (!Buffer.from(checked).equals(Buffer.from(bytes))) throw new AdapterError('VERIFICATION_FAILED', 'The Base64 encoder did not pass binary round-trip verification.');
    output = new TextEncoder().encode(text);
  } else {
    const text = utf8(bytes);
    output = base64ToBytes(text, { ...profile, canonical: settings.canonical });
    const canonical = bytesToBase64(output, profile);
    const checked = base64ToBytes(canonical, { ...profile, canonical: true });
    if (!Buffer.from(checked).equals(Buffer.from(output))) throw new AdapterError('VERIFICATION_FAILED', 'The decoded Base64 did not pass binary round-trip verification.');
  }
  if (output.length > MAX_TEXT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The decoded output exceeds the 32 MiB limit.');
  return { data: output, summary: {} };
}

function publicFailure(error) {
  if (error instanceof ParseError) return { code: 'INVALID_JSON',
    message: `Invalid JSON at line ${error.line}, column ${error.column}.`, line: error.line, column: error.column };
  if (error instanceof CodecError) return { code: 'INVALID_BASE64', message: 'The input does not match the selected Base64 decoding profile.' };
  if (error instanceof AdapterError) return { code: error.code, message: error.message,
    ...(Number.isSafeInteger(error.line) ? { line: error.line, column: error.column } : {}) };
  return { code: 'TEXT_PROCESSING_FAILED', message: 'The existing text engine could not process this input. No output was written.' };
}

async function runWorker(bytes, kind, settings, options) {
  const payload = Uint8Array.from(bytes);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-local-text', job: kind, bytes: payload, settings },
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
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Local text processing exceeded the two-minute limit. Use a smaller input.')), TIMEOUT_MS);
    worker.on('message', message => {
      if (message.type === 'result') finish(null, message.result);
      else if (message.type === 'error') {
        const error = new AdapterError(message.error.code, message.error.message);
        if (Number.isSafeInteger(message.error.line)) { error.line = message.error.line; error.column = message.error.column; }
        finish(error);
      }
    });
    worker.on('error', () => finish(new AdapterError('TEXT_PROCESSING_FAILED', 'The isolated text worker could not finish within its resource limits. Use a smaller input.')));
    worker.on('exit', () => finish(new AdapterError('TEXT_PROCESSING_FAILED', 'The isolated text worker stopped before producing an output.')));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

async function processFile(args, options, kind) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args, kind);
  const output = await newOutput(args.output_path);
  if (kind === 'json' && path.extname(output).toLowerCase() !== '.json') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .json.');
  const input = await readInput(args.input_path, { allow_empty: true, max_bytes: MAX_TEXT_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const made = await runWorker(input.data, kind, settings, options);
  const data = Buffer.from(made.data);
  if (data.length > MAX_TEXT_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The local text output exceeds 32 MiB.');
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: kind === 'json' ? 'format-json' : 'base64-file', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, verified: true, ...settings, ...made.summary,
    ...(kind === 'json' ? { format: 'json', encoding: 'utf-8' }
      : { format: settings.mode === 'encode' ? 'base64' : 'binary',
        encoding: settings.mode === 'encode' ? 'ascii' : 'binary',
        profile: settings.url_safe ? 'base64url-unpadded' : 'base64-padded' }),
  };
}

export function formatJson(args, options = {}) { return processFile(args, options, 'json'); }
export function base64File(args, options = {}) { return processFile(args, options, 'base64'); }

if (!isMainThread && workerData?.kind === 'abox-local-text') {
  try {
    const result = workerData.job === 'json' ? formatJsonBytes(workerData.bytes, workerData.settings)
      : base64Bytes(workerData.bytes, workerData.settings);
    parentPort.postMessage({ type: 'result', result }, [result.data.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'error', error: publicFailure(error) }); }
  finally { parentPort.close(); }
}
