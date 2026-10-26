import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { compressPdf } from '../src/pdf-compress.mjs';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { decodeStream, filterNames } from '../vendor/abox/shared/js/pdf-filters.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { inspectJpeg } from '../vendor/abox/tools/images-to-pdf/src/jpeg.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-compress-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function stream(bytes, dictionary = '') {
  const data = Buffer.from(bytes);
  return Buffer.concat([Buffer.from(`<< /Length ${data.length} ${dictionary} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

function pdf(objects, trailer = '') {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let size = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    size += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function inspect(filename) {
  const bytes = await readFile(filename);
  const doc = await PdfDocument.open(new Uint8Array(bytes));
  const pages = readPages(doc);
  const content = [];
  for (const page of pages) {
    const value = doc.get(page.dict, 'Contents');
    const parts = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
    const decoded = [];
    for (const part of parts) {
      const item = await decodeStream(doc.resolve(part), value => doc.resolve(value));
      assert.deepEqual(item.remaining, []);
      decoded.push(Buffer.from(item.bytes).toString('latin1'));
    }
    content.push(decoded);
  }
  return { bytes, doc, pages, content };
}

function resources(doc, page) {
  return doc.resolve(page.dict.get('Resources') ?? page.inherited.get('Resources'));
}

test('PDF compression preserves text, drawing operators, page geometry, fonts and attachments while rewriting and stripping metadata', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const content = [
    'BT /F1 14 Tf 40 700 Td (Selectable text on page one.) Tj ET\n',
    'q 0.2 0.4 0.6 rg 20 30 100 50 re f Q\n',
    'BT /F1 12 Tf 30 500 Td (A different second page.) Tj ET\n',
  ];
  const attachment = 'An embedded attachment must survive compression.\n';
  const metadata = '<x:xmpmeta>Private production metadata</x:xmpmeta>'.repeat(500);
  const original = pdf([
    '<< /Type /Catalog /Pages 2 0 R /Metadata 9 0 R /Names << /EmbeddedFiles << /Names [(note.txt) 11 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 /MediaBox [0 0 612.123456789 792] /Resources << /Font << /F1 8 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] /CropBox [10.123456789 20 580.123456789 760] /Rotate 90 >>',
    stream(content[0]), stream(deflateSync(Buffer.from(content[1])), '/Filter /FlateDecode /DecodeParms << /Predictor 1 >>'),
    stream('This unreachable object should be dropped.\n'.repeat(1000)),
    '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 10 0 R] /MediaBox [0 0 400 500] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(metadata, '/Type /Metadata /Subtype /XML'), stream(content[2]),
    '<< /Type /Filespec /F (note.txt) /EF << /F 12 0 R >> >>',
    stream(attachment, '/Type /EmbeddedFile'),
    '<< /Title (Private title) /Author (Private author) >>',
  ], '/Info 13 0 R');
  const input = path.join(directory, 'document.pdf');
  const output = path.join(directory, 'compressed.pdf');
  await writeFile(input, original);
  const result = await compressPdf({ input_path: input, output_path: output, preset: 'print' });
  const actual = await inspect(output);
  assert.equal(result.operation, 'compress-pdf');
  assert.equal(result.page_count, 2);
  assert.equal(result.content_verified, true);
  assert.equal(result.verified, true);
  assert.equal(result.smaller, true);
  assert.equal(result.images_changed, 0);
  assert.deepEqual(actual.content, [[content[0], content[1]], [content[0], content[2]]]);
  assert.deepEqual(actual.pages.map(page => page.box), [[0, 0, 612.123457, 792], [0, 0, 400, 500]]);
  assert.deepEqual(actual.pages.map(page => page.rotate), [90, 0]);
  assert.deepEqual(actual.pages[0].visibleBox, [10.123457, 20, 580.123457, 760]);
  const font = actual.doc.resolve(actual.doc.get(resources(actual.doc, actual.pages[0]), 'Font').get('F1'));
  assert.equal(actual.doc.get(font, 'BaseFont').value, 'Helvetica');
  const embedded = actual.doc.get(actual.doc.get(actual.doc.catalog, 'Names'), 'EmbeddedFiles');
  const filespec = actual.doc.resolve(actual.doc.get(embedded, 'Names')[1]);
  const payload = actual.doc.get(actual.doc.get(filespec, 'EF'), 'F');
  assert.equal(Buffer.from((await decodeStream(payload, value => actual.doc.resolve(value))).bytes).toString(), attachment);
  assert.equal(actual.doc.catalog.has('Metadata'), false);
  assert.equal(actual.doc.trailer.has('Info'), false);
  assert.ok(result.metadata_entries_removed >= 2);
  assert.ok(!actual.bytes.includes(Buffer.from('Private production metadata')));
  assert.equal(result.output_bytes, (await stat(output)).size);
  assert.equal(result.saved_bytes, original.length - actual.bytes.length);
  assert.equal(hash(await readFile(input)), hash(original));

  const retainedPath = path.join(directory, 'with-metadata.pdf');
  const retainedResult = await compressPdf({ input_path: input, output_path: retainedPath,
    preset: 'gentle', dpi: 72, quality: 0.4, strip_metadata: false });
  const retained = await inspect(retainedPath);
  assert.deepEqual(retained.content, actual.content);
  assert.equal(retainedResult.dpi, 72);
  assert.equal(retainedResult.quality, 0.4);
  assert.equal(retainedResult.strip_metadata, false);
  assert.equal(retainedResult.metadata_entries_removed, 0);
  assert.ok(retained.doc.trailer.has('Info'));
  const xmp = retained.doc.get(retained.doc.catalog, 'Metadata');
  assert.ok(xmp instanceof PdfStream);
  assert.equal(Buffer.from((await decodeStream(xmp, value => retained.doc.resolve(value))).bytes).toString(), metadata);
  assert.equal(hash(await readFile(input)), hash(original));
});

test('PDF compression downsamples a drawn scan into a real smaller JPEG and keeps CMYK image bytes unchanged', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  let state = 123456789;
  function noise(size) {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[index] = state >>> 24;
    }
    return bytes;
  }
  const rgb = deflateSync(noise(800 * 1000 * 3));
  const cmyk = deflateSync(noise(128 * 128 * 4));
  const content = 'BT /F1 12 Tf 20 500 Td (This text remains selectable.) Tj ET\nq 288 0 0 360 0 0 cm /Scan Do Q\nq 72 0 0 72 300 0 cm /Print Do Q\n';
  const original = pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Scan 6 0 R /Print 7 0 R >> >> >>',
    stream(content), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(rgb, '/Type /XObject /Subtype /Image /Width 800 /Height 1000 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode'),
    stream(cmyk, '/Type /XObject /Subtype /Image /Width 128 /Height 128 /BitsPerComponent 8 /ColorSpace /DeviceCMYK /Filter /FlateDecode'),
  ]);
  const input = path.join(directory, 'scan.pdf');
  const output = path.join(directory, 'smaller.pdf');
  await writeFile(input, original);
  const result = await compressPdf({ input_path: input, output_path: output, preset: 'smallest' });
  const actual = await inspect(output);
  assert.deepEqual(actual.content, [[content]]);
  assert.equal(result.dpi, 96);
  assert.equal(result.quality, 0.55);
  assert.equal(result.image_count, 2);
  assert.equal(result.images_changed, 1);
  assert.equal(result.images_downsampled, 1);
  assert.equal(result.images_kept, 1);
  assert.ok(actual.bytes.length < original.length / 2);
  const xobjects = actual.doc.get(resources(actual.doc, actual.pages[0]), 'XObject');
  const scan = actual.doc.resolve(xobjects.get('Scan'));
  assert.deepEqual(filterNames(scan.dict, value => actual.doc.resolve(value)), ['DCTDecode']);
  assert.equal(actual.doc.get(scan.dict, 'Width'), 384);
  assert.equal(actual.doc.get(scan.dict, 'Height'), 480);
  assert.deepEqual([...scan.raw.subarray(0, 2)], [0xff, 0xd8]);
  const jpeg = inspectJpeg(scan.raw);
  assert.equal(jpeg.width, 384);
  assert.equal(jpeg.height, 480);
  const print = actual.doc.resolve(xobjects.get('Print'));
  assert.deepEqual(Buffer.from(print.raw), cmyk);
  assert.equal(actual.doc.get(print.dict, 'ColorSpace').value, 'DeviceCMYK');
  assert.ok(result.images.some(image => image.reason_code === 'kept.cmyk' && /CMYK/.test(image.reason)));
  assert.ok(result.kept_image_reasons.some(reason => reason.reason_code === 'kept.cmyk' && reason.count === 1));
  assert.ok(result.warnings.some(warning => warning.includes('lose detail')));
  assert.equal(hash(await readFile(input)), hash(original));

  const wrappedPath = path.join(directory, 'wrapped-jpeg.pdf');
  const wrappedOutput = path.join(directory, 'wrapped-compressed.pdf');
  const wrappedContent = 'q 288 0 0 360 0 0 cm /Scan Do Q\n';
  const wrapped = pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /XObject << /Scan 4 0 R >> >> >>',
    stream(deflateSync(scan.raw), '/Type /XObject /Subtype /Image /Width 384 /Height 480 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter [/FlateDecode /DCTDecode]'),
    stream(wrappedContent),
  ]);
  await writeFile(wrappedPath, wrapped);
  const wrappedResult = await compressPdf({ input_path: wrappedPath, output_path: wrappedOutput, preset: 'smallest' });
  assert.equal(wrappedResult.verified, true);
  assert.deepEqual((await inspect(wrappedOutput)).content, [[wrappedContent]]);
  assert.equal(hash(await readFile(wrappedPath)), hash(wrapped));
});

test('PDF compression reports a larger output honestly and never overwrites an earlier result', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const original = pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R >>',
  ]);
  const input = path.join(directory, 'small.pdf');
  const output = path.join(directory, 'rewritten.pdf');
  await writeFile(input, original);
  const result = await compressPdf({ input_path: input, output_path: output });
  const bytes = await readFile(output);
  assert.ok(bytes.length >= original.length, 'The tiny classic-table fixture should grow when packed into PDF 1.5.');
  assert.equal(result.smaller, false);
  assert.equal(result.saved_bytes, original.length - bytes.length);
  assert.ok(result.saved_percent <= 0);
  assert.ok(result.warnings.some(warning => warning.includes('not smaller')));
  assert.equal((await inspect(output)).doc.countPages(), 1);
  await assert.rejects(compressPdf({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(hash(await readFile(output)), hash(bytes));
  assert.equal(hash(await readFile(input)), hash(original));
});
