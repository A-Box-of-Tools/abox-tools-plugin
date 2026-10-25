import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withBrowser } from '../src/browser.mjs';
import { resizeImage, convertImage } from '../src/image.mjs';
import { readBytes } from '../vendor/abox/tools/exif-editor/src/container.js';

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-image-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixtures() {
  return withBrowser(page => page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(index * 4, 0, 4, 8);
    }
    const opaque = canvas.toDataURL('image/png').split(',')[1];
    canvas.width = 32;
    canvas.height = 16;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 16);
    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    ctx.fillRect(8, 0, 8, 16);
    const alpha = canvas.toDataURL('image/png').split(',')[1];
    const blocked = await fetch('https://example.com/abox-image-egress-probe', {
      method: 'POST', body: 'synthetic offline test',
    }).then(() => false, () => true);
    canvas.width = 0;
    canvas.height = 0;
    return { opaque, alpha, blocked, offline: !navigator.onLine };
  }));
}

async function pixels(filename) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles(filename);
    return page.evaluate(async () => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
      const canvas = document.createElement('canvas');
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height,
          rgba: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally {
        bitmap.close();
        canvas.width = 0;
        canvas.height = 0;
      }
    });
  });
}

function pixel(image, x, y) {
  return image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function animatedPng(bytes) {
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4, 'ascii');
  chunk.writeUInt32BE(2, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
  return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
}

test('resize uses upstream containment and centered crop, keeps sources, and requires explicit upscaling', { timeout: 180000 }, async t => {
  const root = await workspace(t);
  const generated = await fixtures();
  assert.equal(generated.blocked, true);
  assert.equal(generated.offline, true);
  const original = Buffer.from(generated.opaque, 'base64');
  const input = path.join(root, 'original.png');
  await writeFile(input, original);
  const contained = await resizeImage({ input_path: input, output_path: path.join(root, 'inside.png'), width: 6, height: 6 });
  assert.equal(contained.verified, true);
  assert.equal(contained.format, 'png');
  assert.equal(contained.width, 6);
  assert.equal(contained.height, 4);
  const containedPixels = await pixels(contained.output_path);
  assert.equal(containedPixels.width, 6);
  assert.equal(containedPixels.height, 4);
  assert.deepEqual(pixel(containedPixels, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(containedPixels, 5, 1), [0, 0, 255, 255]);

  const covered = await resizeImage({ input_path: input, output_path: path.join(root, 'square.png'), width: 4, height: 4, fit: 'cover' });
  assert.deepEqual(covered.crop, { x: 2, y: 0, width: 8, height: 8 });
  const coveredPixels = await pixels(covered.output_path);
  assert.equal(coveredPixels.width, 4);
  assert.equal(coveredPixels.height, 4);
  assert.ok(pixel(coveredPixels, 1, 1)[1] > 240, 'The centered square must retain the middle green stripe.');

  const unchanged = await resizeImage({ input_path: input, output_path: path.join(root, 'not-enlarged.png'), width: 24, height: 24 });
  assert.equal(unchanged.untouched, true);
  assert.equal(unchanged.width, 12);
  assert.equal(unchanged.height, 8);
  assert.deepEqual(await readFile(unchanged.output_path), original);
  const enlarged = await resizeImage({ input_path: input, output_path: path.join(root, 'enlarged.png'), width: 24, allow_upscale: true });
  const enlargedPixels = await pixels(enlarged.output_path);
  assert.equal(enlargedPixels.width, 24);
  assert.equal(enlargedPixels.height, 16);
  assert.deepEqual(await readFile(input), original);
});

test('conversion verifies real WebP coding and pixels, PNG roundtrip, JPEG background, and exclusive outputs', { timeout: 180000 }, async t => {
  const root = await workspace(t);
  const generated = await fixtures();
  const input = path.join(root, 'source.png');
  const source = Buffer.from(generated.opaque, 'base64');
  await writeFile(input, source);
  const webp = await convertImage({ input_path: input, output_path: path.join(root, 'lossless.webp'), format: 'webp', quality: 1 });
  assert.equal(webp.verified, true);
  assert.equal(webp.lossless, true);
  const webpBytes = await readFile(webp.output_path);
  const container = await readBytes(new Uint8Array(webpBytes));
  assert.equal(container.kind, 'webp');
  assert.ok(container.doc.chunks.some(chunk => chunk.fourcc === 'VP8L'));
  const sourcePixels = await pixels(input);
  assert.deepEqual(await pixels(webp.output_path), sourcePixels, 'Lossless WebP must retain the opaque test pixels.');
  const png = await convertImage({ input_path: webp.output_path, output_path: path.join(root, 'roundtrip.png'), format: 'png' });
  assert.equal((await readBytes(new Uint8Array(await readFile(png.output_path)))).kind, 'png');
  assert.deepEqual(await pixels(png.output_path), sourcePixels);

  const alpha = path.join(root, 'transparent.png');
  await writeFile(alpha, Buffer.from(generated.alpha, 'base64'));
  const alphaPng = await convertImage({ input_path: alpha, output_path: path.join(root, 'alpha-preserved.png'), format: 'png', background: '#fedcba' });
  const alphaWebp = await convertImage({ input_path: alpha, output_path: path.join(root, 'alpha.webp'), format: 'webp', quality: 1 });
  const alphaRoundtrip = await convertImage({ input_path: alphaWebp.output_path, output_path: path.join(root, 'alpha-roundtrip.png'), format: 'png', background: '#fedcba' });
  for (const output of [alphaPng, alphaRoundtrip]) {
    assert.equal(output.background, null, 'A PNG must not composite a JPEG-only background.');
    const rgba = await pixels(output.output_path);
    assert.deepEqual(pixel(rgba, 24, 8), [0, 0, 0, 0], 'Fully transparent pixels must stay transparent.');
    const partial = pixel(rgba, 12, 8);
    assert.ok(Math.abs(partial[3] - 128) <= 1, 'Partially transparent pixels must retain their alpha.');
    assert.ok(partial[1] >= 250, 'The green source must survive PNG and lossless WebP conversion.');
    assert.deepEqual(pixel(rgba, 4, 8), [255, 0, 0, 255]);
  }
  const jpeg = await convertImage({ input_path: alpha, output_path: path.join(root, 'background.jpg'), format: 'jpeg', quality: 0.98, background: '#fedcba' });
  assert.equal((await readBytes(new Uint8Array(await readFile(jpeg.output_path)))).kind, 'jpeg');
  const flattened = await pixels(jpeg.output_path);
  assert.equal(flattened.width, 32);
  assert.equal(flattened.height, 16);
  const background = pixel(flattened, 24, 8);
  for (const [index, expected] of [254, 220, 186].entries()) assert.ok(Math.abs(background[index] - expected) <= 3);
  assert.equal(background[3], 255);

  const existing = path.join(root, 'existing.png');
  await writeFile(existing, 'Keep this existing output');
  await assert.rejects(convertImage({ input_path: input, output_path: existing, format: 'png' }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(existing, 'utf8'), 'Keep this existing output');
  const wrong = path.join(root, 'wrong-extension.png');
  await assert.rejects(convertImage({ input_path: input, output_path: wrong, format: 'jpeg' }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(stat(wrong), { code: 'ENOENT' });
  assert.deepEqual(await readFile(input), source);

  const animated = path.join(root, 'animated.png');
  await writeFile(animated, animatedPng(source));
  for (const [index, operation] of [resizeImage, convertImage].entries()) {
    const output = path.join(root, `animation-refused-${index}.png`);
    await assert.rejects(operation({ input_path: animated, output_path: output, width: 4, format: 'png' }), { code: 'ANIMATED_IMAGE' });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('invalid image settings and oversized output boxes fail before reading files or launching a browser', async () => {
  await assert.rejects(resizeImage({}), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(resizeImage({ width: 0 }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(resizeImage({ width: 2, fit: 'stretch' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(resizeImage({ width: 10000, height: 10000 }), { code: 'IMAGE_DIMENSIONS' });
  await assert.rejects(convertImage({ format: 'avif' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(convertImage({ format: 'jpeg', quality: Number.NaN }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(convertImage({ format: 'jpeg', background: 'url(https://example.com)' }), { code: 'INVALID_ARGUMENTS' });
});
