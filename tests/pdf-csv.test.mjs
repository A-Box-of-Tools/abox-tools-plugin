import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  pdfToCsv, createPdfFilterScanner, UNSUPPORTED_CSV_PDF_NAMES,
  MAX_CSV_PDF_PAGES, MAX_CSV_PAGE_GLYPHS, MAX_CSV_DECOMPRESSED_STREAM_BYTES, MAX_CSV_DECOMPRESSED_BYTES,
} from '../src/pdf-csv.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };
const ledger = [
  ['Date', '@Description', 'Amount', 'Balance'],
  ['03/04/2026', 'Opening', '0.00', '1000.00'],
  ['04/04/2026', 'Coffee, cafe', '-10.00', '990.00'],
  ['05/04/2026', 'He said "hello"', '20.00', '1010.00'],
  ['06/04/2026', '=SUM(1,2)', '-5.00', '1005.00'],
  ['07/04/2026', 'Final', '1.00', '1006.00'],
];

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-csv-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function literal(text) { return String(text).replace(/[\\()]/g, value => `\\${value}`); }

async function fixture(directory, pages, { name = 'source.pdf', encrypted = false } = {}) {
  const writer = new PdfWriter();
  const catalog = writer.reserve();
  const tree = writer.reserve();
  const font = writer.reserve();
  writer.object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const children = [];
  for (const spec of pages) {
    const page = writer.reserve();
    const content = writer.reserve();
    const positions = spec.x ?? [40, 150, 340, 450];
    const drawing = spec.drawing ?? (spec.rows ?? []).map((row, index) => row.map((cell, column) =>
      `BT /F1 10 Tf 1 0 0 1 ${positions[column]} ${720 - index * 18} Tm (${literal(cell)}) Tj ET`).join('\n')).join('\n');
    const bytes = new TextEncoder().encode(drawing);
    writer.stream(content, spec.filter ?? (spec.compress ? '/Filter /FlateDecode' : ''), spec.compress ? deflateSync(bytes) : bytes);
    writer.object(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    children.push(`${page} 0 R`);
  }
  writer.object(tree, `<< /Type /Pages /Count ${pages.length} /Kids [${children.join(' ')}] >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  const data = new Uint8Array(await writer.finish({ root: catalog, extra: encrypted ? ' /Encrypt << /Filter /Standard >>' : '' }).arrayBuffer());
  const filename = path.join(directory, name);
  await writeFile(filename, data);
  return { filename, data };
}

function csvRows(text) {
  assert.equal(text[0], '\ufeff');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let at = 1; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      if (quoted && text[at + 1] === '"') { cell += '"'; at++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && text[at + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; at++;
    } else cell += char;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  return rows;
}

test('PDF to CSV exports real positioned text, quotes fields, normalises values, protects formulas and returns no extracted text', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, [{ rows: ledger }]);
  const output = path.join(directory, 'statement.csv');
  const result = await pdfToCsv({ input_path: input.filename, output_path: output });
  const bytes = await readFile(output);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(csvRows(bytes.toString('utf8')), [
    ['Date', "'@Description", 'Amount', 'Balance'],
    ['2026-04-03', 'Opening', '0.00', '1000.00'],
    ['2026-04-04', 'Coffee, cafe', '-10.00', '990.00'],
    ['2026-04-05', 'He said "hello"', '20.00', '1010.00'],
    ['2026-04-06', "'=SUM(1,2)", '-5.00', '1005.00'],
    ['2026-04-07', 'Final', '1.00', '1006.00'],
  ]);
  assert.equal(result.operation, 'pdf-to-csv');
  assert.equal(result.delimiter, ',');
  assert.equal(result.bom, true);
  assert.equal(result.line_endings, 'CRLF');
  assert.equal(result.input_pages, 1);
  assert.equal(result.table_count, 1);
  assert.equal(result.row_count, 5);
  assert.equal(result.csv_record_count, 6);
  assert.equal(result.formula_like_text_cells, 2);
  assert.equal(result.protected_text_cells, 2);
  assert.equal(result.date_order, 'dmy');
  assert.equal(result.ambiguous_dates, true);
  assert.equal(result.csv_structure_verified, true);
  assert.equal(result.verified, true);
  assert.equal(result.output_bytes, bytes.length);
  assert.equal(result.tables[0].balance_check.comparisons, 4);
  assert.equal(result.tables[0].balance_check.agreeing, 4);
  assert.deepEqual(result.tables[0].balance_check.unchecked_rows, [1]);
  assert.ok(result.warnings.some(message => message.includes('ambiguous')));
  for (const text of ['Coffee', 'Description', 'Opening', 'SUM(1,2)', '1006.00']) assert.ok(!JSON.stringify(result).includes(text));
  assert.equal(hash(await readFile(input.filename)), hash(input.data));

  const rawOutput = path.join(directory, 'raw.csv');
  const raw = await pdfToCsv({ input_path: input.filename, output_path: rawOutput,
    date_order: 'mdy', include_headers: false, spreadsheet_safe: false });
  const rows = csvRows(await readFile(rawOutput, 'utf8'));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], ['2026-03-04', 'Opening', '0.00', '1000.00']);
  assert.equal(rows[3][1], '=SUM(1,2)');
  assert.equal(rows[1][2], '-10.00');
  assert.equal(raw.protected_text_cells, 0);
  assert.ok(raw.warnings.some(message => message.includes('may interpret')));
  assert.equal(hash(await readFile(input.filename)), hash(input.data));
});

test('PDF to CSV selects actual source pages or table indices and preserves table blocks and identifier zeros', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const items = [['Item', 'Count'], ['Paper', '002'], ['Pens', '003'], ['Folders', '004']];
  const input = await fixture(directory, [{ rows: ledger }, { rows: items, x: [60, 260] }]);
  const allPath = path.join(directory, 'all.csv');
  const all = await pdfToCsv({ input_path: input.filename, output_path: allPath, pages: '2,1' });
  const rows = csvRows(await readFile(allPath, 'utf8'));
  assert.equal(all.table_count, 2);
  assert.deepEqual(all.selected_pages, [1, 2]);
  assert.deepEqual(rows[6], ['']);
  assert.deepEqual(rows.slice(7), items);
  assert.deepEqual(all.tables.map(table => table.start_page), [1, 2]);
  const chosenPath = path.join(directory, 'one-table.csv');
  const chosen = await pdfToCsv({ input_path: input.filename, output_path: chosenPath, table_index: 2, include_headers: false });
  assert.equal(chosen.tables_detected, 2);
  assert.equal(chosen.table_count, 1);
  assert.equal(chosen.row_count, 3);
  assert.deepEqual(csvRows(await readFile(chosenPath, 'utf8')), items.slice(1));
  const pagePath = path.join(directory, 'one-page.csv');
  const selected = await pdfToCsv({ input_path: input.filename, output_path: pagePath, pages: 'last,last' });
  assert.deepEqual(selected.selected_pages, [2]);
  assert.deepEqual(selected.tables[0].pages, [2]);
  assert.equal(selected.tables[0].start_page, 2);
  assert.deepEqual(csvRows(await readFile(pagePath, 'utf8')), items);
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: path.join(directory, 'missing.csv'), pages: '2', table_index: 2 }), hasCode('INVALID_TABLE_INDEX'));
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: path.join(directory, 'bad-range.csv'), pages: '3' }), hasCode('INVALID_PAGE_RANGE'));
  assert.equal(hash(await readFile(input.filename)), hash(input.data));
});

test('PDF to CSV supplies neutral headings when no headings are detected and leaves yearless dates unchanged', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, [{ rows: [['03 Apr', 'First', '001'], ['04 Apr', 'Second', '002'], ['05 Apr', 'Third', '003']], x: [40, 160, 350] }]);
  const output = path.join(directory, 'no-heading.csv');
  const result = await pdfToCsv({ input_path: input.filename, output_path: output });
  assert.deepEqual(csvRows(await readFile(output, 'utf8')), [
    ['A', 'B', 'C'], ['03 Apr', 'First', '001'], ['04 Apr', 'Second', '002'], ['05 Apr', 'Third', '003'],
  ]);
  assert.equal(result.tables[0].date_column, null);
  assert.deepEqual(result.tables[0].money_columns, []);
});

test('PDF to CSV refuses scans, prose without tables, encrypted and invalid files without leaking parser text or writing empty output', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const cases = [
    { spec: { drawing: '0 0 100 100 re f' }, code: 'PDF_NO_TEXT' },
    { spec: { rows: [['A confidential paragraph without aligned columns.']] }, code: 'PDF_NO_TABLES' },
  ];
  for (const [index, item] of cases.entries()) {
    const input = await fixture(directory, [item.spec], { name: `unsupported-${index}.pdf` });
    const output = path.join(directory, `unsupported-${index}.csv`);
    await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }), error => {
      assert.equal(error.code, item.code);
      assert.ok(!error.message.includes('confidential'));
      return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(hash(await readFile(input.filename)), hash(input.data));
  }
  const encrypted = await fixture(directory, [{ rows: ledger }], { encrypted: true, name: 'encrypted.pdf' });
  await assert.rejects(pdfToCsv({ input_path: encrypted.filename, output_path: path.join(directory, 'encrypted.csv') }), hasCode('ENCRYPTED_PDF'));
  const invalid = path.join(directory, 'invalid.pdf');
  await writeFile(invalid, 'Private parser data that must not be returned.');
  await assert.rejects(pdfToCsv({ input_path: invalid, output_path: path.join(directory, 'invalid.csv') }), error => {
    assert.equal(error.code, 'INVALID_PDF');
    assert.ok(!error.message.includes('Private'));
    return true;
  });
});

test('PDF to CSV validates settings, local paths, new outputs and file/page/text limits', { timeout: 30000 }, async t => {
  for (const settings of [{ pages: '' }, { pages: '1'.repeat(10001) }, { table_index: 0 }, { table_index: 1001 },
    { table_index: 1.5 }, { date_order: 'ymd' }, { include_headers: 'yes' }, { spreadsheet_safe: 0 }]) {
    await assert.rejects(pdfToCsv(settings), hasCode('INVALID_ARGUMENTS'));
  }
  const directory = await workspace(t);
  const input = await fixture(directory, [{ rows: ledger }]);
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: input.filename }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: path.join(directory, 'wrong.txt') }), hasCode('OUTPUT_EXTENSION'));
  await assert.rejects(pdfToCsv({ input_path: 'https://example.com/private.pdf', output_path: path.join(directory, 'url.csv') }), hasCode('LOCAL_PATH_REQUIRED'));
  const large = path.join(directory, 'large.pdf');
  const file = await open(large, 'wx');
  try { await file.truncate(MAX_INPUT_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(pdfToCsv({ input_path: large, output_path: path.join(directory, 'large.csv') }), hasCode('INPUT_SIZE'));
  const many = await fixture(directory, Array.from({ length: MAX_CSV_PDF_PAGES + 1 }, () => ({ drawing: '' })), { name: 'many.pdf' });
  await assert.rejects(pdfToCsv({ input_path: many.filename, output_path: path.join(directory, 'many.csv') }), hasCode('PDF_PAGE_LIMIT'));
  const dense = await fixture(directory, [{ rows: [['x'.repeat(MAX_CSV_PAGE_GLYPHS + 1)]] }], { name: 'dense.pdf' });
  await assert.rejects(pdfToCsv({ input_path: dense.filename, output_path: path.join(directory, 'dense.csv') }), hasCode('PDF_CSV_LIMIT'));
  assert.equal(hash(await readFile(input.filename)), hash(input.data));
});

test('PDF to CSV terminates a cancelled extraction worker before creating an output', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, Array.from({ length: 20 }, () => ({ rows: ledger })));
  const output = path.join(directory, 'cancelled.csv');
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController();
  let progressed = false;
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }, {
    signal: controller.signal,
    onProgress(done) { if (done >= 1) { progressed = true; controller.abort(); } },
  }), { name: 'AbortError' });
  assert.equal(progressed, true);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(hash(await readFile(input.filename)), hash(input.data));
});

test('PDF to CSV bounds Flate content and xref expansion before buffering and preserves the limit refusal through repair', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const ordinary = await fixture(directory, [{ rows: ledger, compress: true }], { name: 'ordinary-flate.pdf' });
  const ordinaryPath = path.join(directory, 'ordinary.csv');
  const result = await pdfToCsv({ input_path: ordinary.filename, output_path: ordinaryPath });
  assert.equal(result.row_count, 5);
  assert.equal(result.verified, true);

  const content = await fixture(directory, [{ compress: true, drawing: ' '.repeat(MAX_CSV_DECOMPRESSED_STREAM_BYTES + 1) }], { name: 'expanded-content.pdf' });
  assert.ok(content.data.length < 100000, 'The fixture must demonstrate a small compressed input.');
  const root = /\/Root\s+(\d+)\s+0\s+R/.exec(Buffer.from(ordinary.data).toString('latin1'))[1];
  const compressed = deflateSync(Buffer.alloc(MAX_CSV_DECOMPRESSED_STREAM_BYTES + 1));
  const xref = Buffer.concat([
    Buffer.from(ordinary.data),
    Buffer.from(`100 0 obj\n<< /Type /XRef /Size 1 /W [1 4 2] /Root ${root} 0 R /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
    compressed,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${ordinary.data.length}\n%%EOF\n`),
  ]);
  const xrefPath = path.join(directory, 'expanded-xref.pdf');
  await writeFile(xrefPath, xref);
  for (const [input, name] of [[content, 'content'], [{ filename: xrefPath, data: xref }, 'xref']]) {
    const output = path.join(directory, `${name}-refused.csv`);
    await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }), error => {
      assert.equal(error.code, 'PDF_CSV_LIMIT');
      assert.match(error.message, /16 MiB per-stream/);
      assert.ok(!error.message.includes('Opening'));
      return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(hash(await readFile(input.filename)), hash(input.data));
  }
});

test('PDF to CSV bounds cumulative Flate expansion across individually permitted streams', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const drawing = ' '.repeat(MAX_CSV_DECOMPRESSED_STREAM_BYTES);
  const pages = Math.floor(MAX_CSV_DECOMPRESSED_BYTES / MAX_CSV_DECOMPRESSED_STREAM_BYTES) + 1;
  const input = await fixture(directory, Array.from({ length: pages }, () => ({ drawing, compress: true })), { name: 'cumulative.pdf' });
  assert.ok(input.data.length < 200000);
  const output = path.join(directory, 'cumulative.csv');
  await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }), hasCode('PDF_CSV_LIMIT'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(hash(await readFile(input.filename)), hash(input.data));
});

test('the PDF filter preflight recognizes escaped names across chunk boundaries and at end of stream', () => {
  for (const name of UNSUPPORTED_CSV_PDF_NAMES) {
    const escaped = [...name].map(char => `#${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
    const bytes = new TextEncoder().encode(`/${escaped}`);
    for (let split = 0; split <= bytes.length; split++) {
      const budget = { bytes: 0, exceeded: false, unsupported: false };
      const scanner = createPdfFilterScanner(budget);
      assert.throws(() => {
        scanner.write(bytes.subarray(0, split));
        scanner.write(bytes.subarray(split));
        scanner.finish();
      }, hasCode('PDF_CSV_FILTER'));
      assert.equal(budget.unsupported, true);
    }
  }
  const budget = { bytes: 0, exceeded: false, unsupported: false };
  const scanner = createPdfFilterScanner(budget);
  scanner.write(new TextEncoder().encode(`/${'A'.repeat(100000)} /FlateDecode /Safe`));
  scanner.finish();
  assert.equal(budget.unsupported, false);
});

test('PDF to CSV refuses unsupported escaped filters and predictors before decoding, including names hidden in Flate', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const inputs = [];
  for (const name of ['LZWDecode', 'RunLengthDecode', 'A85', 'AHx']) {
    const escaped = [...name].map(char => `#${char.charCodeAt(0).toString(16)}`).join('');
    inputs.push(await fixture(directory, [{ rows: ledger, filter: `/Filter /${escaped}` }], { name: `${name}.pdf` }));
  }
  inputs.push(await fixture(directory, [{ rows: ledger, compress: true,
    filter: '/Filter /FlateDecode /DecodeParms << /#50#72#65#64#69#63#74#6f#72 12 /Columns 7 >>' }], { name: 'predictor.pdf' }));
  const hiddenName = '/L#5aWDecode';
  const hidden = await fixture(directory, [{ drawing: `% ${hiddenName}`, compress: true }], { name: 'hidden.pdf' });
  assert.equal(Buffer.from(hidden.data).includes(Buffer.from(hiddenName)), false);
  inputs.push(hidden);
  for (const [at, input] of inputs.entries()) {
    const output = path.join(directory, `unsupported-filter-${at}.csv`);
    await assert.rejects(pdfToCsv({ input_path: input.filename, output_path: output }), error => {
      assert.equal(error.code, 'PDF_CSV_FILTER');
      assert.match(error.message, /Legacy filters, ASCII armours and predictors are unsupported/);
      assert.ok(!error.message.includes('Opening'));
      return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(hash(await readFile(input.filename)), hash(input.data));
  }
});
