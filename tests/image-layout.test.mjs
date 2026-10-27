import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { layoutImages, MAX_LAYOUT_IMAGES } from '../src/image-layout.mjs';
import { convertImage } from '../src/image.mjs';

const browser = await findBrowser();
const browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-image-layout-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}

function png(width, height, rgba, { animated = false, declaredWidth = width, declaredHeight = height } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(declaredWidth); header.writeUInt32BE(declaredHeight, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set(rgba, y * (1 + width * 4) + 1 + x * 4);
  }
  const actl = Buffer.alloc(8); actl.writeUInt32BE(1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', actl)] : []), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixtures(directory) {
  const red = path.join(directory, 'red.png'), green = path.join(directory, 'green.png'), blue = path.join(directory, 'blue.png');
  await writeFile(red, png(20, 10, [255, 0, 0, 255]));
  await writeFile(green, png(10, 20, [0, 255, 0, 255]));
  await writeFile(blue, png(20, 20, [0, 0, 255, 128]));
  return { red, green, blue };
}

async function samples(filename, mime, points) {
  const bytes = await readFile(filename);
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'output', mimeType: mime, buffer: bytes });
    return page.evaluate(async points => {
      const image = await createImageBitmap(document.querySelector('#input').files[0]);
      try {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height,
          pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
      } finally { image.close(); }
    }, points);
  });
}

function near(actual, expected, tolerance = 1) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `Channel ${index}: expected ${expected[index]}, received ${value}`));
}

test('original-ratio horizontal and vertical strips preserve order, spacing and source bytes', browserOptions, async t => {
  const directory = await workspace(t), source = await fixtures(directory);
  const originals = await Promise.all([source.red, source.green].map(filename => readFile(filename)));
  const horizontal = path.join(directory, 'horizontal.png');
  const result = await layoutImages({ input_paths: [source.red, source.green], output_path: horizontal,
    layout: 'horizontal', width: 68, gap: 4, padding: 2 });
  assert.equal(result.verified, true); assert.equal(result.image_count, 2);
  assert.equal(result.width, 68); assert.equal(result.height, 28); assert.equal(result.ratio, 'original');
  assert.equal(result.columns, 2); assert.equal(result.rows, 1);
  assert.equal(result.verification.png_pixel_samples, 49);
  const decoded = await samples(horizontal, 'image/png', [[0, 0], [10, 8], [51, 10], [60, 8]]);
  assert.equal(decoded.width, 68); assert.equal(decoded.height, 28);
  near(decoded.pixels[0], [0, 0, 0, 0]); near(decoded.pixels[1], [255, 0, 0, 255]);
  near(decoded.pixels[2], [0, 0, 0, 0]); near(decoded.pixels[3], [0, 255, 0, 255]);
  const reversed = path.join(directory, 'reversed.png');
  await layoutImages({ input_paths: [source.green, source.red], output_path: reversed, layout: 'horizontal', width: 68, gap: 4, padding: 2 });
  const reversePixels = (await samples(reversed, 'image/png', [[8, 8], [30, 8]])).pixels;
  near(reversePixels[0], [0, 255, 0, 255]); near(reversePixels[1], [255, 0, 0, 255]);
  const vertical = path.join(directory, 'vertical.png');
  const verticalResult = await layoutImages({ input_paths: [source.red, source.green], output_path: vertical,
    layout: 'vertical', width: 24, gap: 4, padding: 2 });
  assert.equal(verticalResult.width, 24); assert.equal(verticalResult.height, 58);
  assert.equal(verticalResult.columns, 1); assert.equal(verticalResult.rows, 2);
  const verticalPixels = (await samples(vertical, 'image/png', [[10, 6], [10, 14], [10, 40]])).pixels;
  near(verticalPixels[0], [255, 0, 0, 255]); near(verticalPixels[1], [0, 0, 0, 0]); near(verticalPixels[2], [0, 255, 0, 255]);
  for (const [index, input] of [source.red, source.green].entries()) assert.equal(hash(await readFile(input)), hash(originals[index]));
  await assert.rejects(layoutImages({ input_paths: [source.red, source.green], output_path: horizontal }), { code: 'OUTPUT_EXISTS' });
});

test('grid contain/cover, empty cells and alpha use unchanged layout clipping', browserOptions, async t => {
  const directory = await workspace(t), source = await fixtures(directory);
  for (const fit of ['contain', 'cover']) {
    const output = path.join(directory, `${fit}.png`);
    const result = await layoutImages({ input_paths: [source.red, source.green, source.blue], output_path: output,
      width: 50, columns: 2, gap: 2, padding: 2, fit });
    assert.equal(result.width, 50); assert.equal(result.height, 50); assert.equal(result.columns, 2); assert.equal(result.rows, 2);
    const pixels = (await samples(output, 'image/png', [[13, 13], [13, 3], [37, 13], [13, 37], [37, 37], [24, 13], [0, 0]])).pixels;
    near(pixels[0], [255, 0, 0, 255]); near(pixels[1], fit === 'contain' ? [0, 0, 0, 0] : [255, 0, 0, 255]);
    near(pixels[2], [0, 255, 0, 255]); near(pixels[3], [0, 0, 255, 128]);
    for (const index of [4, 5, 6]) near(pixels[index], [0, 0, 0, 0]);
  }
  const output = path.join(directory, 'background.png');
  await layoutImages({ input_paths: [source.blue, source.red], output_path: output,
    width: 50, columns: 2, gap: 2, padding: 2, background: '#112233' });
  const pixels = (await samples(output, 'image/png', [[0, 0], [13, 13]])).pixels;
  near(pixels[0], [17, 34, 51, 255]); near(pixels[1], [8, 17, 153, 255]);
});

test('JPEG matte, WebP alpha and JPEG/WebP inputs produce independently decoded pixels', browserOptions, async t => {
  const directory = await workspace(t), source = await fixtures(directory);
  for (const format of ['jpeg', 'webp']) {
    const output = path.join(directory, `output.${format === 'jpeg' ? 'jpg' : 'webp'}`);
    const result = await layoutImages({ input_paths: [source.blue, source.red], output_path: output,
      width: 50, columns: 2, gap: 2, padding: 2, format, quality: 1 });
    assert.equal(result.format, format); assert.equal(result.width, 50); assert.equal(result.height, 26);
    const pixels = (await samples(output, `image/${format}`, [[0, 0], [13, 13], [37, 13]])).pixels;
    near(pixels[0], format === 'jpeg' ? [255, 255, 255, 255] : [0, 0, 0, 0], 5);
    near(pixels[1], format === 'jpeg' ? [127, 127, 255, 255] : [0, 0, 255, 128], 5);
    near(pixels[2], [255, 0, 0, 255], 5);
  }
  const jpeg = path.join(directory, 'source.jpg'), webp = path.join(directory, 'source.webp');
  await convertImage({ input_path: source.red, output_path: jpeg, format: 'jpeg', quality: 1 });
  await convertImage({ input_path: source.green, output_path: webp, format: 'webp', quality: 1 });
  const originalHashes = await Promise.all([jpeg, webp].map(async filename => hash(await readFile(filename))));
  const output = path.join(directory, 'mixed-sources.png');
  await layoutImages({ input_paths: [jpeg, webp], output_path: output, width: 50, columns: 2, gap: 2, padding: 2 });
  const pixels = (await samples(output, 'image/png', [[13, 13], [37, 13]])).pixels;
  near(pixels[0], [255, 0, 0, 255], 5); near(pixels[1], [0, 255, 0, 255], 5);
  for (const [index, filename] of [jpeg, webp].entries()) assert.equal(hash(await readFile(filename)), originalHashes[index]);
});

test('the upstream side/area/space limits refuse a layout before allocating its canvas', browserOptions, async t => {
  const directory = await workspace(t), source = await fixtures(directory);
  for (const [name, settings, code] of [
    ['height', { layout: 'vertical', width: 8192, padding: 0, gap: 0 }, 'IMAGE_DIMENSIONS'],
    ['area', { width: 8192, columns: 2, ratio: 'square', padding: 0, gap: 0 }, 'IMAGE_DIMENSIONS'],
    ['spacing', { width: 10, columns: 2, padding: 2, gap: 8 }, 'LAYOUT_SPACE'],
  ]) {
    const output = path.join(directory, `${name}.png`);
    await assert.rejects(layoutImages({ input_paths: [source.red, source.green], output_path: output, ...settings }), { code });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('layout validates counts, local paths, aggregate bytes, stillness and predecode dimensions', async t => {
  const directory = await workspace(t), source = await fixtures(directory);
  const defaults = { input_paths: [source.red, source.green], output_path: path.join(directory, 'invalid.png') };
  for (const input_paths of [[], [source.red], Array(MAX_LAYOUT_IMAGES + 1).fill(source.red)]) {
    await assert.rejects(layoutImages({ ...defaults, input_paths }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const settings of [{ columns: 0 }, { ratio: 'original' }, { gap: -1 }, { quality: 2 }, { background: 'url(file:///private)' }]) {
    await assert.rejects(layoutImages({ ...defaults, ...settings }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(layoutImages({ ...defaults, width: 8193 }), { code: 'IMAGE_DIMENSIONS' });
  await assert.rejects(layoutImages({ ...defaults, input_paths: ['https://example.invalid/image.png', source.red] }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(layoutImages({ ...defaults, output_path: path.join(directory, 'wrong.webp') }), { code: 'OUTPUT_EXTENSION' });
  const animation = path.join(directory, 'animation.png'); await writeFile(animation, png(1, 1, [255, 0, 0, 255], { animated: true }));
  await assert.rejects(layoutImages({ ...defaults, input_paths: [animation, source.red] }), { code: 'ANIMATED_IMAGE' });
  const oversized = path.join(directory, 'oversized.png');
  await writeFile(oversized, png(1, 1, [255, 0, 0, 255], { declaredWidth: 10000, declaredHeight: 10000 }));
  await assert.rejects(layoutImages({ ...defaults, input_paths: [oversized, source.red] }), { code: 'IMAGE_DIMENSIONS' });
  const large = [];
  for (const name of ['a', 'b']) {
    const filename = path.join(directory, `large-${name}`), file = await open(filename, 'w');
    await file.truncate(65 * 1024 * 1024); await file.close(); large.push(filename);
  }
  await assert.rejects(layoutImages({ ...defaults, input_paths: large }), { code: 'INPUT_SIZE' });
  await assert.rejects(readFile(defaults.output_path), { code: 'ENOENT' });
  await assert.rejects(layoutImages(defaults, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('cancelling an active layout leaves the new output absent', browserOptions, async t => {
  const directory = await workspace(t), source = await fixtures(directory), controller = new AbortController();
  const output = path.join(directory, 'cancelled.png');
  const pending = layoutImages({ input_paths: [source.red, source.green], output_path: output }, { signal: controller.signal });
  assert.equal(controller.signal.aborted, false);
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
