import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { convertImage } from '../src/image.mjs';
import { traceImageToSvg, stackImages, MAX_STACK_IMAGES, MAX_TRACE_EDGES } from '../src/image-vector-stack.mjs';

const browser = await findBrowser();
const browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-image-vector-stack-')));
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

function png(width, height, pixel, { animated = false, declaredWidth = width, declaredHeight = height } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(declaredWidth); header.writeUInt32BE(declaredHeight, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(typeof pixel === 'function' ? pixel(x, y) : pixel, y * (1 + width * 4) + 1 + x * 4);
  }
  const actl = Buffer.alloc(8); actl.writeUInt32BE(1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', actl)] : []), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function samples(filename, mime, points) {
  const bytes = await readFile(filename);
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'output', mimeType: mime, buffer: bytes });
    return page.evaluate(async points => {
      const file = document.querySelector('#input').files[0];
      const url = URL.createObjectURL(file), image = new Image();
      try {
        image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height,
          pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
      } finally { URL.revokeObjectURL(url); }
    }, points);
  });
}

async function frames(directory, values, size = [13, 11]) {
  const paths = [];
  for (const [index, value] of values.entries()) {
    const filename = path.join(directory, `frame-${index}.png`);
    await writeFile(filename, png(...size, value)); paths.push(filename);
  }
  return paths;
}

function near(actual, expected, tolerance = 0) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `Channel ${index}: expected ${expected[index]}, received ${value}`));
}

test('shape tracing preserves a rectangle, its hole, fill and source bytes', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'drawing.png'), output = path.join(directory, 'drawing.svg');
  const original = png(32, 24, (x, y) => {
    const ink = (x >= 4 && x < 28 && y >= 4 && y < 20 && !(x >= 12 && x < 20 && y >= 8 && y < 16)) || (x === 1 && y === 1);
    return ink ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  await writeFile(input, original);
  const result = await traceImageToSvg({ input_path: input, output_path: output, fill: '#123456' });
  assert.equal(result.operation, 'image-trace'); assert.equal(result.verified, true); assert.equal(result.contours, 2);
  assert.equal(result.width, 32); assert.equal(result.height, 24); assert.equal(result.verification.path_pixel_checks, 768);
  assert.equal(result.verification.passive_single_path, true);
  assert.equal(result.threshold, 'otsu'); assert.equal(result.threshold_used, 0);
  const svg = await readFile(output, 'utf8');
  assert.equal((svg.match(/<path /g) ?? []).length, 1);
  assert.ok(!/<(?:image|script|foreignObject)|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(svg));
  const decoded = await samples(output, 'image/svg+xml', [[0, 0], [7, 6], [16, 12], [25, 18], [1, 1]]);
  near(decoded.pixels[0], [0, 0, 0, 0]); near(decoded.pixels[1], [18, 52, 86, 255]);
  near(decoded.pixels[2], [0, 0, 0, 0]); near(decoded.pixels[3], [18, 52, 86, 255]); near(decoded.pixels[4], [0, 0, 0, 0]);
  assert.equal(hash(await readFile(input)), hash(original));
  await assert.rejects(traceImageToSvg({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
});

test('manual threshold, invert, detail and minimum area use the source trace controls', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'gray.png'), output = path.join(directory, 'inverse.svg');
  await writeFile(input, png(24, 24, (x, y) => x >= 6 && x < 18 && y >= 6 && y < 18 ? [220, 220, 220, 255] : [20, 20, 20, 255]));
  const result = await traceImageToSvg({ input_path: input, output_path: output, threshold: 100, invert: true,
    detail: 0.5, corner_angle: 65, min_area: 1 });
  assert.equal(result.contours, 1); assert.equal(result.threshold_used, 100); assert.equal(result.invert, true);
  const decoded = await samples(output, 'image/svg+xml', [[0, 0], [12, 12], [23, 23]]);
  near(decoded.pixels[0], [0, 0, 0, 0]); near(decoded.pixels[1], [0, 0, 0, 255]); near(decoded.pixels[2], [0, 0, 0, 0]);
});

test('tracing refuses empty and noisy inputs before writing a download', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), output = path.join(directory, 'refused.svg');
  await writeFile(input, png(16, 16, [255, 255, 255, 255]));
  await assert.rejects(traceImageToSvg({ input_path: input, output_path: output }), { code: 'EMPTY_TRACE' });
  assert.ok(256 * 256 * 2 > MAX_TRACE_EDGES);
  await writeFile(input, png(256, 256, (x, y) => (x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  await assert.rejects(traceImageToSvg({ input_path: input, output_path: output }), { code: 'TRACE_COMPLEXITY' });
  await writeFile(input, png(160, 160, (x, y) => x % 4 < 2 && y % 4 < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  await assert.rejects(traceImageToSvg({ input_path: input, output_path: output }), { code: 'TRACE_COMPLEXITY' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('every stack method matches fixed RGB answers including even medians and sigma rejection', browserOptions, async t => {
  const directory = await workspace(t);
  const input_paths = await frames(directory, [[10, 11, 12, 255], [20, 21, 22, 255], [200, 201, 202, 255]]);
  const originals = await Promise.all(input_paths.map(filename => readFile(filename)));
  for (const [method, extra, expected] of [
    ['average', {}, [77, 78, 79, 255]], ['median', {}, [20, 21, 22, 255]],
    ['sigma', { kappa: 0.5 }, [77, 78, 79, 255]],
    ['sigma', { kappa: 1 }, [77, 78, 79, 255]], ['lighten', {}, [200, 201, 202, 255]],
    ['darken', {}, [10, 11, 12, 255]], ['add', { gain: 0.5 }, [115, 116, 118, 255]],
  ]) {
    const output = path.join(directory, `${method}-${extra.kappa ?? ''}.png`);
    const result = await stackImages({ input_paths, output_path: output, method, ...extra });
    assert.equal(result.operation, 'image-stack'); assert.equal(result.verified, true); assert.equal(result.alignment, 'none');
    assert.equal(result.width, 13); assert.equal(result.height, 11); assert.equal(result.image_count, 3);
    assert.equal(result.passes, method === 'sigma' ? 2 : 1); assert.equal(result.verification.accumulator_samples, 49);
    assert.equal(result.verification.png_pixel_checks, 143);
    const decoded = await samples(output, 'image/png', [[0, 0], [6, 5], [12, 10]]);
    for (const pixel of decoded.pixels) near(pixel, expected);
  }
  const even = path.join(directory, 'even.png');
  await stackImages({ input_paths: input_paths.slice(0, 2), output_path: even, method: 'median' });
  near((await samples(even, 'image/png', [[6, 5]])).pixels[0], [15, 16, 17, 255]);
  for (const [index, filename] of input_paths.entries()) assert.equal(hash(await readFile(filename)), hash(originals[index]));
  await assert.rejects(stackImages({ input_paths, output_path: even }), { code: 'OUTPUT_EXISTS' });
  const sigma_paths = await frames(directory, [[10, 11, 12, 255], [20, 21, 22, 255], [60, 61, 62, 255]]);
  for (const [kappa, expected] of [[1, [15, 16, 17, 255]], [0.5, [20, 21, 22, 255]]]) {
    const output = path.join(directory, `sigma-reject-${kappa}.png`);
    await stackImages({ input_paths: sigma_paths, output_path: output, method: 'sigma', kappa });
    near((await samples(output, 'image/png', [[6, 5]])).pixels[0], expected);
  }
});

test('stack arithmetic preserves positions and clips additive channel values', browserOptions, async t => {
  const directory = await workspace(t);
  const input_paths = await frames(directory, [
    (x, y) => [x < 6 ? 255 : 0, y < 5 ? 20 : 0, 0, 255],
    (x, y) => [x >= 6 ? 255 : 0, 0, y >= 5 ? 80 : 0, 255],
  ]);
  const output = path.join(directory, 'average.png');
  await stackImages({ input_paths, output_path: output });
  const decoded = await samples(output, 'image/png', [[1, 1], [11, 1], [1, 9], [11, 9]]);
  near(decoded.pixels[0], [128, 10, 0, 255]); near(decoded.pixels[1], [128, 10, 0, 255]);
  near(decoded.pixels[2], [128, 0, 40, 255]); near(decoded.pixels[3], [128, 0, 40, 255]);
  const add = path.join(directory, 'add.png');
  await stackImages({ input_paths, output_path: add, method: 'add', gain: 16 });
  near((await samples(add, 'image/png', [[1, 1], [11, 9]])).pixels[0], [255, 255, 0, 255]);
});

test('JPEG/WebP inputs and JPEG output use local native codecs', browserOptions, async t => {
  const directory = await workspace(t), [original] = await frames(directory, [[40, 80, 120, 255]], [24, 20]);
  const jpeg = path.join(directory, 'frame.jpg'), webp = path.join(directory, 'frame.webp'), output = path.join(directory, 'stack.jpg');
  await convertImage({ input_path: original, output_path: jpeg, format: 'jpeg', quality: 1 });
  await convertImage({ input_path: original, output_path: webp, format: 'webp', quality: 1 });
  const result = await stackImages({ input_paths: [jpeg, webp], output_path: output, format: 'jpeg', quality: 1 });
  assert.equal(result.verification.png_pixel_checks, 0); assert.equal(result.verification.opaque, true);
  near((await samples(output, 'image/jpeg', [[12, 10]])).pixels[0], [40, 80, 120, 255], 4);
  const trace = path.join(directory, 'source.svg');
  await traceImageToSvg({ input_path: webp, output_path: trace, threshold: 255 });
  near((await samples(trace, 'image/svg+xml', [[12, 10]])).pixels[0], [0, 0, 0, 255]);
});

test('stacks refuse different decoded sizes and transparency without an output', browserOptions, async t => {
  const directory = await workspace(t), input_paths = await frames(directory, [[1, 2, 3, 255], [4, 5, 6, 128]]);
  const output = path.join(directory, 'refused.png');
  await assert.rejects(stackImages({ input_paths, output_path: output }), { code: 'STACK_TRANSPARENCY' });
  await writeFile(input_paths[1], png(14, 11, [4, 5, 6, 255]));
  await assert.rejects(stackImages({ input_paths, output_path: output }), { code: 'STACK_DIMENSIONS' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('cancelling an active trace or stack leaves new output absent', browserOptions, async t => {
  const directory = await workspace(t), input_paths = await frames(directory, [[0, 0, 0, 255], [255, 255, 255, 255]]);
  for (const [operation, args] of [
    [traceImageToSvg, { input_path: input_paths[0], output_path: path.join(directory, 'cancelled.svg') }],
    [stackImages, { input_paths, output_path: path.join(directory, 'cancelled.png') }],
  ]) {
    const controller = new AbortController();
    const pending = operation(args, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 25);
    try { await assert.rejects(pending, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    await assert.rejects(readFile(args.output_path), { code: 'ENOENT' });
  }
});
