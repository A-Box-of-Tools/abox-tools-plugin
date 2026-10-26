import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { compressPdf, MAX_COMPRESS_PDF_PAGES } from '../src/pdf-compress.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';

const hasCode = code => error => { assert.equal(error.code, code); return true; };
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-compress-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
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

function blankPages(count = 1, trailer = '') {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${count} /MediaBox [0 0 612 792] >>`,
    ...Array(count).fill('<< /Type /Page /Parent 2 0 R >>'),
  ], trailer);
}

test('PDF compression validates the source-engine settings without silently clamping', async () => {
  for (const settings of [
    { preset: 'custom' }, { preset: 'toString' }, { dpi: -1 }, { dpi: 1201 }, { dpi: '130' },
    { quality: 0.29 }, { quality: 0.951 }, { quality: Number.NaN }, { strip_metadata: 'yes' },
  ]) await assert.rejects(compressPdf(settings), hasCode('INVALID_ARGUMENTS'));
});

test('PDF compression refuses existing, nonlocal, and non-PDF output paths before browser work', async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'source.pdf');
  const bytes = blankPages();
  await writeFile(input, bytes);
  await assert.rejects(compressPdf({ input_path: input, output_path: input }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(compressPdf({ input_path: input, output_path: 'https://example.com/result.pdf' }), hasCode('LOCAL_PATH_REQUIRED'));
  await assert.rejects(compressPdf({ input_path: input, output_path: path.join(directory, 'result.txt') }), hasCode('OUTPUT_EXTENSION'));
  await assert.rejects(compressPdf({ input_path: 'https://example.com/source.pdf', output_path: path.join(directory, 'result.pdf') }), hasCode('LOCAL_PATH_REQUIRED'));
  assert.deepEqual(await readFile(input), bytes);
});

test('PDF compression bounds file size, actual page count, and image allocations before browser work', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'unused.pdf');
  const oversized = path.join(directory, 'oversized.pdf');
  const file = await open(oversized, 'wx');
  try { await file.truncate(MAX_INPUT_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(compressPdf({ input_path: oversized, output_path: output }), hasCode('INPUT_SIZE'));
  const pages = path.join(directory, 'pages.pdf');
  await writeFile(pages, blankPages(MAX_COMPRESS_PDF_PAGES + 1));
  await assert.rejects(compressPdf({ input_path: pages, output_path: output }), hasCode('PDF_PAGE_LIMIT'));
  const giant = path.join(directory, 'giant-image.pdf');
  await writeFile(giant, pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im 4 0 R >> >> >>',
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 10000 /Height 10000 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Length 5000 >>\nstream\n'), Buffer.alloc(5000), Buffer.from('\nendstream')]),
  ]));
  await assert.rejects(compressPdf({ input_path: giant, output_path: output }), hasCode('PDF_IMAGE_PIXEL_LIMIT'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF compression refuses unreadable and encrypted documents without creating output', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'unused.pdf');
  const invalid = path.join(directory, 'invalid.pdf');
  await writeFile(invalid, 'This is not a PDF.');
  await assert.rejects(compressPdf({ input_path: invalid, output_path: output }), hasCode('INVALID_PDF'));
  const encrypted = path.join(directory, 'encrypted.pdf');
  const original = blankPages(1, '/Encrypt << /Filter /Standard /V 4 /R 4 >>');
  await writeFile(encrypted, original);
  await assert.rejects(compressPdf({ input_path: encrypted, output_path: output }), hasCode('ENCRYPTED_PDF'));
  assert.deepEqual(await readFile(encrypted), original);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF compression checks actual JPEG dimensions and refuses EXIF rotation before browser work', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'unused.pdf');
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x27, 0x10, 0x27, 0x10, 3,
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const padding = Buffer.alloc(8192);
  let state = 123456789;
  for (let index = 0; index < padding.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    padding[index] = state >>> 24;
  }
  const jpeg = Buffer.concat([header, padding]);
  for (const wrapped of [false, true]) {
    const bytes = wrapped ? deflateSync(jpeg) : jpeg;
    assert.ok(bytes.length > 4096, 'The fixture must reach the source engine decoder rather than its tiny-image skip.');
    const input = path.join(directory, `frame-${wrapped}.pdf`);
    const original = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im 4 0 R >> >> >>',
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter ${wrapped ? '[/FlateDecode /DCTDecode]' : '/DCTDecode'} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]),
    ]);
    await writeFile(input, original);
    await assert.rejects(compressPdf({ input_path: input, output_path: output }), hasCode('PDF_IMAGE_PIXEL_LIMIT'));
    assert.deepEqual(await readFile(input), original);
  }
  const smallHeader = Buffer.from(header);
  smallHeader.writeUInt16BE(20, 7);
  smallHeader.writeUInt16BE(30, 9);
  const tiff = Buffer.alloc(26);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const marker = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
  const rotatedJpeg = Buffer.concat([smallHeader.subarray(0, 2), marker, exif, smallHeader.subarray(2), padding]);
  const rotatedInput = path.join(directory, 'rotated-jpeg.pdf');
  const rotatedPdf = pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im 4 0 R >> >> >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 30 /Height 20 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length ${rotatedJpeg.length} >>\nstream\n`), rotatedJpeg, Buffer.from('\nendstream')]),
  ]);
  await writeFile(rotatedInput, rotatedPdf);
  await assert.rejects(compressPdf({ input_path: rotatedInput, output_path: output }), hasCode('UNSUPPORTED_PDF_JPEG_ORIENTATION'));
  assert.deepEqual(await readFile(rotatedInput), rotatedPdf);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF compression honours cancellation before reading input or opening a browser', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelled before processing.'));
  await assert.rejects(compressPdf({}, { signal: controller.signal }), /Cancelled before processing/);
});
