import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { redactPdf } from '../src/pdf-raster-redact.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { redactionFixture, redactionRegions } from './fixtures/pdf-raster-redaction.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 180000 }, hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) { const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-redact-browser-'))); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function outputImages(bytes) {
  const doc = await PdfDocument.open(Uint8Array.from(bytes)), pages = readPages(doc), images = [];
  for (const page of pages) {
    const resources = doc.resolve(page.dict.get('Resources')), xobject = doc.resolve(resources.get('XObject')), stream = doc.resolve([...xobject.values()][0]);
    assert.ok(stream instanceof PdfStream); const width = stream.dict.get('Width'), height = stream.dict.get('Height'), rgb = inflateSync(stream.raw, { maxOutputLength: width * height * 3 });
    assert.equal(rgb.length, width * height * 3); images.push({ width, height, rgb, page });
  }
  return { doc, images };
}
function color(image, x, y) { return Array.from(image.rgb.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3)); }

test('permanent PDF redaction masks text and scanned pixels, rasterizes every crop/rotation and omits the entire old object graph', browserOptions, async t => {
  const directory = await workspace(t), source = await redactionFixture(), input = path.join(directory, 'private.pdf'), output = path.join(directory, 'redacted.pdf'), config = path.join(directory, 'regions.json');
  await writeFile(input, source); await writeFile(config, JSON.stringify(redactionRegions()));
  const result = await redactPdf({ input_path: input, output_path: output, regions_path: config, dpi: 72 });
  assert.equal(result.verified, true); assert.equal(result.flattened, true); assert.equal(result.searchable_text, false); assert.equal(result.page_count, 3);
  assert.equal(result.verification.original_objects_copied, false); assert.equal(result.verification.exact_stored_rgb_pixels, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE TEXT SECRET')); assert.ok(!JSON.stringify(result).includes('PRIVATE SOURCE TITLE'));
  const saved = await readFile(output), { doc, images } = await outputImages(saved);
  assert.equal(doc.objects.size, 11); assert.equal(doc.trailer.has('Info'), false); assert.equal(doc.catalog.has('Metadata'), false); assert.equal(doc.catalog.has('Names'), false);
  assert.deepEqual(images.map(image => [image.width, image.height]), [[100, 80], [100, 80], [100, 160]]);
  for (const [index, image] of images.entries()) {
    assert.equal(image.page.dict.has('Annots'), false); assert.equal(image.page.dict.has('Rotate'), false);
    assert.equal(image.page.dict.has('UserUnit'), false); assert.equal(image.page.dict.get('Resources').has('Font'), false);
    const region = redactionRegions().pages[index].regions[0], left = Math.max(0, Math.floor(region.x) - 1), top = Math.max(0, Math.floor(region.y) - 1),
      right = Math.min(image.width, Math.ceil(region.x + region.width) + 1), bottom = Math.min(image.height, Math.ceil(region.y + region.height) + 1);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) assert.deepEqual(color(image, x, y), [0, 0, 0]);
  }
  for (const image of images.slice(0, 2)) { assert.deepEqual(color(image, 10, 10), [255, 0, 0]); assert.deepEqual(color(image, 90, 10), [0, 0, 255]); }
  for (const secret of ['PRIVATE TEXT SECRET', 'PRIVATE SOURCE TITLE', 'PRIVATE SOURCE AUTHOR', 'PRIVATE XML METADATA', 'PRIVATE EMBEDDED ORIGINAL FILE', 'PRIVATE ANNOTATION']) assert.ok(!saved.includes(Buffer.from(secret)));
  assert.equal(hash(await readFile(input)), hash(source));
  const readable = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'redacted.pdf', mimeType: 'application/pdf', buffer: saved });
    return page.evaluate(async () => {
      const library = await import('/pdfjs/legacy/build/pdf.mjs'); library.GlobalWorkerOptions.workerSrc = '/pdfjs/legacy/build/pdf.worker.mjs';
      const task = library.getDocument({ data: new Uint8Array(await document.querySelector('#input').files[0].arrayBuffer()), isEvalSupported: false, useWasm: false }), doc = await task.promise;
      try { const counts = []; for (let index = 1; index <= doc.numPages; index++) counts.push((await (await doc.getPage(index)).getTextContent()).items.length); return counts; }
      finally { await task.destroy(); }
    });
  }, { pdfjs: true });
  assert.deepEqual(readable, [0, 0, 0]);
});

test('checked JPEG scan pixels are permanently replaced by lossless black output and omitted source bytes', browserOptions, async t => {
  const directory = await workspace(t), jpeg = Buffer.from(await withBrowser(page => page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 16, 32); context.fillStyle = '#0000ff'; context.fillRect(16, 0, 16, 32);
    return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
  })), 'base64');
  const source = await redactionFixture({ pages: 2, imageFilter: 'DCTDecode', imageRaw: jpeg }), input = path.join(directory, 'scan.pdf'), output = path.join(directory, 'scan-redacted.pdf'), config = path.join(directory, 'scan-regions.json');
  await writeFile(input, source); await writeFile(config, JSON.stringify(redactionRegions(2)));
  const result = await redactPdf({ input_path: input, output_path: output, regions_path: config, dpi: 144 });
  assert.equal(result.verified, true); const { images } = await outputImages(await readFile(output));
  assert.equal(images[1].width, 200); assert.equal(images[1].height, 160); assert.deepEqual(color(images[1], 60, 70), [0, 0, 0]);
  const outside = color(images[1], 20, 20); assert.ok(outside[0] > 240 && outside[1] < 10 && outside[2] < 10);
  assert.equal(hash(await readFile(input)), hash(source));
});

test('page-geometry mismatch, raster expansion and in-flight cancellation never produce a partial redacted PDF', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.pdf'), output = path.join(directory, 'absent.pdf'), config = path.join(directory, 'regions.json'), source = await redactionFixture(); await writeFile(input, source);
  const wrong = redactionRegions(); wrong.pages[0].width_pt = 101; await writeFile(config, JSON.stringify(wrong));
  await assert.rejects(redactPdf({ input_path: input, output_path: output, regions_path: config }), { code: 'PDF_REDACT_RENDER' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(config, JSON.stringify(redactionRegions()));
  const controller = new AbortController(), pending = redactPdf({ input_path: input, output_path: output, regions_path: config }, { signal: controller.signal }), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), source);
});

test('renderer warnings for discarded commands or missing resources refuse output without leaking private operator names', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'unsupported.pdf'), config = path.join(directory, 'regions.json');
  await writeFile(config, JSON.stringify(redactionRegions(1)));
  const cases = [{ extraOperators: 'PRIVATE_UNSUPPORTED_OPERATOR\n' }, { extraOperators: '/PRIVATE_MISSING_IMAGE Do\n' },
    { fontDictionary: '<< /Type /Font /Subtype /Type0 /BaseFont /PRIVATE_BROKEN_FONT >>' }];
  for (const [index, settings] of cases.entries()) {
    const source = await redactionFixture({ pages: 1, ...settings }), output = path.join(directory, `absent-${index}.pdf`);
    await writeFile(input, source);
    await assert.rejects(redactPdf({ input_path: input, output_path: output, regions_path: config, dpi: 72 }), error => {
      assert.equal(error.code, 'PDF_REDACT_RENDER'); assert.ok(!error.message.includes('PRIVATE')); return true;
    }, `unsupported drawing fixture ${index}`);
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), source);
  }
});
