import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { watermarkPdf, MAX_WATERMARK_PAGES } from '../src/pdf-watermark.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };
const closeTo = (actual, expected, tolerance = 0.001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-watermark-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(directory, { pageCount = 3, encrypted = false, skinny = false, tinyCrop = false } = {}) {
  const writer = new PdfWriter();
  const catalog = writer.reserve();
  const tree = writer.reserve();
  const existingImage = writer.reserve();
  const existingState = writer.reserve();
  writer.stream(existingImage, '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8', new Uint8Array([1, 2, 3]));
  writer.object(existingState, '<< /Type /ExtGState /ca 0.7 /CA 0.7 >>');
  const children = [];
  for (let index = 0; index < pageCount; index++) {
    const page = writer.reserve();
    let content = '';
    if (index !== 2 && pageCount < 10) {
      const stream = writer.reserve();
      writer.stream(stream, '', new TextEncoder().encode(`q ${index + 1} 0 0 1 0 0 cm 10 20 30 40 re f Q\n`));
      content = `/Contents ${stream} 0 R`;
    }
    const rotate = index === 1 ? '' : `/Rotate ${index === 2 ? 270 : 0}`;
    const crop = tinyCrop ? '/CropBox [0 0 0.000001 0.000001]' : index === 1 ? '/CropBox [10 20 190 280]' : '';
    const box = skinny ? '[0 0 1 1000000000]' : '[0 0 200 300]';
    writer.object(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox ${box} ${rotate} ${crop} ${content} >>`);
    children.push(`${page} 0 R`);
  }
  writer.object(tree, `<< /Type /Pages /Count ${pageCount} /Kids [${children.join(' ')}] /Rotate 90 /Resources << /XObject << /AbxWmImg ${existingImage} 0 R >> /ExtGState << /AbxWmGs ${existingState} 0 R >> >> >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  const filename = path.join(directory, `source-${pageCount}-${encrypted}-${skinny}-${tinyCrop}.pdf`);
  const blob = writer.finish({ root: catalog, extra: encrypted ? ' /Encrypt << /Filter /Standard >>' : '' });
  await writeFile(filename, new Uint8Array(await blob.arrayBuffer()));
  return filename;
}

async function decode(doc, stream) {
  return Buffer.from((await decodeStream(stream, value => doc.resolve(value))).bytes);
}

async function inspect(filename) {
  const doc = await PdfDocument.open(new Uint8Array(await readFile(filename)));
  const pages = readPages(doc);
  const streams = [];
  for (const page of pages) {
    const contents = doc.resolve(page.dict.get('Contents'));
    const list = contents === undefined ? [] : Array.isArray(contents) ? contents : [contents];
    streams.push(await Promise.all(list.map(value => decode(doc, doc.resolve(value)))));
  }
  return { doc, pages, streams };
}

async function stampAt(document, index) {
  const { doc, pages, streams } = document;
  const drawing = streams[index].at(-1).toString('latin1');
  const imageName = [...drawing.matchAll(/\/([A-Za-z0-9]+) Do/g)][0]?.[1];
  const stateName = [...drawing.matchAll(/\/([A-Za-z0-9]+) gs/g)][0]?.[1];
  assert.ok(imageName && stateName, 'the last stream actually draws an image with an opacity state');
  const resources = doc.resolve(pages[index].dict.get('Resources') ?? pages[index].inherited.get('Resources'));
  const image = doc.get(doc.get(resources, 'XObject'), imageName);
  const mask = doc.get(image.dict, 'SMask');
  const state = doc.get(doc.get(resources, 'ExtGState'), stateName);
  assert.ok(image instanceof PdfStream);
  assert.ok(mask instanceof PdfStream);
  const rgb = await decode(doc, image);
  const alpha = await decode(doc, mask);
  return { drawing, imageName, stateName, image, rgb, alpha,
    width: doc.get(image.dict, 'Width'), height: doc.get(image.dict, 'Height'), state,
    matrices: drawing.split('\n').filter(line => line.endsWith(' cm')).map(line => line.slice(0, -3).trim().split(/\s+/).map(Number)),
    count: [...drawing.matchAll(/\/[A-Za-z0-9]+ Do/g)].length };
}

function retainedContent(before, after, stampedPages) {
  assert.equal(after.pages.length, before.pages.length);
  assert.deepEqual(after.pages.map(page => [page.box, page.visibleBox, page.rotate]), before.pages.map(page => [page.box, page.visibleBox, page.rotate]));
  for (let index = 0; index < before.pages.length; index++) {
    const actual = index < stampedPages && before.streams[index].length
      ? after.streams[index].slice(1, -1) : index < stampedPages ? [] : after.streams[index];
    assert.deepEqual(actual.map(digest), before.streams[index].map(digest));
  }
}

test('watermark embeds actual text pixels on every page while retaining content, cropped rotations and source bytes', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const original = await readFile(input);
  const before = await inspect(input);
  const output = path.join(directory, 'watermarked.pdf');
  const result = await watermarkPdf({ input_path: input, output_path: output, text: 'FOR ACME ONLY', color: 'red', opacity: 0.33 });
  const after = await inspect(output);
  assert.equal(result.operation, 'watermark-pdf');
  assert.equal(result.page_count, 3);
  assert.equal(result.stamped_page_count, 3);
  assert.equal(result.stamp_count, 3);
  assert.equal(result.stamps_verified, true);
  assert.equal(result.rasterized, true);
  assert.equal(result.verified, true);
  retainedContent(before, after, 3);
  const first = await stampAt(after, 0);
  assert.equal(first.imageName, 'AbxWmImg1', 'existing inherited image resources retain their names');
  assert.equal(first.stateName, 'AbxWmGs1');
  assert.equal(first.width, result.stamp_width);
  assert.equal(first.height, result.stamp_height);
  assert.deepEqual([...first.rgb.subarray(0, 3)], [192, 32, 32]);
  assert.ok(first.alpha.some(value => value === 0), 'the picture has transparent background pixels');
  assert.ok(first.alpha.some(value => value > 0), 'the text produced visible glyph pixels');
  assert.equal(first.alpha.length, first.width * first.height);
  assert.equal(after.doc.get(first.state, 'ca'), 0.33);
  for (let index = 0; index < after.pages.length; index++) {
    const stamp = await stampAt(after, index);
    const page = after.pages[index];
    const [left, bottom, right, top] = page.visibleBox;
    const width = page.rotate === 90 || page.rotate === 270 ? top - bottom : right - left;
    const height = page.rotate === 90 || page.rotate === 270 ? right - left : top - bottom;
    assert.equal(stamp.count, 1);
    const [a, b, c, d, e, f] = stamp.matrices[1];
    closeTo(Math.atan2(b, a), Math.atan2(height, width));
    closeTo(a / 2 + c / 2 + e, width / 2);
    closeTo(b / 2 + d / 2 + f, height / 2);
  }
  assert.deepEqual((await stampAt(after, 1)).matrices[0], [0, 1, -1, 0, 190, 20]);
  assert.deepEqual((await stampAt(after, 2)).matrices[0], [0, -1, 1, 0, 0, 300]);
  const secondOutput = path.join(directory, 'different-words.pdf');
  await watermarkPdf({ input_path: input, output_path: secondOutput, text: 'DRAFT 東京', color: 'red', first_page_only: true });
  const second = await stampAt(await inspect(secondOutput), 0);
  assert.notEqual(digest(second.alpha), digest(first.alpha), 'the supplied words change the actual embedded glyph image');
  assert.equal(digest(await readFile(input)), digest(original));
  assert.equal(result.output_bytes, (await stat(output)).size);
  assert.ok(result.warnings.some(value => /not selectable or searchable/.test(value)));
  assert.ok(result.warnings.some(value => /does not redact/.test(value)));
  assert.ok(result.warnings.some(value => /digital signatures/.test(value)));
});

test('repeated horizontal watermarking touches only the first page and preserves inherited resources on other pages', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const before = await inspect(input);
  const sourceHash = digest(await readFile(input));
  const output = path.join(directory, 'first-page.pdf');
  const result = await watermarkPdf({ input_path: input, output_path: output, text: 'INTERNAL', color: 'blue',
    size: 'small', opacity: 0.7, tiled: true, diagonal: false, first_page_only: true });
  const after = await inspect(output);
  retainedContent(before, after, 1);
  const stamp = await stampAt(after, 0);
  assert.equal(result.stamped_page_count, 1);
  assert.ok(result.stamp_count > 1);
  assert.equal(stamp.count, result.stamp_count);
  assert.deepEqual([...stamp.rgb.subarray(0, 3)], [32, 80, 192]);
  for (const [a, b, c, d] of stamp.matrices.slice(1)) {
    assert.ok(a > 0 && d > 0);
    assert.equal(b, 0);
    assert.equal(c, 0);
  }
  assert.equal(after.pages[1].dict.has('Resources'), false);
  assert.equal(after.pages[2].dict.has('Resources'), false);
  const inherited = after.doc.resolve(after.pages[1].inherited.get('Resources'));
  assert.deepEqual([...after.doc.get(inherited, 'XObject').keys()], ['AbxWmImg']);
  assert.equal(digest(await readFile(input)), sourceHash);
});

test('watermark settings, local paths, new output paths, invalid and encrypted PDFs fail without creating an output', async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const original = digest(await readFile(input));
  const output = path.join(directory, 'unused.pdf');
  const base = { input_path: input, output_path: output, text: 'DRAFT' };
  for (const args of [
    { text: '' }, { text: '  ' }, { text: 'one\ntwo' }, { text: 'x'.repeat(201) }, { size: 'huge' },
    { color: '#ff0000' }, { opacity: 0 }, { opacity: 1.1 }, { opacity: NaN }, { diagonal: 1 }, { tiled: 'yes' }, { first_page_only: 1 },
  ]) await assert.rejects(watermarkPdf({ ...base, ...args }), hasCode('INVALID_ARGUMENTS'));
  for (const input_path of ['relative.pdf', 'https://example.com/private.pdf', String.raw`\\server\share\private.pdf`]) {
    await assert.rejects(watermarkPdf({ ...base, input_path }), hasCode('LOCAL_PATH_REQUIRED'));
  }
  await assert.rejects(watermarkPdf({ ...base, output_path: input }), hasCode('OUTPUT_EXISTS'));
  const sentinel = path.join(directory, 'existing.pdf');
  await writeFile(sentinel, 'existing bytes');
  await assert.rejects(watermarkPdf({ ...base, output_path: sentinel }), hasCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(sentinel, 'utf8'), 'existing bytes');
  await assert.rejects(watermarkPdf({ ...base, output_path: path.join(directory, 'unused.png') }), hasCode('OUTPUT_EXTENSION'));
  const invalid = path.join(directory, 'invalid.pdf');
  await writeFile(invalid, 'Not a PDF.');
  await assert.rejects(watermarkPdf({ ...base, input_path: invalid }), hasCode('INVALID_PDF'));
  await assert.rejects(watermarkPdf({ ...base, input_path: await fixture(directory, { encrypted: true }) }), hasCode('ENCRYPTED_PDF'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(digest(await readFile(input)), original);
});

test('watermark input limits and pre-cancellation are checked before rendering', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'unused.pdf');
  const oversized = path.join(directory, 'oversized.pdf');
  const file = await open(oversized, 'w');
  try { await file.truncate(MAX_INPUT_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(watermarkPdf({ input_path: oversized, output_path: output, text: 'DRAFT' }), hasCode('INPUT_SIZE'));
  const manyPages = await fixture(directory, { pageCount: MAX_WATERMARK_PAGES + 1 });
  await assert.rejects(watermarkPdf({ input_path: manyPages, output_path: output, text: 'DRAFT' }), hasCode('PDF_PAGE_LIMIT'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(watermarkPdf({ input_path: manyPages, output_path: output, text: 'DRAFT' }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('cancellation at completed serialization cannot publish a late watermark result', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory);
  const original = digest(await readFile(input));
  const output = path.join(directory, 'cancelled.pdf');
  const controller = new AbortController();
  let completed = false;
  await assert.rejects(watermarkPdf({ input_path: input, output_path: output, text: 'CANCEL THIS' }, {
    signal: controller.signal,
    onProgress(done, total) {
      if (done === total) { completed = true; controller.abort(); }
    },
  }), { name: 'AbortError' });
  assert.equal(completed, true);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(digest(await readFile(input)), original);
});

test('an extreme repeated grid is bounded before the source engine allocates it', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, { pageCount: 1, skinny: true });
  const output = path.join(directory, 'too-many-stamps.pdf');
  await assert.rejects(watermarkPdf({ input_path: input, output_path: output, text: 'DRAFT', tiled: true, diagonal: false }), hasCode('WATERMARK_LIMIT'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('a microscopic visible crop cannot produce a verified but zero-area stamp', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = await fixture(directory, { pageCount: 1, tinyCrop: true });
  const output = path.join(directory, 'zero-area-stamp.pdf');
  await assert.rejects(watermarkPdf({ input_path: input, output_path: output, text: 'DRAFT' }), hasCode('UNSUPPORTED_PDF_GEOMETRY'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
