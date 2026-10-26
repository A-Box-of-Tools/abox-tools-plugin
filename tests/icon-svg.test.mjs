import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { imageToIco } from '../src/icon.mjs';
import { svgToImage } from '../src/svg.mjs';
import { convertImage } from '../src/image.mjs';

const browser = await findBrowser();
const browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-icon-svg-')));
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

function pngFixture({ animated = false } = {}) {
  const width = 64, height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const data = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 4) + 1 + x * 4;
      const rgba = x >= 32 ? [0, 0, 255, 128] : y < 16 ? [255, 0, 0, 255] : [0, 255, 0, 255];
      data.set(rgba, at);
    }
  }
  const actl = Buffer.alloc(8); actl.writeUInt32BE(1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', actl)] : []), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}

const svgFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">'
  + '<rect width="32" height="16" fill="#ff0000"/><rect y="16" width="32" height="16" fill="#00ff00"/>'
  + '<rect x="32" width="32" height="32" fill="#0000ff" fill-opacity="0.5"/></svg>';

function near(actual, expected, tolerance = 1) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `Channel ${index}: expected ${expected[index]}, received ${value}`));
}

async function decodedSamples(bytes, mime, points) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'result', mimeType: mime, buffer: bytes });
    return page.evaluate(async points => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
      try {
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height,
          pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
      } finally { bitmap.close(); }
    }, points);
  });
}

function icoFrames(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  let next = 6 + count * 16;
  const frames = Array.from({ length: count }, (_, index) => {
    const at = 6 + index * 16;
    const size = bytes[at] || 256;
    assert.equal(bytes[at + 1] || 256, size); assert.equal(bytes[at + 2], 0); assert.equal(bytes[at + 3], 0);
    assert.equal(bytes.readUInt16LE(at + 4), 1); assert.equal(bytes.readUInt16LE(at + 6), 32);
    const length = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    assert.equal(offset, next); assert.ok(offset + length <= bytes.length); next += length;
    const data = bytes.subarray(offset, offset + length);
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (png) {
      assert.equal(data.toString('ascii', 12, 16), 'IHDR');
      assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
    } else {
      assert.equal(data.readUInt32LE(0), 40); assert.equal(data.readInt32LE(4), size); assert.equal(data.readInt32LE(8), size * 2);
      assert.equal(data.readUInt16LE(12), 1); assert.equal(data.readUInt16LE(14), 32); assert.equal(data.readUInt32LE(16), 0);
      assert.equal(data.length, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    }
    return { size, png, data };
  });
  assert.equal(next, bytes.length);
  return frames;
}

function dibPixel(frame, x, y) {
  const { size, data } = frame;
  const at = 40 + ((size - 1 - y) * size + x) * 4;
  const rgba = [data[at + 2], data[at + 1], data[at], data[at + 3]];
  const mask = data[40 + size * size * 4 + (size - 1 - y) * Math.ceil(size / 32) * 4 + (x >> 3)] & (0x80 >> (x & 7));
  assert.equal(Boolean(mask), rgba[3] < 128);
  return rgba;
}

test('multi-size ICO contains independently decodable PNG and bottom-up DIB pixels with alpha', browserOptions, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'raster-with-svg-suffix.svg'), output = path.join(directory, 'application.ico');
  const original = pngFixture(); await writeFile(input, original);
  const result = await imageToIco({ input_path: input, output_path: output, sizes: [256, 16, 128, 32] });
  assert.equal(result.verified, true); assert.equal(result.format, 'ico');
  assert.deepEqual(result.sizes, [16, 32, 128, 256]); assert.equal(result.input_width, 64); assert.equal(result.input_height, 32);
  const bytes = await readFile(output), frames = icoFrames(bytes);
  assert.deepEqual(frames.map(frame => frame.size), result.sizes);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['bmp', 'bmp', 'png', 'png']);
  for (const frame of frames) {
    const n = frame.size;
    const points = [[Math.floor(n / 4), 0], [Math.floor(n / 4), Math.floor(n * 0.35)],
      [Math.floor(n / 4), Math.floor(n * 0.65)], [Math.floor(n * 0.75), Math.floor(n / 2)]];
    const pixels = frame.png ? (await decodedSamples(frame.data, 'image/png', points)).pixels : points.map(([x, y]) => dibPixel(frame, x, y));
    near(pixels[0], [0, 0, 0, 0]); near(pixels[1], [255, 0, 0, 255]);
    near(pixels[2], [0, 255, 0, 255]); near(pixels[3], [0, 0, 255, 128]);
  }
  assert.equal(hash(await readFile(input)), hash(original));
  await assert.rejects(imageToIco({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
});

test('ICO storage choices, crop/stretch, background and JPEG/WebP sources use the existing engine', browserOptions, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'input.png'); await writeFile(input, pngFixture());
  for (const storage of ['png', 'bmp']) {
    const output = path.join(directory, `only-${storage}.ico`);
    await imageToIco({ input_path: input, output_path: output, sizes: [32], storage, fit: 'stretch', background: '#ffffff' });
    const [frame] = icoFrames(await readFile(output)); assert.equal(frame.png, storage === 'png');
    const points = [[8, 4], [8, 28], [28, 16]];
    const pixels = frame.png ? (await decodedSamples(frame.data, 'image/png', points)).pixels : points.map(([x, y]) => dibPixel(frame, x, y));
    near(pixels[0], [255, 0, 0, 255]); near(pixels[1], [0, 255, 0, 255]); near(pixels[2], [127, 127, 255, 255]);
  }
  for (const format of ['jpeg', 'webp']) {
    const source = path.join(directory, `source.${format === 'jpeg' ? 'jpg' : 'webp'}`);
    await convertImage({ input_path: input, output_path: source, format, quality: 1 });
    const output = path.join(directory, `${format}.ico`);
    const result = await imageToIco({ input_path: source, output_path: output, sizes: [32], fit: 'crop' });
    assert.equal(result.input_width, 64); assert.equal(result.input_height, 32);
    assert.equal(icoFrames(await readFile(output)).length, 1);
  }
});

test('SVG PNG rendering preserves alpha, unit sizing, internal references and source bytes', browserOptions, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'drawing.svg'), output = path.join(directory, 'drawing.png');
  await writeFile(input, svgFixture);
  const result = await svgToImage({ input_path: input, output_path: output, width: 64, height: 64, fit: 'pad' });
  assert.equal(result.verified, true); assert.equal(result.width, 64); assert.equal(result.height, 64); assert.equal(result.padded, true);
  assert.equal(result.verification.png_pixel_samples, 25); assert.equal(result.background, null);
  const decoded = await decodedSamples(await readFile(output), 'image/png', [[8, 0], [8, 20], [8, 44], [48, 32]]);
  near(decoded.pixels[0], [0, 0, 0, 0]); near(decoded.pixels[1], [255, 0, 0, 255]);
  near(decoded.pixels[2], [0, 255, 0, 255]); near(decoded.pixels[3], [0, 0, 255, 128]);
  assert.equal(await readFile(input, 'utf8'), svgFixture);
  await assert.rejects(svgToImage({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  const internal = path.join(directory, 'internal.svg');
  await writeFile(internal, '<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="0.5in"><defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#paint)"/></svg>');
  const intrinsic = await svgToImage({ input_path: internal, output_path: path.join(directory, 'internal.png') });
  assert.equal(intrinsic.width, 96); assert.equal(intrinsic.height, 48);
  const embedded = path.join(directory, 'embedded.svg'), embeddedOutput = path.join(directory, 'embedded.png');
  await writeFile(embedded, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><image width="64" height="32" href="data:image/png;base64,${pngFixture().toString('base64')}"/></svg>`);
  await svgToImage({ input_path: embedded, output_path: embeddedOutput });
  near((await decodedSamples(await readFile(embeddedOutput), 'image/png', [[8, 4], [48, 16]])).pixels[1], [0, 0, 255, 128]);
});

test('SVG JPEG matte, WebP alpha, fit/stretch and UTF16 BOM decoding produce real pixels', browserOptions, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'source.svg');
  await writeFile(input, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(svgFixture, 'utf16le')]));
  for (const format of ['jpeg', 'webp']) {
    const output = path.join(directory, `raster.${format === 'jpeg' ? 'jpg' : 'webp'}`);
    const result = await svgToImage({ input_path: input, output_path: output, format, width: 128, height: 128, fit: 'fit', quality: 1 });
    assert.equal(result.width, 128); assert.equal(result.height, 64);
    const samples = await decodedSamples(await readFile(output), format === 'jpeg' ? 'image/jpeg' : 'image/webp', [[16, 16], [96, 32]]);
    near(samples.pixels[0], [255, 0, 0, 255], 5);
    near(samples.pixels[1], format === 'jpeg' ? [127, 127, 255, 255] : [0, 0, 255, 128], 5);
  }
  const output = path.join(directory, 'stretch.png');
  const result = await svgToImage({ input_path: input, output_path: output, width: 32, height: 64, fit: 'stretch' });
  assert.equal(result.width, 32); assert.equal(result.height, 64); assert.equal(result.stretched, true);
  near((await decodedSamples(await readFile(output), 'image/png', [[4, 8]])).pixels[0], [255, 0, 0, 255]);
  const single = await svgToImage({ input_path: input, output_path: path.join(directory, 'width-only.png'), width: 32 });
  assert.equal(single.width, 32); assert.equal(single.height, 16);
});

test('SVG rejects external references, active content and animation instead of omitting them', browserOptions, async t => {
  const directory = await workspace(t);
  const contents = [
    '<image href="https://example.invalid/private.png"/>', '<image href="../private.png"/>',
    '<rect width="10" height="10" fill="url(file:///private.svg#paint)"/>',
    '<script>throw new Error("private content")</script>', '<rect width="10" height="10" onload="fetch(1)"/>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">private</div></foreignObject>',
    '<rect width="10" height="10"><animate attributeName="x" values="0;5" dur="1s"/></rect>',
    '<style>rect { animation: spin 1s infinite }</style><rect width="10" height="10"/>',
    '<style>rect { /* comment */ transition: fill 1s }</style><rect width="10" height="10"/>',
    '<style>@import "https://example.invalid/private.css";</style>',
    '<style>rect { background-image: image-set("https://example.invalid/private.png" 1x) }</style>',
    `<image href="data:image/png;base64,${Buffer.from(svgFixture).toString('base64')}"/>`,
    `<image href="data:image/png;base64,${pngFixture({ animated: true }).toString('base64')}"/>`,
  ];
  for (const [index, content] of contents.entries()) {
    const input = path.join(directory, `unsupported-${index}.svg`), output = path.join(directory, `unsupported-${index}.png`);
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${content}</svg>`;
    await writeFile(input, source);
    await assert.rejects(svgToImage({ input_path: input, output_path: output }), error => {
      assert.ok(['UNSUPPORTED_SVG', 'SVG_EXTERNAL_RESOURCE'].includes(error.code));
      assert.ok(!error.message.includes('private')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    assert.equal(await readFile(input, 'utf8'), source);
  }
  const oversizedPng = pngFixture();
  const largeHeader = Buffer.from(oversizedPng.subarray(16, 29)); largeHeader.writeUInt32BE(10000); largeHeader.writeUInt32BE(10000, 4);
  const oversized = Buffer.concat([oversizedPng.subarray(0, 8), chunk('IHDR', largeHeader), oversizedPng.subarray(33)]);
  const input = path.join(directory, 'oversized-embedded.svg'), output = path.join(directory, 'oversized-embedded.png');
  await writeFile(input, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image width="16" height="16" href="data:image/png;base64,${oversized.toString('base64')}"/></svg>`);
  await assert.rejects(svgToImage({ input_path: input, output_path: output }), { code: 'IMAGE_DIMENSIONS' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  for (const [index, source, code] of [
    [0, '<!DOCTYPE svg [<!ENTITY value "test">]><svg xmlns="http://www.w3.org/2000/svg"/>', 'UNSUPPORTED_SVG'],
    [1, '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>', 'INVALID_SVG'],
  ]) {
    const input = path.join(directory, `invalid-document-${index}.svg`), output = path.join(directory, `invalid-document-${index}.png`);
    await writeFile(input, source);
    await assert.rejects(svgToImage({ input_path: input, output_path: output }), { code });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('ICO refuses oversized raster headers and inconsistent WebP frames before opening a browser', async t => {
  const directory = await workspace(t);
  const png = pngFixture();
  const header = Buffer.from(png.subarray(16, 29));
  header.writeUInt32BE(10000); header.writeUInt32BE(10000, 4);
  const oversizedPng = Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), png.subarray(33)]);
  function jpegHeader(marker, width, height) {
    const frame = Buffer.alloc(19);
    frame[0] = 0xff; frame[1] = marker; frame.writeUInt16BE(17, 2); frame[4] = 8;
    frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7); frame[9] = 3;
    frame.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 10);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
  }
  function webp(chunks) {
    const body = Buffer.concat(chunks.map(([fourcc, data]) => {
      const header = Buffer.alloc(8); header.write(fourcc, 'ascii'); header.writeUInt32LE(data.length, 4);
      return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
    }));
    const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8);
    return Buffer.concat([header, body]);
  }
  function vp8x(width, height) {
    const bytes = Buffer.alloc(10); bytes.writeUIntLE(width - 1, 4, 3); bytes.writeUIntLE(height - 1, 7, 3); return bytes;
  }
  const vp8 = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  vp8.writeUInt16LE(10000, 6); vp8.writeUInt16LE(10000, 8);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((10000 - 1) | ((10000 - 1) << 14)) >>> 0, 1);
  const sources = [
    ['png', oversizedPng], ['baseline.jpg', jpegHeader(0xc0, 10000, 10000)],
    ['progressive.jpg', jpegHeader(0xc2, 10000, 10000)], ['zero-height.jpg', jpegHeader(0xc0, 10, 0)],
    ['vp8.webp', webp([['VP8 ', vp8]])], ['vp8l.webp', webp([['VP8L', vp8l]])],
    ['vp8x.webp', webp([['VP8X', vp8x(10000, 10000)], ['VP8 ', vp8]])],
    ['lying-canvas.webp', webp([['VP8X', vp8x(16, 16)], ['VP8 ', vp8]])],
  ];
  for (const [name, bytes] of sources) {
    const input = path.join(directory, name), output = path.join(directory, `${name}.ico`);
    await writeFile(input, bytes);
    await assert.rejects(imageToIco({ input_path: input, output_path: output }), { code: 'IMAGE_DIMENSIONS' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    assert.equal(hash(await readFile(input)), hash(bytes));
  }
});

test('ICO and SVG enforce formats, geometry, static inputs, exclusive outputs and cancellation', async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'source.png'); await writeFile(input, pngFixture());
  for (const sizes of [[], [0], [512], [16, 16]]) {
    await assert.rejects(imageToIco({ input_path: input, output_path: path.join(directory, 'invalid.ico'), sizes }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(imageToIco({ input_path: input, output_path: path.join(directory, 'wrong.png') }), { code: 'OUTPUT_EXTENSION' });
  const animated = path.join(directory, 'animated.png'); await writeFile(animated, pngFixture({ animated: true }));
  await assert.rejects(imageToIco({ input_path: animated, output_path: path.join(directory, 'animated.ico') }), { code: 'ANIMATED_IMAGE' });
  for (const dimensions of [{ width: 0 }, { width: 16385 }, { width: 10000, height: 10000 }]) {
    await assert.rejects(svgToImage({ input_path: input, output_path: path.join(directory, 'large.png'), ...dimensions }), { code: 'IMAGE_DIMENSIONS' });
  }
  await assert.rejects(svgToImage({ input_path: input, output_path: path.join(directory, 'wrong.webp'), format: 'png' }), { code: 'OUTPUT_EXTENSION' });
  for (const operation of [imageToIco, svgToImage]) {
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, 'cancelled') }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  }
});
