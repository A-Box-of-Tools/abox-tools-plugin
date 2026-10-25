import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergePdf, selectPdfPages, MAX_MERGE_INPUTS, MAX_PAGES } from '../src/pdf.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';
import { examplePdfFile } from '../vendor/abox/shared/js/example-pdf.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-extra-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };

async function fixture(directory, name, pages) {
  const filename = path.join(directory, name);
  await writeFile(filename, new Uint8Array(await examplePdfFile(name, { pages }).arrayBuffer()));
  return filename;
}

async function formFixture(directory, filename, fieldName) {
  const writer = new PdfWriter();
  const catalog = writer.reserve();
  const pages = writer.reserve();
  const page = writer.reserve();
  const content = writer.reserve();
  const font = writer.reserve();
  const field = writer.reserve();
  const widget = writer.reserve();
  const form = writer.reserve();
  writer.object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  writer.stream(content, '', new TextEncoder().encode('q Q'));
  writer.object(field, `<< /FT /Tx /T (${fieldName}) /V (Fixture value) /Kids [${widget} 0 R] >>`);
  writer.object(widget, `<< /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P ${page} 0 R /Parent ${field} 0 R >>`);
  writer.object(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents ${content} 0 R /Annots [${widget} 0 R] >>`);
  writer.object(pages, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`);
  writer.object(form, `<< /Fields [${field} 0 R] /DR << /Font << /Helv ${font} 0 R >> >> /DA (/Helv 12 Tf 0 g) >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /AcroForm ${form} 0 R >>`);
  const output = path.join(directory, filename);
  await writeFile(output, new Uint8Array(await writer.finish({ root: catalog }).arrayBuffer()));
  return output;
}

async function document(filename) {
  const bytes = await readFile(filename);
  const doc = await PdfDocument.open(new Uint8Array(bytes));
  return { bytes, doc, source: readSource(doc, path.basename(filename)) };
}

async function statements(filename) {
  const { doc, source } = await document(filename);
  const result = [];
  for (const page of source.pages) {
    const stream = doc.get(page.dict, 'Contents');
    const decoded = await decodeStream(stream, value => doc.resolve(value));
    const match = /STATEMENT (\d+) \/ (\d+)/.exec(new TextDecoder().decode(decoded.bytes));
    assert.ok(match, 'each fixture page must retain its original text content');
    result.push(`${match[1]}/${match[2]}`);
  }
  return result;
}

test('merge preserves input document order, page content, bookmarks, and source bytes', async t => {
  const directory = await workspace(t);
  const first = await fixture(directory, 'first.pdf', 3);
  const second = await fixture(directory, 'second.pdf', 1);
  const before = await Promise.all([first, second].map(async file => hash(await readFile(file))));
  const output = path.join(directory, 'merged.pdf');
  const result = await mergePdf({ input_paths: [second, first], output_path: output });
  assert.equal(result.operation, 'merge-pdf');
  assert.equal(result.verified, true);
  assert.equal(result.input_count, 2);
  assert.equal(result.input_pages, 4);
  assert.equal(result.page_count, 4);
  assert.deepEqual(result.inputs.map(input => input.input_path), [second, first]);
  assert.deepEqual(await statements(output), ['1/1', '1/3', '2/3', '3/3']);
  const written = await document(output);
  assert.equal(written.doc.countPages(), 4);
  assert.equal(result.output_bytes, written.bytes.length);
  assert.deepEqual(written.source.outline.map(bookmark => bookmark.title), ['1. second.pdf', '2. first.pdf']);
  assert.deepEqual(await Promise.all([first, second].map(async file => hash(await readFile(file)))), before);
});

test('merge can deliberately repeat a source and disable bookmark groups', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 2);
  const output = path.join(directory, 'repeated.pdf');
  const result = await mergePdf({ input_paths: [input, input], output_path: output, keep_bookmarks: false });
  assert.equal(result.page_count, 4);
  assert.deepEqual(await statements(output), ['1/2', '2/2', '1/2', '2/2']);
  assert.deepEqual((await document(output)).source.outline, []);
});

test('colliding interactive form fields fail with an actionable limitation and preserve every source', async t => {
  const directory = await workspace(t);
  const inputs = await Promise.all([
    formFixture(directory, 'first-form.pdf', 'SharedName'),
    formFixture(directory, 'second-form.pdf', 'SharedName'),
  ]);
  const before = await Promise.all(inputs.map(async file => hash(await readFile(file))));
  const output = path.join(directory, 'colliding-forms.pdf');
  await assert.rejects(mergePdf({ input_paths: inputs, output_path: output }), error => {
    assert.equal(error.code, 'UNSUPPORTED_PDF_FORMS');
    assert.match(error.message, /colliding form field names/);
    assert.doesNotMatch(error.message, /ReferenceError|t is not defined/);
    return true;
  });
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(inputs.map(async file => hash(await readFile(file)))), before);
  for (const input of inputs) assert.equal((await document(input)).doc.countPages(), 1);
});

test('interactive forms with distinct names still merge and retain both form fields', async t => {
  const directory = await workspace(t);
  const inputs = await Promise.all([
    formFixture(directory, 'first-form.pdf', 'FirstName'),
    formFixture(directory, 'second-form.pdf', 'SecondName'),
  ]);
  const output = path.join(directory, 'distinct-forms.pdf');
  const result = await mergePdf({ input_paths: inputs, output_path: output });
  const { doc } = await document(output);
  assert.equal(result.page_count, 2);
  assert.equal(result.form_widgets, 2);
  const form = doc.get(doc.catalog, 'AcroForm');
  assert.equal(doc.get(form, 'Fields').length, 2);
});

test('page selection rearranges and repeats actual page content without changing the source', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 3);
  const before = hash(await readFile(input));
  const output = path.join(directory, 'rearranged.pdf');
  const result = await selectPdfPages({ input_path: input, output_path: output, pages: '3,1-2,3' });
  assert.equal(result.operation, 'select-pdf-pages');
  assert.equal(result.verified, true);
  assert.equal(result.input_pages, 3);
  assert.equal(result.page_count, 4);
  assert.deepEqual(result.page_order, [3, 1, 2, 3]);
  assert.equal(result.page_order_truncated, false);
  assert.deepEqual(await statements(output), ['3/3', '1/3', '2/3', '3/3']);
  assert.equal(result.output_bytes, (await stat(output)).size);
  assert.equal(hash(await readFile(input)), before);
});

test('range keywords and descending endpoints keep upstream expansion semantics within ordered terms', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 3);
  const output = path.join(directory, 'selected.pdf');
  const result = await selectPdfPages({ input_path: input, output_path: output, pages: 'last;odd;3-1' });
  assert.deepEqual(result.page_order, [3, 1, 3, 1, 2, 3]);
  assert.deepEqual(await statements(output), ['3/3', '1/3', '3/3', '1/3', '2/3', '3/3']);
});

test('selection responses bound the page preview while writing every selected page', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 1);
  const output = path.join(directory, 'many.pdf');
  const result = await selectPdfPages({ input_path: input, output_path: output, pages: Array(101).fill('1').join(',') });
  assert.equal(result.page_count, 101);
  assert.equal(result.page_order.length, 100);
  assert.equal(result.page_order_truncated, true);
  assert.equal((await document(output)).doc.countPages(), 101);
});

test('invalid selections and page expansion limits fail without creating an output', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 3);
  for (const [index, pages] of ['4', '0', '1,bad', '', ',;'].entries()) {
    const output = path.join(directory, `invalid-${index}.pdf`);
    await assert.rejects(selectPdfPages({ input_path: input, output_path: output, pages }), hasCode('INVALID_PAGE_RANGE'));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  const output = path.join(directory, 'too-many.pdf');
  await assert.rejects(selectPdfPages({ input_path: input, output_path: output,
    pages: Array(Math.floor(MAX_PAGES / 3) + 1).fill('all').join(',') }), hasCode('PDF_PAGE_LIMIT'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF merge input count and aggregate size limits are checked before parsing', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'unused.pdf');
  for (const input_paths of [[], ['missing.pdf'], Array(MAX_MERGE_INPUTS + 1).fill('missing.pdf')]) {
    await assert.rejects(mergePdf({ input_paths, output_path: output }), hasCode('PDF_INPUT_LIMIT'));
  }
  const input = path.join(directory, 'large.pdf');
  const file = await open(input, 'w');
  try { await file.truncate(Math.floor(MAX_INPUT_BYTES / 2) + 1); }
  finally { await file.close(); }
  await assert.rejects(mergePdf({ input_paths: [input, input], output_path: output }), hasCode('PDF_TOTAL_SIZE'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('new PDF operations reject overwrites, invalid output suffixes, and nonlocal inputs', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, 'source.pdf', 2);
  const output = path.join(directory, 'existing.pdf');
  const sentinel = Buffer.from('Existing files must survive.');
  await writeFile(output, sentinel);
  await assert.rejects(mergePdf({ input_paths: [input, input], output_path: output }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(selectPdfPages({ input_path: input, output_path: output, pages: '1' }), hasCode('OUTPUT_EXISTS'));
  assert.deepEqual(await readFile(output), sentinel);
  await assert.rejects(selectPdfPages({ input_path: input, output_path: input, pages: '1' }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(mergePdf({ input_paths: [input, input], output_path: path.join(directory, 'wrong.png') }), hasCode('OUTPUT_EXTENSION'));
  for (const invalid of ['relative.pdf', 'https://example.com/source.pdf', String.raw`\\server\share\source.pdf`]) {
    await assert.rejects(mergePdf({ input_paths: [input, invalid], output_path: path.join(directory, 'unused.pdf') }), hasCode('LOCAL_PATH_REQUIRED'));
    await assert.rejects(selectPdfPages({ input_path: invalid, output_path: path.join(directory, 'unused.pdf'), pages: '1' }), hasCode('LOCAL_PATH_REQUIRED'));
  }
});

test('invalid PDF bytes are refused and pre-cancelled calls never write outputs', async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'invalid.pdf');
  await writeFile(input, 'This is not a PDF.');
  const output = path.join(directory, 'unused.pdf');
  await assert.rejects(mergePdf({ input_paths: [input, input], output_path: output }), hasCode('INVALID_PDF'));
  await assert.rejects(selectPdfPages({ input_path: input, output_path: output, pages: '1' }), hasCode('INVALID_PDF'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mergePdf({ input_paths: [input, input], output_path: output }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(selectPdfPages({ input_path: input, output_path: output, pages: '1' }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
