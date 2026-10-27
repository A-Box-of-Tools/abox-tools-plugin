import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PdfDocument, EncryptedPdfError, NotAPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { pagesOf, readPage } from '../vendor/abox/shared/js/pdf-text.js';
import { parseRanges } from '../vendor/abox/tools/merge-pdf/src/plan.js';
import { readTables, TableReadError } from '../vendor/abox/tools/pdf-to-csv/src/read.js';
import { pageRuns } from '../vendor/abox/tools/pdf-to-csv/src/layout.js';
import { findTables } from '../vendor/abox/tools/pdf-to-csv/src/tables.js';
import { buildTable } from '../vendor/abox/tools/pdf-to-csv/src/rows.js';
import { checkBalance } from '../vendor/abox/tools/pdf-to-csv/src/check.js';
import { columnLetter, csvValue, formulaCells, toCsv } from '../vendor/abox/tools/pdf-to-csv/src/csv.js';
import { formatAmount, hasAmbiguousDates, parseAmount, parseDate } from '../vendor/abox/tools/pdf-to-csv/src/values.js';
import { newOutput, readInput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_CSV_PDF_PAGES = 5000;
export const MAX_CSV_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_CSV_TABLES = 1000;
export const MAX_CSV_COLUMNS = 64;
export const MAX_CSV_ROWS = 100000;
export const MAX_CSV_CELLS = 1000000;
export const MAX_CSV_GLYPHS = 1000000;
export const MAX_CSV_PAGE_GLYPHS = 100000;
export const MAX_CSV_DECOMPRESSED_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_CSV_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_SELECTION_LENGTH = 10000;
const TIMEOUT_MS = 120000;
const DECOMPRESSION_LIMIT_MESSAGE = 'PDF stream expansion exceeds the 16 MiB per-stream or 64 MiB total extraction limit. Select a smaller document.';
const UNSUPPORTED_FILTER_MESSAGE = 'PDF table extraction currently supports unfiltered and Flate streams without predictors. Legacy filters, ASCII armours and predictors are unsupported, including in images or cross-reference streams. Save a PDF using the supported compression and retry.';
export const UNSUPPORTED_CSV_PDF_NAMES = Object.freeze([
  'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
  'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'Predictor',
]);
const unsupportedNames = new Set(UNSUPPORTED_CSV_PDF_NAMES);
const nameBoundary = new Uint8Array(256);
for (const byte of [0, 9, 10, 12, 13, 32]) nameBoundary[byte] = 1;
for (const char of '()<>[]{}/%') nameBoundary[char.charCodeAt(0)] = 1;

function checkDecompressionBudget(budget) {
  if (budget.exceeded) failLimit(DECOMPRESSION_LIMIT_MESSAGE);
  if (budget.unsupported) throw new AdapterError('PDF_CSV_FILTER', UNSUPPORTED_FILTER_MESSAGE);
}

export function createPdfFilterScanner(budget) {
  let inName = false;
  let name = '';
  let longName = false;
  const finishName = () => {
    // The longest refused name occupies 45 bytes even when every character is
    // escaped. Longer names cannot become one of them after PDF #xx decoding.
    if (inName && !longName && unsupportedNames.has(name.replace(/#([0-9a-f]{2})/gi,
      (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))))) {
      budget.unsupported = true;
      checkDecompressionBudget(budget);
    }
    inName = false;
    name = '';
    longName = false;
  };
  return {
    write(bytes) {
      checkDecompressionBudget(budget);
      for (const byte of bytes) {
        if (inName && nameBoundary[byte]) finishName();
        if (byte === 47) inName = true;
        else if (inName && !longName) {
          if (name.length < 64) name += String.fromCharCode(byte);
          else { name = ''; longName = true; }
        }
      }
    },
    finish() { finishName(); checkDecompressionBudget(budget); },
  };
}

function limitWorkerDecompression(budget) {
  const NativeDecompressionStream = globalThis.DecompressionStream;
  // This runs only inside the disposable extraction worker. Bounding chunks
  // before Response buffers them also covers xref and object streams opened
  // before any page can reach the later glyph and table checks.
  globalThis.DecompressionStream = class {
    constructor(format) {
      checkDecompressionBudget(budget);
      const native = new NativeDecompressionStream(format);
      const scanner = createPdfFilterScanner(budget);
      let bytes = 0;
      this.readable = native.readable.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          if (budget.exceeded || bytes + chunk.byteLength > MAX_CSV_DECOMPRESSED_STREAM_BYTES
              || budget.bytes + chunk.byteLength > MAX_CSV_DECOMPRESSED_BYTES) {
            budget.exceeded = true;
            failLimit(DECOMPRESSION_LIMIT_MESSAGE);
          }
          bytes += chunk.byteLength;
          budget.bytes += chunk.byteLength;
          scanner.write(chunk);
          controller.enqueue(chunk);
        },
        flush() { scanner.finish(); },
      }));
      this.writable = native.writable;
    }
  };
}

function settingsFor(args) {
  const settings = { pages: args.pages ?? 'all', tableIndex: args.table_index ?? null,
    dateOrder: args.date_order ?? 'auto', includeHeaders: args.include_headers ?? true,
    spreadsheetSafe: args.spreadsheet_safe ?? true };
  if (typeof settings.pages !== 'string' || !settings.pages.trim() || settings.pages.length > MAX_PAGE_SELECTION_LENGTH
      || settings.tableIndex !== null && (!Number.isInteger(settings.tableIndex) || settings.tableIndex < 1 || settings.tableIndex > MAX_CSV_TABLES)
      || !['auto', 'dmy', 'mdy'].includes(settings.dateOrder)
      || typeof settings.includeHeaders !== 'boolean' || typeof settings.spreadsheetSafe !== 'boolean') {
    throw new AdapterError('INVALID_ARGUMENTS', 'Provide a supported page selection, optional table_index from 1 to 1000, date_order auto/dmy/mdy, and boolean include_headers/spreadsheet_safe settings.');
  }
  return settings;
}

function failLimit(message) { throw new AdapterError('PDF_CSV_LIMIT', message); }

function normalise(table, proof, order, mark, includeHeaders) {
  const money = new Set(proof ? [proof.balance, ...proof.amounts] : table.moneyColumns);
  const rows = table.rows.map(row => row.cells.map((cell, at) => {
    if (at === table.dateColumn) return parseDate(cell, order) ?? cell;
    if (!money.has(at) || !cell) return cell;
    const value = parseAmount(cell, mark);
    return value === null ? cell : { value: formatAmount(value), numeric: true };
  }));
  return includeHeaders ? [table.headers.map((given, at) => given || columnLetter(at)), ...rows] : rows;
}

function csvByteCount(rows, spreadsheetSafe) {
  let bytes = 3;
  for (const row of rows) {
    bytes += Math.max(0, row.length - 1) + 2;
    for (const cell of row) {
      const text = csvValue(cell, { spreadsheetSafe });
      const quotes = text.split('"').length - 1;
      bytes += Buffer.byteLength(text, 'utf8') + quotes + Number(/[",\r\n]/.test(text) || text !== csvValue(cell)) * 2;
      if (bytes > MAX_CSV_OUTPUT_BYTES) failLimit('The extracted CSV exceeds the 16 MiB output limit. Select fewer pages or one table.');
    }
  }
  return bytes;
}

function verifyCsvStructure(csv, rows) {
  if (!csv.startsWith('\ufeff')) return false;
  let record = 0;
  let columns = 1;
  let quoted = false;
  let closed = false;
  let fieldStart = true;
  for (let at = 1; at < csv.length; at++) {
    const char = csv[at];
    if (quoted) {
      if (char === '"' && csv[at + 1] === '"') at++;
      else if (char === '"') { quoted = false; closed = true; }
      continue;
    }
    if (char === '"') {
      if (!fieldStart || closed) return false;
      quoted = true;
      fieldStart = false;
    } else if (char === ',') {
      columns++;
      fieldStart = true;
      closed = false;
    } else if (char === '\r' && csv[at + 1] === '\n') {
      if (record >= rows.length || columns !== Math.max(1, rows[record].length)) return false;
      record++;
      columns = 1;
      fieldStart = true;
      closed = false;
      at++;
    } else {
      if (char === '\r' || char === '\n' || closed) return false;
      fieldStart = false;
    }
  }
  return !quoted && fieldStart && columns === 1 && record === rows.length;
}

function balanceSummary(proof) {
  if (!proof) return null;
  return { comparisons: proof.links, agreeing: proof.held, mismatches: proof.broken.length,
    checked_row_count: proof.checked.length, unchecked_row_count: proof.unchecked.length,
    mismatched_rows: proof.broken.slice(0, 20), unchecked_rows: proof.unchecked.slice(0, 20),
    row_lists_truncated: proof.broken.length > 20 || proof.unchecked.length > 20 };
}

async function extract(bytes, settings, budget) {
  let totalPages = 0;
  let selected = [];
  let repaired = false;
  let glyphs = 0;
  let textCharacters = 0;
  let lines = 0;
  let unreadableGlyphs = 0;
  let unbalancedPages = 0;
  const textless = [];
  const data = await readTables({ arrayBuffer: async () => bytes.buffer }, {
    onProgress(done, total) { parentPort?.postMessage({ type: 'progress', done, total }); },
  }, {
    async open(value) {
      const doc = await PdfDocument.open(value);
      checkDecompressionBudget(budget);
      repaired = Boolean(doc.repaired);
      return doc;
    },
    pageList(doc) {
      const pages = pagesOf(doc);
      totalPages = pages.length;
      if (!totalPages || totalPages > MAX_CSV_PDF_PAGES || doc.countPages() !== totalPages) {
        throw new AdapterError('PDF_PAGE_LIMIT', 'PDFs must have 1 to 5000 readable pages.');
      }
      const parsed = parseRanges(settings.pages, totalPages, key => key);
      if (parsed.error || !parsed.pages.length) throw new AdapterError('INVALID_PAGE_RANGE', 'The page selection does not match the source PDF.');
      selected = parsed.pages;
      return selected.map(page => pages[page - 1]);
    },
    async read(doc, page, number) {
      const value = await readPage(doc, page, selected[number - 1]);
      checkDecompressionBudget(budget);
      glyphs += value.glyphs.length;
      textCharacters += value.text.length;
      if (value.glyphs.length > MAX_CSV_PAGE_GLYPHS || glyphs > MAX_CSV_GLYPHS || textCharacters > MAX_CSV_GLYPHS * 2) {
        failLimit('The selected PDF text exceeds the extraction limit. Select fewer pages.');
      }
      unreadableGlyphs += value.unreadable;
      if (value.unbalanced) unbalancedPages++;
      if (!value.text.trim()) textless.push(selected[number - 1]);
      return value;
    },
    lines(page) {
      const found = pageRuns(page);
      lines += found.length;
      if (lines > MAX_CSV_ROWS) failLimit('The selected PDF contains more than 100000 text lines. Select fewer pages.');
      return found;
    },
    tablesIn(pages) {
      const tables = findTables(pages);
      if (tables.length > MAX_CSV_TABLES || tables.some(table => table.columns.length > MAX_CSV_COLUMNS)) {
        failLimit('The detected tables exceed 1000 tables or 64 columns per table. Select fewer pages.');
      }
      for (const table of tables) {
        table.page = selected[table.page - 1];
        for (const block of table.blocks) block.page = selected[block.page - 1];
      }
      return tables;
    },
  });
  const order = settings.dateOrder === 'auto' ? data.found ?? 'dmy' : settings.dateOrder;
  const ambiguous = hasAmbiguousDates(data.cells) && data.found === null;
  const tables = data.tables.map(table => buildTable(table, { order, mark: data.mark }))
    .filter(table => table.rows.length).map((table, index) => ({ ...table, index: index + 1 }));
  if (!tables.length) throw new AdapterError('PDF_NO_TABLES', 'No text-based tables were detected in the selected pages.');
  if (settings.tableIndex !== null && settings.tableIndex > tables.length) {
    throw new AdapterError('INVALID_TABLE_INDEX', `The selected pages contain ${tables.length} detected tables. Choose a valid table_index.`);
  }
  let totalRows = 0;
  let totalCells = 0;
  for (const table of tables) {
    totalRows += table.rows.length;
    totalCells += (table.rows.length + 1) * table.headers.length;
  }
  if (totalRows > MAX_CSV_ROWS || totalCells > MAX_CSV_CELLS) failLimit('The detected tables exceed 100000 rows or 1000000 cells. Select fewer pages.');
  const chosen = settings.tableIndex === null ? tables : [tables[settings.tableIndex - 1]];
  const grid = [];
  const summaries = [];
  let skippedBalanceChecks = 0;
  for (const table of chosen) {
    // The source balance search tries column triples; a wide numeric report should still export without that cubic search.
    const skipped = table.moneyColumns.length > 8;
    if (skipped) skippedBalanceChecks++;
    const proof = skipped ? null : checkBalance(table.rows, table.moneyColumns, data.mark);
    if (grid.length) grid.push([]);
    for (const row of normalise(table, proof, order, data.mark, settings.includeHeaders)) grid.push(row);
    const tablePages = [...new Set(table.rows.map(row => row.page))];
    summaries.push({ table_index: table.index, row_count: table.rows.length, column_count: table.headers.length,
      start_page: table.page, pages: tablePages.slice(0, 100), pages_truncated: tablePages.length > 100,
      date_column: table.dateColumn < 0 ? null : table.dateColumn + 1,
      money_columns: table.moneyColumns.map(column => column + 1),
      balance_check: balanceSummary(proof), balance_check_skipped: skipped });
  }
  const affected = formulaCells(grid);
  const expectedBytes = csvByteCount(grid, settings.spreadsheetSafe);
  const csv = toCsv(grid, { spreadsheetSafe: settings.spreadsheetSafe });
  const output = Buffer.from(csv, 'utf8');
  if (output.length !== expectedBytes || !verifyCsvStructure(csv, grid)) {
    throw new AdapterError('VERIFICATION_FAILED', 'The extracted CSV did not retain its expected records, columns, or UTF-8 encoding. No output was written.');
  }
  return { csv: Uint8Array.from(output), summary: {
    input_pages: totalPages, selected_page_count: selected.length, selected_pages: selected.slice(0, 100), selected_pages_truncated: selected.length > 100,
    tables_detected: tables.length, table_count: chosen.length, row_count: chosen.reduce((sum, table) => sum + table.rows.length, 0),
    csv_record_count: grid.length, tables: summaries.slice(0, 20), tables_truncated: summaries.length > 20,
    table_index: settings.tableIndex, include_headers: settings.includeHeaders,
    date_order: order, date_order_detected: data.found, ambiguous_dates: ambiguous,
    decimal_mark: data.mark, spreadsheet_safe: settings.spreadsheetSafe,
    formula_like_text_cells: affected, protected_text_cells: settings.spreadsheetSafe ? affected : 0,
    textless_page_count: textless.length, textless_pages: textless.slice(0, 100), textless_pages_truncated: textless.length > 100,
    unreadable_glyphs: unreadableGlyphs, repaired_input: repaired, unbalanced_text_pages: unbalancedPages,
    csv_structure_verified: true, verified: true,
    warnings: [
      'Tables, headings, dates and amounts are inferred from text positions. Review the CSV against the PDF before relying on it.',
      'No OCR is performed. Scanned pages, undecodable text and unusual layouts may be missing from the output.',
      'Dates with recognised years and inferred amounts are normalised; dates without years remain as printed.',
      ...(ambiguous && settings.dateOrder === 'auto' ? ['Numeric date order is ambiguous. Day-first was used; set date_order explicitly if needed.'] : []),
      ...(textless.length ? ['Some selected pages contained no recoverable text and contributed no table rows.'] : []),
      ...(unreadableGlyphs || unbalancedPages ? ['The source reader reported unreadable glyphs or unbalanced text instructions. Some extracted content may be incomplete.'] : []),
      ...(skippedBalanceChecks ? ['Running-balance checks were skipped for tables with more than eight inferred money columns.'] : []),
      ...(summaries.some(table => table.balance_check) ? ['Balance arithmetic compares net changes between readable balances. Agreement does not verify every value, date or description; unchecked rows remain reported.'] : []),
      ...(affected ? [settings.spreadsheetSafe
        ? 'Formula-like text cells were prefixed with an apostrophe. Spreadsheet import settings can still affect how that text is interpreted.'
        : 'Raw export retains formula-like text. A spreadsheet may interpret those cells as formulas.'] : []),
    ],
  } };
}

function publicFailure(error, budget) {
  // The source reader deliberately recovers from some broken streams. A size
  // refusal must survive those catches instead of becoming a partial export.
  if (budget.exceeded) return { code: 'PDF_CSV_LIMIT', message: DECOMPRESSION_LIMIT_MESSAGE };
  if (budget.unsupported) return { code: 'PDF_CSV_FILTER', message: UNSUPPORTED_FILTER_MESSAGE };
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  if (error instanceof EncryptedPdfError) return { code: 'ENCRYPTED_PDF', message: 'Encrypted PDFs are unsupported, including those with an empty password.' };
  if (error instanceof NotAPdfError) return { code: 'INVALID_PDF', message: 'The input could not be opened as a PDF. No output was written.' };
  if (error instanceof TableReadError && error.reason === 'scan.notext') return { code: 'PDF_NO_TEXT', message: 'The selected pages contain no recoverable text. This tool does not perform OCR.' };
  if (error instanceof TableReadError && error.reason === 'scan.notables') return { code: 'PDF_NO_TABLES', message: 'No text-based tables were detected in the selected pages.' };
  return { code: 'PDF_EXTRACTION_FAILED', message: 'The PDF text could not be extracted by the current source engine. No output was written.' };
}

async function runExtraction(bytes, settings, options) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-pdf-csv', bytes, settings },
    transferList: [bytes.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume();
  worker.stderr.resume();
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
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'PDF table extraction exceeded the two-minute limit. Select fewer pages.')), TIMEOUT_MS);
    worker.on('message', message => {
      if (settled) return;
      if (message.type === 'progress') {
        try { options.onProgress?.(message.done, message.total); } catch (error) { finish(error); }
      } else if (message.type === 'result') finish(null, message.result);
      else if (message.type === 'error') finish(new AdapterError(message.error.code, message.error.message));
    });
    worker.on('error', error => finish(new AdapterError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'PDF_CSV_LIMIT' : 'PDF_EXTRACTION_FAILED',
      'The isolated PDF extraction worker could not finish within its resource limits. Select fewer pages or a smaller document.')));
    worker.on('exit', () => finish(new AdapterError('PDF_EXTRACTION_FAILED', 'The isolated PDF extraction worker stopped before producing a CSV.')));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function pdfToCsv(args, options = {}) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args);
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.csv') throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .csv.');
  const input = await readInput(args.input_path);
  options.signal?.throwIfAborted();
  const made = await runExtraction(Uint8Array.from(input.data), settings, options);
  const data = Buffer.from(made.csv);
  if (!data.length || data.length > MAX_CSV_OUTPUT_BYTES || !data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new AdapterError('VERIFICATION_FAILED', 'The extracted CSV did not have the expected bounded UTF-8 output. No output was written.');
  }
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'pdf-to-csv', input_path: input.path, input_bytes: input.data.length,
    output_path: output, output_bytes: data.length, format: 'csv', delimiter: ',', encoding: 'utf-8', bom: true, line_endings: 'CRLF',
    ...made.summary };
}

if (!isMainThread && workerData?.kind === 'abox-pdf-csv') {
  const budget = { bytes: 0, exceeded: false, unsupported: false };
  try {
    limitWorkerDecompression(budget);
    // Scan before the source opens even its xref. Inflated object streams are
    // scanned too, so an encoded dictionary cannot introduce an unbounded JS
    // filter after this preflight. The scan deliberately errs towards refusal
    // when a blocked PDF name also appears inside text or unused image data.
    const scanner = createPdfFilterScanner(budget);
    scanner.write(workerData.bytes);
    scanner.finish();
    const result = await extract(workerData.bytes, workerData.settings, budget);
    checkDecompressionBudget(budget);
    parentPort.postMessage({ type: 'result', result }, [result.csv.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'error', error: publicFailure(error, budget) }); }
  finally { parentPort.close(); }
}
