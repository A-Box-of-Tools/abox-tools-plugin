import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rotatePdf } from '../src/pdf.mjs';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-rotate-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(directory, { parentRotation } = {}) {
  const writer = new PdfWriter();
  const catalog = writer.reserve();
  const pages = writer.reserve();
  const pageRefs = [];
  for (const [index, rotation] of [0, 90, 270].entries()) {
    const page = writer.reserve();
    const content = writer.reserve();
    writer.stream(content, '', new TextEncoder().encode(`q ${index + 1} 0 0 1 0 0 cm Q`));
    const rotationEntry = parentRotation !== undefined && index === 0 ? '' : `/Rotate ${rotation}`;
    writer.object(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${200 + index} 300] ${rotationEntry} /Resources << >> /Contents ${content} 0 R >>`);
    pageRefs.push(`${page} 0 R`);
  }
  const inherited = parentRotation === undefined ? '' : `/Rotate ${parentRotation}`;
  writer.object(pages, `<< /Type /Pages /Count 3 /Kids [${pageRefs.join(' ')}] ${inherited} >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  const filename = path.join(directory, 'source.pdf');
  await writeFile(filename, new Uint8Array(await writer.finish({ root: catalog }).arrayBuffer()));
  return filename;
}

async function inspect(filename) {
  const doc = await PdfDocument.open(new Uint8Array(await readFile(filename)));
  const source = readSource(doc, path.basename(filename));
  const fingerprints = [];
  for (const page of source.pages) {
    const stream = doc.get(page.dict, 'Contents');
    const decoded = await decodeStream(stream, value => doc.resolve(value));
    fingerprints.push(digest(decoded.bytes));
  }
  return { pages: source.pages, fingerprints };
}

test('PDF rotation changes only selected display rotations and preserves page content and source bytes', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const original = await readFile(input);
  const before = await inspect(input);
  const output = path.join(directory, 'rotated.pdf');
  const result = await rotatePdf({ input_path: input, output_path: output, degrees: 90, pages: '3,1,3' });
  const after = await inspect(output);
  assert.equal(result.operation, 'rotate-pdf');
  assert.equal(result.page_count, 3);
  assert.equal(result.rotated_page_count, 2);
  assert.deepEqual(result.rotated_pages, [1, 3]);
  assert.equal(result.rotation_verified, true);
  assert.equal(result.verified, true);
  assert.deepEqual(after.pages.map(page => page.rotate), [90, 90, 0]);
  assert.deepEqual(after.pages.map(page => page.box), before.pages.map(page => page.box));
  assert.deepEqual(after.fingerprints, before.fingerprints);
  assert.equal(digest(await readFile(input)), digest(original));
  assert.equal(result.output_bytes, (await stat(output)).size);
});

test('default selection rotates every page and retains its existing orientation', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const output = path.join(directory, 'all.pdf');
  const result = await rotatePdf({ input_path: input, output_path: output, degrees: 270 });
  assert.equal(result.rotated_page_count, 3);
  assert.deepEqual((await inspect(output)).pages.map(page => page.rotate), [270, 0, 180]);
});

test('rotation resolves inherited parent orientation and respects explicit page overrides', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, { parentRotation: 90 });
  const original = await readFile(input);
  const before = await inspect(input);
  assert.deepEqual(before.pages.map(page => page.rotate), [90, 90, 270]);
  assert.equal(before.pages[0].dict.has('Rotate'), false);
  const output = path.join(directory, 'inherited-rotation.pdf');
  const result = await rotatePdf({ input_path: input, output_path: output, degrees: 90, pages: '1,3' });
  const after = await inspect(output);
  assert.equal(result.rotation_verified, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.rotated_pages, [1, 3]);
  assert.deepEqual(after.pages.map(page => page.rotate), [180, 90, 0]);
  assert.deepEqual(after.fingerprints, before.fingerprints);
  assert.deepEqual(after.pages.map(page => page.box), before.pages.map(page => page.box));
  assert.equal(digest(await readFile(input)), digest(original));
});

test('rotation validates angles and ranges before creating any output', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  for (const [index, degrees] of [0, -90, 45, 360, '90'].entries()) {
    const output = path.join(directory, `angle-${index}.pdf`);
    await assert.rejects(rotatePdf({ input_path: input, output_path: output, degrees }), hasCode('INVALID_ARGUMENTS'));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  for (const [index, pages] of ['', '0', '4', '1,bad'].entries()) {
    const output = path.join(directory, `range-${index}.pdf`);
    await assert.rejects(rotatePdf({ input_path: input, output_path: output, degrees: 90, pages }), hasCode('INVALID_PAGE_RANGE'));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('rotation refuses existing outputs and leaves cancellation and local path protections intact', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const before = digest(await readFile(input));
  await assert.rejects(rotatePdf({ input_path: input, output_path: input, degrees: 90 }), hasCode('OUTPUT_EXISTS'));
  const output = path.join(directory, 'unused.pdf');
  await assert.rejects(rotatePdf({ input_path: 'https://example.com/source.pdf', output_path: output, degrees: 90 }), hasCode('LOCAL_PATH_REQUIRED'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rotatePdf({ input_path: input, output_path: output, degrees: 90 }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(digest(await readFile(input)), before);
});
