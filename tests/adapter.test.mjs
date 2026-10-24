import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { execute } from '../src/tools.mjs';
import { examplePdfFile } from '../vendor/abox/shared/js/example-pdf.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';

const INPUT_LIMIT = 128 * 1024 * 1024;

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'abox-adapter-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasCode(code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    return true;
  };
}

// The fixture is assembled here so its metadata and pixels can be checked
// independently of the production readers and writers.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

function exifFixture() {
  const model = Buffer.from('Private camera\0', 'ascii');
  const result = Buffer.alloc(38 + model.length);
  result.write('II', 0, 'ascii');
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(8, 4);
  result.writeUInt16LE(2, 8);
  result.writeUInt16LE(0x0110, 10);
  result.writeUInt16LE(2, 12);
  result.writeUInt32LE(model.length, 14);
  result.writeUInt32LE(38, 18);
  result.writeUInt16LE(0x0112, 22);
  result.writeUInt16LE(3, 24);
  result.writeUInt32LE(1, 26);
  result.writeUInt16LE(6, 30);
  model.copy(result, 38);
  return result;
}

function pngFixture() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const profile = Buffer.alloc(132);
  profile.writeUInt32BE(profile.length, 0);
  profile.writeUInt32BE(0x04300000, 8);
  profile.write('mntrRGB XYZ ', 12, 'ascii');
  profile.write('acsp', 36, 'ascii');
  const iccp = Buffer.concat([Buffer.from('Fixture\0\0', 'ascii'), deflateSync(profile)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('iCCP', iccp),
    chunk('eXIf', exifFixture()),
    chunk('tEXt', Buffer.from('Comment\0Private annotation', 'ascii')),
    chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>Private XMP</x:xmpmeta>', 'ascii')),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunks(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'PNG chunk must remain in bounds');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + length + 8), crc32(bytes.subarray(offset + 4, offset + length + 8)));
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.equal(offset, bytes.length);
  assert.equal(chunks.at(-1).type, 'IEND');
  return chunks;
}

function exifEntries(data) {
  if (data.subarray(0, 6).equals(Buffer.from('Exif\0\0', 'ascii'))) data = data.subarray(6);
  const little = data.toString('ascii', 0, 2) === 'II';
  const u16 = offset => little ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
  const u32 = offset => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  assert.equal(u16(2), 42);
  const offset = u32(4);
  const result = new Map();
  for (let index = 0; index < u16(offset); index++) {
    const entry = offset + 2 + index * 12;
    result.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), inline: u16(entry + 8) });
  }
  return result;
}

async function pdfFixture(dir, pages = 3) {
  const input = path.join(dir, 'source.pdf');
  const file = examplePdfFile('source.pdf', { pages });
  await writeFile(input, new Uint8Array(await file.arrayBuffer()));
  return input;
}

async function checkPdfOutputs(result, expected, outputDir) {
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.output_dir, outputDir);
  assert.equal(result.outputs.length, expected.length);
  const names = new Set();
  for (let index = 0; index < expected.length; index++) {
    const output = result.outputs[index];
    assert.equal(path.dirname(output.output_path), outputDir);
    assert.ok(!names.has(output.output_path), 'every part must have its own file');
    names.add(output.output_path);
    assert.deepEqual(output.pages, expected[index]);
    assert.equal(output.page_count, expected[index].length);
    assert.equal(output.verified, true);
    const bytes = await readFile(output.output_path);
    assert.equal(output.output_bytes, bytes.length);
    const document = await PdfDocument.open(new Uint8Array(bytes));
    assert.equal(document.countPages(), expected[index].length);
  }
}

test('capabilities describes local operations and the input bound', async () => {
  const result = await execute('abox_capabilities', {});
  assert.equal(result.ok, true);
  assert.equal(result.processing, 'local');
  assert.equal(result.max_input_bytes, INPUT_LIMIT);
  assert.equal(result.operations.length, 3);
  assert.equal(typeof result.browser.available, 'boolean');
});

test('EXIF removal removes private PNG metadata without changing pixels or source', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'private.png');
  const output = path.join(dir, 'clean.png');
  const original = pngFixture();
  await writeFile(input, original);
  const result = await execute('abox_exif_remove', {
    input_path: input, output_path: output, keep_orientation: false, keep_icc: false,
  });
  const written = await readFile(output);
  const chunks = pngChunks(written);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.output_path, output);
  assert.equal(result.input_bytes, original.length);
  assert.equal(result.output_bytes, written.length);
  assert.equal(result.after.exif_present, false);
  assert.equal(result.after.icc_present, false);
  assert.equal(result.after.xmp_present, false);
  assert.deepEqual(chunks.map(item => item.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(chunks.find(item => item.type === 'IDAT').data, pngChunks(original).find(item => item.type === 'IDAT').data);
  assert.equal(digest(await readFile(input)), digest(original));
});

test('EXIF defaults preserve orientation and colour profile while removing camera and text metadata', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'private.png');
  const output = path.join(dir, 'preserved.png');
  const original = pngFixture();
  await writeFile(input, original);
  const result = await execute('abox_exif_remove', { input_path: input, output_path: output });
  const chunks = pngChunks(await readFile(output));
  const exif = chunks.find(item => item.type === 'eXIf');
  assert.ok(exif, 'orientation requires a minimal EXIF block');
  const entries = exifEntries(exif.data);
  assert.deepEqual([...entries.keys()], [0x0112]);
  assert.equal(entries.get(0x0112).inline, 6);
  assert.equal(result.after.icc_present, true);
  assert.deepEqual(chunks.find(item => item.type === 'iCCP').data, pngChunks(original).find(item => item.type === 'iCCP').data);
  assert.ok(!chunks.some(item => ['tEXt', 'zTXt', 'iTXt'].includes(item.type)));
  assert.equal(digest(await readFile(input)), digest(original));
});

test('local input paths and new output files are enforced', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'source.png');
  await writeFile(input, pngFixture());
  for (const invalid of ['relative.png', 'https://example.com/image.png', String.raw`\\server\share\image.png`, String.raw`C:\work\image.jpg:clean.jpg`, String.raw`C:\work\NUL.png`]) {
    await assert.rejects(execute('abox_exif_remove', {
      input_path: invalid, output_path: path.join(dir, 'unused.png'),
    }), hasCode('LOCAL_PATH_REQUIRED'));
  }
  const sentinel = Buffer.from('existing output must survive');
  const output = path.join(dir, 'existing.png');
  await writeFile(output, sentinel);
  await assert.rejects(execute('abox_exif_remove', { input_path: input, output_path: output }), hasCode('OUTPUT_EXISTS'));
  assert.deepEqual(await readFile(output), sentinel);
  const original = await readFile(input);
  await assert.rejects(execute('abox_exif_remove', { input_path: input, output_path: input }), hasCode('OUTPUT_EXISTS'));
  assert.deepEqual(await readFile(input), original);
});

test('oversized input is refused before processing', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'oversized.png');
  const file = await open(input, 'w');
  await file.truncate(INPUT_LIMIT + 1);
  await file.close();
  const output = path.join(dir, 'unused.png');
  await assert.rejects(execute('abox_exif_remove', { input_path: input, output_path: output }), hasCode('INPUT_SIZE'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF splitting writes independently readable pages and preserves the source', async t => {
  const dir = await workspace(t);
  const input = await pdfFixture(dir, 3);
  const originalHash = digest(await readFile(input));
  const outputDir = path.join(dir, 'pages');
  const result = await execute('abox_pdf_split', { input_path: input, output_dir: outputDir });
  assert.equal(result.input_pages, 3);
  await checkPdfOutputs(result, [[1], [2], [3]], outputDir);
  assert.equal(digest(await readFile(input)), originalHash);
});

test('PDF every and explicit ranges report the source pages of each part', async t => {
  const dir = await workspace(t);
  const input = await pdfFixture(dir, 5);
  const everyDir = path.join(dir, 'groups');
  await checkPdfOutputs(await execute('abox_pdf_split', {
    input_path: input, output_dir: everyDir, mode: 'every', pages_per_file: 2,
  }), [[1, 2], [3, 4], [5]], everyDir);
  const rangesDir = path.join(dir, 'ranges');
  await checkPdfOutputs(await execute('abox_pdf_split', {
    input_path: input, output_dir: rangesDir, mode: 'ranges', ranges: ['1-2', '4-5'],
  }), [[1, 2], [4, 5]], rangesDir);
});

test('PDF failures leave an existing directory and source intact', async t => {
  const dir = await workspace(t);
  const input = await pdfFixture(dir, 3);
  const originalHash = digest(await readFile(input));
  const existing = path.join(dir, 'existing');
  await mkdir(existing);
  const sentinel = path.join(existing, 'keep.txt');
  await writeFile(sentinel, 'keep');
  await assert.rejects(execute('abox_pdf_split', { input_path: input, output_dir: existing }), hasCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  const outputDir = path.join(dir, 'invalid-range');
  await assert.rejects(execute('abox_pdf_split', {
    input_path: input, output_dir: outputDir, mode: 'ranges', ranges: ['4-9'],
  }), hasCode('INVALID_PAGE_RANGE'));
  await assert.rejects(stat(outputDir), { code: 'ENOENT' });
  assert.equal(digest(await readFile(input)), originalHash);
});

test('large PDF splits keep the tool response small and save a complete local manifest', async t => {
  const dir = await workspace(t);
  const input = await pdfFixture(dir, 21);
  const outputDir = path.join(dir, 'many-pages');
  const result = await execute('abox_pdf_split', { input_path: input, output_dir: outputDir });
  assert.equal(result.output_count, 21);
  assert.equal(result.outputs.length, 20);
  assert.equal(result.outputs_truncated, true);
  const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8'));
  assert.equal(manifest.outputs.length, 21);
  assert.deepEqual(manifest.outputs.at(-1).pages, [21]);
  assert.equal((await PdfDocument.open(new Uint8Array(await readFile(manifest.outputs.at(-1).output_path)))).countPages(), 1);
});

test('schema validation refuses unknown keys and missing grouping arguments', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'source.pdf');
  const outputDir = path.join(dir, 'parts');
  for (const args of [
    { input_path: input, output_dir: outputDir, mode: 'every' },
    { input_path: input, output_dir: outputDir, mode: 'every', pages_per_file: 0 },
    { input_path: input, output_dir: outputDir, mode: 'ranges', ranges: [] },
    { input_path: input, output_dir: outputDir, unexpected: true },
  ]) {
    await assert.rejects(execute('abox_pdf_split', args), error => {
      assert.ok(error.name === 'ZodError' || error.code === 'INVALID_ARGUMENTS');
      return true;
    });
  }
});
