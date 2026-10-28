import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { redactPdf, MAX_PDF_REDACT_CONFIG_BYTES, MAX_PDF_REDACT_INPUT_BYTES } from '../src/pdf-raster-redact.mjs';
import { redactionFixture, redactionRegions } from './fixtures/pdf-raster-redaction.mjs';

async function workspace(t) { const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-redact-'))); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function setup(directory, bytes, regions = redactionRegions()) {
  const input = path.join(directory, 'source.pdf'), config = path.join(directory, 'regions.json'); await writeFile(input, bytes);
  await writeFile(config, typeof regions === 'string' || Buffer.isBuffer(regions) ? regions : JSON.stringify(regions));
  return { input_path: input, output_path: path.join(directory, 'redacted.pdf'), regions_path: config };
}

test('PDF raster redaction validates private local coordinates and rejects malformed/ambiguous configuration before rendering', async t => {
  const directory = await workspace(t), bytes = await redactionFixture();
  const bad = [null, {}, { pages: [] }, { pages: [{ page: 2, width_pt: 100, height_pt: 80, regions: [] }] },
    { pages: [{ page: 1, width_pt: 100, height_pt: 80, regions: [] }] },
    { pages: [{ page: 1, width_pt: 100, height_pt: 80, regions: [{ x: -1, y: 1, width: 1, height: 1 }] }] },
    { pages: [{ page: 1, width_pt: 100, height_pt: 80, regions: [{ x: 99, y: 1, width: 2, height: 1 }] }] },
    { pages: [{ page: 1, width_pt: 100, height_pt: 80, regions: Array(257).fill({ x: 1, y: 1, width: 1, height: 1 }) }] },
    '{"pages":[],"pages":[]}', '{"PRIVATE":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}', Buffer.from([255])];
  for (const regions of bad) {
    const args = await setup(directory, bytes, regions);
    await assert.rejects(redactPdf(args), error => { assert.equal(error.code, 'PDF_REDACT_CONFIG'); assert.ok(!error.message.includes('PRIVATE')); return true; });
    await assert.rejects(readFile(args.output_path), { code: 'ENOENT' });
  }
});

test('PDF raster admission refuses unsupported image codecs, actual JPEG geometry, inline images, XFA and decoded expansion', async t => {
  const directory = await workspace(t), cases = [
    [await redactionFixture({ imageFilter: 'JPXDecode' }), 'PDF_REDACT_UNSUPPORTED'],
    [await redactionFixture({ inline: true }), 'PDF_REDACT_UNSUPPORTED'],
    [await redactionFixture({ xfa: true }), 'PDF_REDACT_UNSUPPORTED'],
    [await redactionFixture({ functionSize: 1000000 }), 'PDF_REDACT_LIMIT'],
    [await redactionFixture({ functionSize: 1000000, indirectFunctionType: true }), 'PDF_REDACT_LIMIT'],
    [await redactionFixture({ pages: 33 }), 'PDF_REDACT_LIMIT'],
    [await redactionFixture({ imageRaw: deflateSync(Buffer.alloc(33 * 2 ** 20)) }), 'PDF_REDACT_LIMIT'],
    [await redactionFixture({ imageRaw: deflateSync(Buffer.alloc(3)) }), 'PDF_REDACT_INPUT'],
  ];
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0x7f, 0xff, 0x7f, 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 255, 218, 0, 2, 255, 217]);
  cases.push([await redactionFixture({ imageFilter: 'DCTDecode', imageRaw: jpeg }), 'PDF_REDACT_UNSUPPORTED']);
  for (const [bytes, code] of cases) {
    const args = await setup(directory, bytes); await assert.rejects(redactPdf(args), { code });
    await assert.rejects(readFile(args.output_path), { code: 'ENOENT' }); assert.deepEqual(await readFile(args.input_path), bytes);
  }
});

test('drawing admission refuses discarded operators, bad operands, unbalanced states and missing scoped resources before rendering', async t => {
  const directory = await workspace(t);
  for (const extraOperators of ['PRIVATE_UNSUPPORTED_OPERATOR\n', '/PRIVATE_MISSING_IMAGE Do\n', 'BT /PRIVATE_MISSING_FONT 5 Tf (PRIVATE TEXT) Tj ET\n',
    '1 cm\n', '[1 2] w\n', 'Q\n', 'BT\n', '1 2\n', '/PRIVATE_MISSING_STATE gs\n']) {
    const bytes = await redactionFixture({ pages: 1, extraOperators }), args = await setup(directory, bytes, redactionRegions(1));
    await assert.rejects(redactPdf(args), error => { assert.equal(error.code, 'PDF_REDACT_RENDER'); assert.ok(!error.message.includes('PRIVATE')); return true; });
    await assert.rejects(readFile(args.output_path), { code: 'ENOENT' }); assert.deepEqual(await readFile(args.input_path), bytes);
  }
});

test('PDF redaction output/file limits and cancellation never overwrite a file or expose document contents', async t => {
  const directory = await workspace(t), bytes = await redactionFixture(), args = await setup(directory, bytes);
  for (const dpi of [null, 0, 71, 301, 144.5, '144']) await assert.rejects(redactPdf({ ...args, dpi }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(redactPdf({ ...args, output_path: path.join(directory, 'wrong.png') }), { code: 'OUTPUT_EXTENSION' });
  await writeFile(args.output_path, 'existing'); await assert.rejects(redactPdf(args), { code: 'OUTPUT_EXISTS' }); assert.equal(await readFile(args.output_path, 'utf8'), 'existing');
  const output = path.join(directory, 'new.pdf');
  for (const [field, size, name] of [['input_path', MAX_PDF_REDACT_INPUT_BYTES, 'large.pdf'], ['regions_path', MAX_PDF_REDACT_CONFIG_BYTES, 'large.json']]) {
    const filename = path.join(directory, name), file = await open(filename, 'w'); await file.truncate(size + 1); await file.close();
    await assert.rejects(redactPdf({ ...args, output_path: output, [field]: filename }), { code: 'INPUT_SIZE' });
  }
  await assert.rejects(redactPdf({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), pending = redactPdf({ ...args, output_path: output }, { signal: controller.signal }), timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.deepEqual(await readFile(args.input_path), bytes);
});
