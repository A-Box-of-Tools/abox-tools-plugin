import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compareText, formatUnified, splitLines } from '../vendor/abox/tools/text-diff/src/diff.js';
import { localPath, newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_DIFF_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_DIFF_LINES = 20000;
export const MAX_DIFF_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120000;
// The pinned source uses this search ceiling; detecting a large full rewrite does not prove its edit script is minimal.
const SOURCE_MAX_STEPS = 2000;

function settingsFor(args) {
  const settings = { ignore_whitespace: args.ignore_whitespace ?? false, ignore_case: args.ignore_case ?? false,
    ignore_blank_lines: args.ignore_blank_lines ?? false, context_lines: args.context_lines ?? 3 };
  if (['ignore_whitespace', 'ignore_case', 'ignore_blank_lines'].some(key => typeof settings[key] !== 'boolean')
      || !Number.isInteger(settings.context_lines) || settings.context_lines < 0 || settings.context_lines > 100) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Ignore options must be booleans and context_lines an integer from 0 to 100.');
  }
  return settings;
}

async function inputPaths(values, signal) {
  const paths = [];
  let total = 0;
  for (const value of values) {
    signal?.throwIfAborted();
    const filename = localPath(await realpath(localPath(value)));
    const info = await stat(filename);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'Both comparison inputs must be regular local files.');
    total += info.size;
    if (total > MAX_DIFF_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The two comparison inputs must total at most 4 MiB.');
    paths.push(filename);
  }
  return paths;
}

function decodeText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AdapterError('INVALID_UTF8', 'Text comparison requires valid UTF-8 input. No output was written.'); }
  if (text.includes('\0')) throw new AdapterError('BINARY_TEXT_INPUT', 'Text comparison does not accept NUL-containing binary data. Use Base64 or checksums for binary files.');
  return text;
}

function verificationFailure() {
  throw new AdapterError('VERIFICATION_FAILED', 'The generated diff did not reconstruct both original texts. No output was written.');
}

function verifyOperations(ops, left, right) {
  const a = [], b = [];
  for (const op of ops) {
    if (op.type === 'equal') {
      a.push(op.text + op.aEnding);
      b.push(op.bText + op.bEnding);
    } else if (op.type === 'delete') a.push(op.text + op.ending);
    else if (op.type === 'insert') b.push(op.text + op.ending);
    else verificationFailure();
  }
  if (a.join('') !== left || b.join('') !== right) verificationFailure();
}

const patchLines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function verifyPatch(patch, left, right) {
  if (!patch) {
    if (left !== right) verificationFailure();
    return { hunk_count: 0, coarse_rewrite_detected: false };
  }
  if (!patch.endsWith('\n')) verificationFailure();
  const lines = patch.split('\n');
  lines.pop();
  if (lines[0] !== '--- a' || lines[1] !== '+++ b') verificationFailure();
  const a = patchLines(left);
  const b = patchLines(right);
  const output = [];
  let cursor = 0, at = 2, hunks = 0, deleted = 0, inserted = 0;
  while (at < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[at++]);
    if (!header) verificationFailure();
    const [aStart, aCount, bStart, bCount] = header.slice(1).map(Number);
    const aIndex = aCount ? aStart - 1 : aStart;
    const bIndex = bCount ? bStart - 1 : bStart;
    if (!Number.isSafeInteger(aIndex) || !Number.isSafeInteger(bIndex) || aIndex < cursor || aIndex > a.length) verificationFailure();
    for (; cursor < aIndex; cursor++) output.push(a[cursor]);
    if (output.length !== bIndex) verificationFailure();
    let consumed = 0, produced = 0;
    while (at < lines.length && !lines[at].startsWith('@@ ')) {
      const line = lines[at++];
      const sign = line[0];
      if (![' ', '-', '+'].includes(sign)) verificationFailure();
      let text = line.slice(1) + '\n';
      if (lines[at] === '\\ No newline at end of file') { text = line.slice(1); at++; }
      if (sign !== '+') {
        if (a[cursor] !== text) verificationFailure();
        cursor++; consumed++;
      }
      if (sign !== '-') { output.push(text); produced++; }
      if (sign === '-') deleted++;
      if (sign === '+') inserted++;
    }
    if (consumed !== aCount || produced !== bCount) verificationFailure();
    hunks++;
  }
  for (; cursor < a.length; cursor++) output.push(a[cursor]);
  if (output.join('') !== right) verificationFailure();
  let prefix = 0, endA = a.length, endB = b.length;
  while (prefix < endA && prefix < endB && a[prefix] === b[prefix]) prefix++;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middleA = endA - prefix, middleB = endB - prefix;
  return { hunk_count: hunks, coarse_rewrite_detected: middleA > 0 && middleB > 0
    && middleA + middleB > SOURCE_MAX_STEPS && deleted === middleA && inserted === middleB };
}

function statistics(stats) {
  return { added_lines: stats.added, removed_lines: stats.removed, unchanged_lines: stats.same,
    left_lines: stats.aLines, right_lines: stats.bLines, identical: stats.identical,
    similarity: stats.similarity, ending_changes: stats.endingChanges,
    trailing_terminator_differs: stats.trailingDiffers };
}

function compare(leftBytes, rightBytes, settings) {
  const left = decodeText(leftBytes);
  const right = decodeText(rightBytes);
  const leftLines = splitLines(left).lines.length;
  const rightLines = splitLines(right).lines.length;
  if (leftLines + rightLines > MAX_DIFF_LINES) {
    throw new AdapterError('TEXT_DIFF_LIMIT', 'The comparison inputs must total at most 20000 logical lines. Select smaller files.');
  }
  // Source tokens appear at most once. Eighty bytes per logical line covers its prefix, hunk header and possible missing-newline marker.
  if (leftBytes.length + rightBytes.length + (leftLines + rightLines) * 80 + 128 > MAX_DIFF_OUTPUT_BYTES) {
    throw new AdapterError('OUTPUT_SIZE', 'The comparison cannot fit within the bounded unified output.');
  }
  const raw = compareText(left, right);
  verifyOperations(raw.ops, left, right);
  const filtered = settings.ignore_whitespace || settings.ignore_case || settings.ignore_blank_lines;
  const view = filtered ? compareText(left, right, { ignoreWhitespace: settings.ignore_whitespace,
    ignoreCase: settings.ignore_case, ignoreBlankLines: settings.ignore_blank_lines }) : null;
  const patch = formatUnified(left, right, { context: settings.context_lines });
  const outputBytes = Buffer.byteLength(patch, 'utf8');
  if (outputBytes > MAX_DIFF_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The unified diff exceeds the 8 MiB output limit.');
  const checked = verifyPatch(patch, left, right);
  return { data: new TextEncoder().encode(patch), summary: {
    ...statistics(raw.stats), ...checked, ...settings,
    ...(view ? { comparison_stats: statistics(view.stats) } : {}),
    source_reconstruction_verified: true, patch_application_verified: true, verified: true,
    minimality_guaranteed: false,
    warnings: [
      'The bounded Myers engine may emit a coarser rewrite when differences are distant. A minimal edit script is not guaranteed.',
      ...(checked.coarse_rewrite_detected ? ['A large full-middle rewrite was detected in the generated patch.'] : []),
      ...(filtered ? ['Ignore settings affect comparison_stats only. The exported patch and primary counts always compare the original unfiltered texts.'] : []),
      'The unified patch uses fixed a and b header labels. It is saved locally and is not applied to either input.',
    ],
  } };
}

function publicFailure(error) {
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  return { code: 'TEXT_DIFF_FAILED', message: 'The existing comparison engine could not compare these inputs. No output was written.' };
}

async function runWorker(left, right, settings, options) {
  const a = Uint8Array.from(left), b = Uint8Array.from(right);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-text-diff', left: a, right: b, settings },
    transferList: [a.buffer, b.buffer], execArgv: [], stdout: true, stderr: true,
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
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Local text comparison exceeded the two-minute limit. Use smaller inputs.')), TIMEOUT_MS);
    worker.on('message', message => {
      if (settled) return;
      if (message.type === 'result') finish(null, message.result);
      else if (message.type === 'error') finish(new AdapterError(message.error.code, message.error.message));
    });
    worker.on('error', () => finish(new AdapterError('TEXT_DIFF_LIMIT', 'The isolated comparison worker could not finish within its resource limits. Use smaller inputs.')));
    worker.on('exit', () => finish(new AdapterError('TEXT_DIFF_FAILED', 'The isolated comparison worker stopped before producing a diff.')));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function diffText(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args);
  const output = await newOutput(args.output_path);
  if (!['.diff', '.patch'].includes(path.extname(output).toLowerCase())) {
    throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .diff or .patch.');
  }
  const paths = await inputPaths([args.left_path, args.right_path], options.signal);
  const left = await readInput(paths[0], { allow_empty: true, max_bytes: MAX_DIFF_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const right = await readInput(paths[1], { allow_empty: true, max_bytes: MAX_DIFF_INPUT_BYTES });
  if (left.data.length + right.data.length > MAX_DIFF_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The two comparison inputs grew beyond the 4 MiB combined limit.');
  options.signal?.throwIfAborted();
  const made = await runWorker(left.data, right.data, settings, options);
  const data = Buffer.from(made.data);
  if (data.length > MAX_DIFF_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The unified diff exceeds the 8 MiB output limit.');
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'text-diff', left_path: left.path, right_path: right.path,
    left_bytes: left.data.length, right_bytes: right.data.length, input_bytes: left.data.length + right.data.length,
    output_path: output, output_bytes: data.length, format: 'unified-diff', encoding: 'utf-8', ...made.summary };
}

if (!isMainThread && workerData?.kind === 'abox-text-diff') {
  try {
    const result = compare(workerData.left, workerData.right, workerData.settings);
    parentPort.postMessage({ type: 'result', result }, [result.data.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'error', error: publicFailure(error) }); }
  finally { parentPort.close(); }
}
