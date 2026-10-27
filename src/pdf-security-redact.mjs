import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { protect, standardSecurity, WrongPasswordError, UnsupportedEncryptionError } from '../vendor/abox/shared/js/pdf-crypt.js';
import { permissionsIn, refusedIn } from '../vendor/abox/shared/js/pdf-permissions.js';
import { Name, Ref, PdfStream, PdfString } from '../vendor/abox/shared/js/pdf-objects.js';
import { writeDocument, stripMetadata } from '../vendor/abox/shared/js/pdf-writer.js';
import { passwordIssue } from '../vendor/abox/tools/protect-pdf/src/password-validation.js';
import { documentForExport } from '../vendor/abox/tools/unlock-pdf/src/document-for-export.js';
import { createPdfFilterScanner } from './pdf-csv.mjs';
import { newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PDF_SECURITY_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_PDF_SECURITY_OUTPUT_BYTES = 64 * 2 ** 20;
export const MAX_PDF_SECURITY_PAGES = 500;
export const MAX_PDF_SECURITY_OBJECTS = 50_000;
export const MAX_PDF_SECURITY_NODES = 250_000;
export const MAX_PDF_SECURITY_DEPTH = 128;
export const MAX_PDF_SECURITY_STREAM_BYTES = 16 * 2 ** 20;
export const MAX_PDF_SECURITY_DECOMPRESSED_BYTES = 128 * 2 ** 20;
export const MAX_PDF_PASSWORD_FILE_BYTES = 1024;
const TIMEOUT_MS = 120_000;
const FILTER_MESSAGE = 'PDF security currently supports unfiltered and Flate structural streams without predictors. Legacy LZW, run-length, ASCII-armored streams and predictor names are refused by the bounded worker.';

function settingsFor(args, kind) {
  if (kind === 'unlock') {
    const settings = { remove_metadata: args.remove_metadata ?? true };
    if (typeof settings.remove_metadata !== 'boolean') throw new AdapterError('INVALID_ARGUMENTS', 'remove_metadata must be a boolean.');
    return settings;
  }
  const settings = { revision: args.revision ?? 6, restrict_print: args.restrict_print ?? false,
    restrict_copy: args.restrict_copy ?? false, restrict_change: args.restrict_change ?? false };
  if (![4, 6].includes(settings.revision) || ['restrict_print', 'restrict_copy', 'restrict_change'].some(key => typeof settings[key] !== 'boolean')) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Use revision 6 or 4 and boolean restrict_print, restrict_copy and restrict_change settings.');
  }
  return settings;
}

async function secretFile(value) {
  if (value === undefined) return new Uint8Array(0);
  let input;
  try {
    input = await readInput(value, { allow_empty: true, max_bytes: MAX_PDF_PASSWORD_FILE_BYTES });
    return Uint8Array.from(input.data);
  } catch { throw new AdapterError('PASSWORD_FILE', 'A password file must be a readable regular local file containing at most 1024 bytes.'); }
  finally { input?.data.fill(0); }
}

function password(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AdapterError('PASSWORD_ENCODING', 'Password files must contain valid UTF-8. Their exact text, including spaces, a BOM or a final newline, is used without trimming.'); }
}

function validatePassword(value, revision) {
  const issue = passwordIssue(value, revision);
  if (issue) throw new AdapterError('PASSWORD_LIMIT', revision === 4
    ? 'Revision 4 passwords must contain at most 32 Latin-1 characters. No truncation or replacement is performed.'
    : 'Revision 6 passwords must contain at most 127 UTF-8 bytes. No truncation is performed.');
}

function checkBudget(budget) {
  if (budget.exceeded) throw new AdapterError('PDF_SECURITY_LIMIT', 'PDF expansion exceeds the 16 MiB per-stream or 128 MiB total worker limit.');
  if (budget.unsupported) throw new AdapterError('PDF_SECURITY_FILTER', FILTER_MESSAGE);
}

function scanFilters(data, budget) {
  const scanner = createPdfFilterScanner(budget);
  try { scanner.write(data); scanner.finish(); }
  catch { checkBudget(budget); throw new AdapterError('PDF_SECURITY_FILTER', FILTER_MESSAGE); }
}

function boundDecompression(budget) {
  const Native = globalThis.DecompressionStream;
  globalThis.DecompressionStream = class {
    constructor(format) {
      checkBudget(budget); const native = new Native(format), scanner = createPdfFilterScanner(budget); let size = 0;
      this.writable = native.writable;
      this.readable = native.readable.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          if (size + chunk.byteLength > MAX_PDF_SECURITY_STREAM_BYTES
              || budget.bytes + chunk.byteLength > MAX_PDF_SECURITY_DECOMPRESSED_BYTES) budget.exceeded = true;
          checkBudget(budget); size += chunk.byteLength; budget.bytes += chunk.byteLength;
          scanner.write(chunk); controller.enqueue(chunk);
        },
        flush() { scanner.finish(); checkBudget(budget); },
      }));
    }
  };
}

function failLimit() { throw new AdapterError('PDF_SECURITY_LIMIT', 'The PDF exceeds the bounded object, graph, nesting or output expansion limit.'); }

function pageCount(doc) {
  const root = doc.get(doc.catalog, 'Pages'), stack = [{ node: root, depth: 0 }], seen = new Set(); let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!(node instanceof Map) || seen.has(node) || depth > 64) throw new AdapterError('INVALID_PDF', 'The PDF page tree is incomplete, cyclic or too deeply nested.');
    seen.add(node); if (seen.size > MAX_PDF_SECURITY_OBJECTS) failLimit();
    const kids = doc.get(node, 'Kids');
    if (Array.isArray(kids)) {
      for (const kid of kids) stack.push({ node: doc.resolve(kid), depth: depth + 1 });
    } else if (node.get('Type')?.value === 'Page' || node.has('Contents')) count++;
    else throw new AdapterError('INVALID_PDF', 'The PDF page tree has an unsupported leaf.');
    if (count > MAX_PDF_SECURITY_PAGES) throw new AdapterError('PDF_PAGE_LIMIT', 'PDF security supports 1 to 500 pages.');
  }
  if (!count || count !== doc.countPages()) throw new AdapterError('INVALID_PDF', 'The PDF must have 1 to 500 consistently counted pages.');
  return count;
}

function signed(doc) {
  if (doc.get(doc.get(doc.catalog, 'AcroForm'), 'SigFlags')) return true;
  for (const object of doc.objects.values()) if (object instanceof Map && object.get('FT')?.value === 'Sig') return true;
  return false;
}

function fingerprint(doc) {
  const digest = createHash('sha256'), ids = new Map(), queue = [];
  let nodes = 0, rawBytes = 0, streams = 0;
  const token = value => { digest.update(value); digest.update('\0'); };
  const bytes = data => { rawBytes += data.byteLength; if (rawBytes > MAX_PDF_SECURITY_OUTPUT_BYTES) failLimit(); digest.update(data); digest.update('\0'); };
  const walk = root => {
    const stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (++nodes > MAX_PDF_SECURITY_NODES || depth > MAX_PDF_SECURITY_DEPTH) failLimit();
      if (value instanceof Ref) {
        const target = doc.getObject(value.num);
        if (target === null || target === undefined) { token('null'); continue; }
        if (!ids.has(value.num)) { ids.set(value.num, ids.size + 1); queue.push(value.num); }
        if (ids.size > MAX_PDF_SECURITY_OBJECTS) failLimit(); token(`ref:${ids.get(value.num)}`);
      } else if (value instanceof PdfString) { token(`string:${value.bytes.length}`); bytes(value.bytes); }
      else if (value instanceof Name) { const data = Buffer.from(value.value, 'utf8'); token(`name:${data.length}`); bytes(data); }
      else if (Array.isArray(value)) {
        token(`array:${value.length}`); for (let at = value.length - 1; at >= 0; at--) stack.push({ value: value[at], depth: depth + 1 });
      } else if (value instanceof Map || value instanceof PdfStream) {
        const stream = value instanceof PdfStream, dict = stream ? value.dict : value;
        if (stream) { token(`stream:${value.raw.length}`); bytes(value.raw); streams++; }
        const keys = [...dict.keys()].filter(key => !stream || key !== 'Length').sort(); token(`map:${keys.length}`);
        for (let at = keys.length - 1; at >= 0; at--) {
          const key = keys[at]; stack.push({ value: dict.get(key), depth: depth + 1 });
          // Keys use the same unambiguous string representation as values, so
          // an object-number rewrite cannot make two different graphs agree.
          stack.push({ value: new PdfString(new TextEncoder().encode(key)), depth: depth + 1 });
        }
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new AdapterError('INVALID_PDF', 'The PDF contains a non-finite numeric value.'); token(`number:${value}`);
      } else if (typeof value === 'boolean') token(String(value));
      else if (value === null || value === undefined) token('null');
      else throw new AdapterError('INVALID_PDF', 'The PDF contains an unsupported object value.');
    }
  };
  walk(doc.trailer.get('Root'));
  if (doc.trailer.has('Info')) walk(doc.trailer.get('Info'));
  for (let at = 0; at < queue.length; at++) { token(`object:${at + 1}`); walk(doc.getObject(queue[at])); }
  // The source writer's hex strings, names, object headers and cipher padding
  // fit this conservative bound before it assembles a Blob or packed stream.
  const predicted = rawBytes * 3 + nodes * 128 + ids.size * 128 + 1024 * 1024;
  if (predicted > MAX_PDF_SECURITY_OUTPUT_BYTES) failLimit();
  return { hash: digest.digest('hex'), objects: ids.size, streams, nodes };
}

async function openPdf(bytes, value, budget) {
  const auth = standardSecurity(value), doc = await boundedOpen(bytes, { unlock: auth.unlock }, budget);
  if (doc.repaired) throw new AdapterError('PDF_REPAIR_REQUIRED', 'PDF security refuses repaired inputs. Save a complete, structurally consistent PDF and retry.');
  pageCount(doc); return { doc, report: auth.report };
}

async function boundedOpen(bytes, options, budget) {
  try { return await PdfDocument.open(bytes, options); }
  finally { checkBudget(budget); }
}

function permissionBits(settings) {
  let bits = -1;
  if (settings.restrict_print) bits &= ~((1 << 2) | (1 << 11));
  if (settings.restrict_copy) bits &= ~(1 << 4);
  if (settings.restrict_change) bits &= ~((1 << 3) | (1 << 5) | (1 << 8) | (1 << 10));
  return bits;
}

function verifyGraph(doc, expected, pages, budget) {
  checkBudget(budget);
  if (doc.repaired || pageCount(doc) !== pages || fingerprint(doc).hash !== expected.hash) {
    throw new AdapterError('VERIFICATION_FAILED', 'The rewritten PDF did not retain the expected pages, object values and stream bytes. No output was written.');
  }
}

async function processPdf(bytes, secrets, settings, kind) {
  const budget = { exceeded: false, unsupported: false, bytes: 0 }; boundDecompression(budget); scanFilters(bytes, budget);
  if (kind === 'protect') {
    const user = password(secrets[0]), owner = password(secrets[1]); validatePassword(user, settings.revision); validatePassword(owner, settings.revision);
    const bits = permissionBits(settings);
    if (!user && bits === -1) throw new AdapterError('INVALID_ARGUMENTS', 'Provide a nonempty open password file or request at least one permission restriction.');
    if (!user && !owner) throw new AdapterError('OWNER_PASSWORD_REQUIRED', 'Restrictions-only protection requires a nonempty owner_password_file. No random owner password is discarded.');
    let input;
    try { input = await openPdf(bytes, '', budget); }
    catch (error) {
      if (error instanceof WrongPasswordError) throw new AdapterError('PDF_PASSWORD_REQUIRED', 'Unlock an input that requires an open password before protecting it.');
      throw error;
    }
    const pages = pageCount(input.doc), hasSignature = signed(input.doc), expected = fingerprint(input.doc);
    const security = await protect({ userPassword: user, ownerPassword: owner, revision: settings.revision,
      permissions: bits, id: crypto.getRandomValues(new Uint8Array(16)) });
    const blob = await writeDocument(input.doc, { recompress: false, security });
    if (blob.size > MAX_PDF_SECURITY_OUTPUT_BYTES) failLimit(); const data = new Uint8Array(await blob.arrayBuffer());
    let encrypted = false;
    try { await boundedOpen(data, {}, budget); } catch (error) { if (error instanceof EncryptedPdfError) encrypted = true; else throw error; }
    if (!encrypted) throw new AdapterError('VERIFICATION_FAILED', 'The protected output did not require the standard security handler. No output was written.');
    const checked = await openPdf(data, user, budget); verifyGraph(checked.doc, expected, pages, budget);
    const asked = refusedIn(permissionsIn(bits, settings.revision)).map(entry => entry.bit).join(',');
    if (checked.report.revision !== settings.revision || refusedIn(checked.report.restrictions).map(entry => entry.bit).join(',') !== asked
        || settings.revision === 6 && !checked.report.keyConfirmed) {
      throw new AdapterError('VERIFICATION_FAILED', 'The protected output did not retain the requested security revision and permission bits. No output was written.');
    }
    if (user) {
      let refused = false;
      try { await openPdf(data, '', budget); } catch (error) { if (error instanceof WrongPasswordError) refused = true; else throw error; }
      if (!refused) throw new AdapterError('VERIFICATION_FAILED', 'The open-password output unexpectedly opened with a blank password. No output was written.');
    }
    if (owner) {
      const checkedOwner = await openPdf(data, owner, budget); verifyGraph(checkedOwner.doc, expected, pages, budget);
      if (user && owner !== user && checkedOwner.report.opened !== 'owner') {
        throw new AdapterError('VERIFICATION_FAILED', 'The explicit owner password did not authenticate as the owner. No output was written.');
      }
    }
    return { data, summary: { pages, input_encrypted: input.report.encrypted, revision: settings.revision,
      bits: settings.revision === 6 ? 256 : 128, open_password: Boolean(user), owner_password_source: owner ? 'provided-file' : 'same-as-open',
      ...settings, input_signed: hasSignature, verified: true,
      verification: { pages: true, reachable_graph: true, stream_bytes: true, permission_bits: true,
        standard_security_required: true, blank_password_refused: Boolean(user), owner_password_checked: Boolean(owner && user && owner !== user) } } };
  }
  const value = password(secrets[0]), input = await openPdf(bytes, value, budget);
  if (!input.report.encrypted) throw new AdapterError('PDF_NOT_ENCRYPTED', 'The input PDF is already unencrypted. No output was written.');
  if (input.report.opened !== 'blank') validatePassword(value, input.report.revision <= 4 ? 4 : 6);
  const pages = pageCount(input.doc), hasSignature = signed(input.doc);
  let exported;
  try { exported = await documentForExport({ bytes, doc: input.doc }); }
  finally { checkBudget(budget); }
  const infoRemoved = settings.remove_metadata && exported.trailer.has('Info');
  const removed = settings.remove_metadata ? stripMetadata(exported) + Number(infoRemoved) : 0, expected = fingerprint(exported);
  const blob = await writeDocument(exported, { recompress: false });
  if (blob.size > MAX_PDF_SECURITY_OUTPUT_BYTES) failLimit(); const data = new Uint8Array(await blob.arrayBuffer());
  const checked = await boundedOpen(data, {}, budget); verifyGraph(checked, expected, pages, budget);
  if (checked.trailer.has('Encrypt')) throw new AdapterError('VERIFICATION_FAILED', 'The rewritten PDF remained encrypted. No output was written.');
  return { data, summary: { pages, input_encrypted: true, input_revision: input.report.revision,
    input_bits: input.report.bits, remove_metadata: settings.remove_metadata, metadata_entries_removed: removed,
    input_signed: hasSignature, verified: true,
    verification: { pages: true, reachable_graph: true, stream_bytes: true, opens_without_password: true, encryption_removed: true } } };
}

function publicFailure(error) {
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  if (error instanceof WrongPasswordError) return { code: 'PDF_PASSWORD_INVALID', message: 'The provided password did not open this PDF. No password guessing is performed.' };
  if (error instanceof UnsupportedEncryptionError) return { code: 'PDF_ENCRYPTION_UNSUPPORTED', message: 'This PDF does not use a supported standard password security handler. Certificate encryption and unpublished variants are unsupported.' };
  if (error?.code === 'PDF_CSV_FILTER') return { code: 'PDF_SECURITY_FILTER', message: FILTER_MESSAGE };
  return { code: 'PDF_SECURITY_FAILED', message: 'The existing PDF engine could not safely rewrite and verify this document. No output was written.' };
}

async function runWorker(input, secrets, kind, settings, options) {
  const bytes = Uint8Array.from(input), worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'abox-pdf-security', job: kind, bytes, secrets, settings }, transferList: [bytes.buffer, ...secrets.map(value => value.buffer)],
    execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'PDF security exceeded the two-minute worker limit.')), TIMEOUT_MS);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('PDF_SECURITY_LIMIT', 'The isolated PDF worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('PDF_SECURITY_LIMIT', 'The isolated PDF worker stopped before producing an output.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

async function operation(args, options, kind) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args, kind), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.pdf') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .pdf.');
  const input = await readInput(args.input_path, { max_bytes: MAX_PDF_SECURITY_INPUT_BYTES });
  const secrets = [];
  try {
    secrets.push(await secretFile(kind === 'protect' ? args.open_password_file : args.password_file));
    if (kind === 'protect') secrets.push(await secretFile(args.owner_password_file));
    options.signal?.throwIfAborted(); const made = await runWorker(input.data, secrets, kind, settings, options), data = Buffer.from(made.data);
    if (!data.length || data.length > MAX_PDF_SECURITY_OUTPUT_BYTES) failLimit();
    options.signal?.throwIfAborted(); await writeNew(output, data);
    return { ok: true, operation: kind === 'protect' ? 'protect-pdf' : 'unlock-pdf', input_path: input.path,
      output_path: output, input_bytes: input.data.length, output_bytes: data.length, format: 'pdf', ...made.summary,
      warnings: ['Rewriting a PDF invalidates digital signatures and removes prior incremental revisions and unreachable objects. Keep the unchanged original.',
        ...(kind === 'protect' ? ['Permission restrictions are advisory. An open password encrypts content; readers may ignore printing, copying and editing restrictions.',
          'Password files use exact UTF-8 text without normalization or trimming. Keep the password files separately from the document.']
          : ['Removing encryption does not verify document authenticity or safety. Metadata removal follows the existing writer’s supported fields.'])] };
  } finally { for (const value of secrets) if (value.byteLength) value.fill(0); }
}

export function protectPdf(args, options = {}) { return operation(args, options, 'protect'); }
export function unlockPdf(args, options = {}) { return operation(args, options, 'unlock'); }

if (!isMainThread && workerData?.kind === 'abox-pdf-security') {
  try {
    const result = await processPdf(workerData.bytes, workerData.secrets, workerData.settings, workerData.job);
    parentPort.postMessage({ result }, [result.data.buffer]);
  } catch (error) { parentPort.postMessage({ error: publicFailure(error) }); }
  finally { for (const value of workerData.secrets) value.fill(0); parentPort.close(); }
}
