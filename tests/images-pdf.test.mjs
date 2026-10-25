import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { imagesToPdf, MAX_IMAGE_PDF_PAGES } from '../src/images-pdf.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';
import { withBrowser } from '../src/browser.mjs';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { readBytes, serialize } from '../vendor/abox/tools/exif-editor/src/container.js';
import { createEntry, serializeExif } from '../vendor/abox/tools/exif-editor/src/tiff.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-images-pdf-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

function solidPng(width, height, rgba, animated = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let channel = 0; channel < 4; channel++) pixels[y * (width * 4 + 1) + x * 4 + 1 + channel] = rgba[channel];
  }
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', animation)] : []),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function inspect(filename) {
  const doc = await PdfDocument.open(new Uint8Array(await readFile(filename)));
  const source = readSource(doc, path.basename(filename));
  const images = source.pages.map(page => {
    const resources = doc.get(page.dict, 'Resources');
    const objects = doc.get(resources, 'XObject');
    return doc.resolve(objects.get('Im0'));
  });
  return { doc, pages: source.pages, images };
}

test('images to PDF preserves input order, page dimensions, lossless pixels, transparency, and source bytes', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const first = path.join(directory, 'wide.png');
  const second = path.join(directory, 'tall.png');
  const original = [solidPng(40, 20, [255, 0, 0, 255]), solidPng(20, 40, [0, 0, 255, 128])];
  await Promise.all([first, second].map((filename, index) => writeFile(filename, original[index])));
  const output = path.join(directory, 'pictures.pdf');
  const result = await imagesToPdf({ input_paths: [first, second], output_path: output,
    page_size: 'fit', dpi: 72, image_mode: 'lossless' });
  const actual = await inspect(output);
  assert.equal(result.operation, 'images-to-pdf');
  assert.equal(result.verified, true);
  assert.equal(result.dimensions_verified, true);
  assert.equal(result.page_count, 2);
  assert.equal(result.copied_jpegs, 0);
  assert.deepEqual(result.pages.map(page => page.input_path), [first, second]);
  assert.deepEqual(actual.pages.map(page => page.box), [[0, 0, 40, 20], [0, 0, 20, 40]]);
  assert.deepEqual(actual.images.map(image => [actual.doc.get(image.dict, 'Width'), actual.doc.get(image.dict, 'Height')]), [[40, 20], [20, 40]]);
  for (const [index, image] of actual.images.entries()) {
    const pixels = await decodeStream(image, value => actual.doc.resolve(value));
    assert.deepEqual([...pixels.bytes.subarray(0, 3)], index ? [0, 0, 255] : [255, 0, 0]);
  }
  assert.equal(actual.images[0].dict.has('SMask'), false);
  const mask = actual.doc.get(actual.images[1].dict, 'SMask');
  assert.ok(mask);
  assert.equal((await decodeStream(mask, value => actual.doc.resolve(value))).bytes[0], 128);
  assert.equal(result.output_bytes, (await stat(output)).size);
  assert.deepEqual(await Promise.all([first, second].map(async filename => hash(await readFile(filename)))), original.map(hash));
});

test('fixed paper settings and optional image downscaling use the website layout engine', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'wide.png');
  await writeFile(input, solidPng(40, 20, [0, 255, 0, 255]));
  const output = path.join(directory, 'paper.pdf');
  const result = await imagesToPdf({ input_paths: [input], output_path: output,
    page_size: 'a4', orientation: 'landscape', margin_mm: 10, fit: 'contain', image_mode: 'jpeg', max_side: 20 });
  const actual = await inspect(output);
  assert.equal(result.page_count, 1);
  assert.ok(Math.abs(actual.pages[0].box[2] - 297 * 72 / 25.4) < 0.01);
  assert.ok(Math.abs(actual.pages[0].box[3] - 210 * 72 / 25.4) < 0.01);
  assert.equal(actual.doc.get(actual.images[0].dict, 'Width'), 20);
  assert.equal(actual.doc.get(actual.images[0].dict, 'Height'), 10);
});

test('copied JPEGs retain exact source bytes and apply EXIF orientation to PDF page geometry', { timeout: 180000 }, async t => {
  const directory = await workspace(t);
  const jpeg = await withBrowser(async page => page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    canvas.getContext('2d').fillRect(0, 0, 40, 20);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }));
  const item = await readBytes(new Uint8Array(Buffer.from(jpeg, 'base64')));
  const exif = serializeExif({ littleEndian: true, groups: {
    ifd0: [createEntry(0x0112, 3, '6', true), createEntry(0x0110, 2, 'Private camera', true)],
    exif: [], gps: [], interop: [], ifd1: [],
  }, thumbnail: null });
  const bytes = serialize(item, { exif });
  const input = path.join(directory, 'oriented.jpg');
  await writeFile(input, bytes);
  const output = path.join(directory, 'jpeg.pdf');
  const result = await imagesToPdf({ input_paths: [input], output_path: output, page_size: 'fit', dpi: 72 });
  const actual = await inspect(output);
  assert.equal(result.copied_jpegs, 1);
  assert.deepEqual(actual.pages[0].box, [0, 0, 20, 40]);
  assert.deepEqual(Buffer.from(actual.images[0].raw), Buffer.from(bytes));
  assert.ok(result.warnings.some(warning => warning.includes('embedded metadata')));
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('images to PDF validates batch limits, formats, animations, and new local outputs before browser work', async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'source.png');
  await writeFile(input, solidPng(2, 2, [255, 255, 255, 255]));
  const output = path.join(directory, 'unused.pdf');
  for (const input_paths of [[], Array(MAX_IMAGE_PDF_PAGES + 1).fill(input)]) {
    await assert.rejects(imagesToPdf({ input_paths, output_path: output }), hasCode('PDF_INPUT_LIMIT'));
  }
  await assert.rejects(imagesToPdf({ input_paths: ['https://example.com/source.png'], output_path: output }), hasCode('LOCAL_PATH_REQUIRED'));
  await assert.rejects(imagesToPdf({ input_paths: [input], output_path: input }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(imagesToPdf({ input_paths: [input], output_path: output, quality: 0.1 }), hasCode('INVALID_ARGUMENTS'));
  const animated = path.join(directory, 'animation.png');
  await writeFile(animated, solidPng(2, 2, [0, 0, 0, 255], true));
  await assert.rejects(imagesToPdf({ input_paths: [animated], output_path: output }), hasCode('ANIMATED_IMAGE'));
  const invalid = path.join(directory, 'invalid.png');
  await writeFile(invalid, 'Not an image.');
  await assert.rejects(imagesToPdf({ input_paths: [invalid], output_path: output }), hasCode('UNSUPPORTED_IMAGE'));
  const large = path.join(directory, 'large.png');
  const file = await open(large, 'w');
  try { await file.truncate(Math.floor(MAX_INPUT_BYTES / 2) + 1); }
  finally { await file.close(); }
  await assert.rejects(imagesToPdf({ input_paths: [large, large], output_path: output }), hasCode('PDF_TOTAL_SIZE'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
