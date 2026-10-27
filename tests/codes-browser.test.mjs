import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateQr, generateBarcode } from '../src/codes.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { decodeMatrix } from '../vendor/abox/tools/qr-barcode-reader/src/qr-decode.js';
import { readLinear } from '../vendor/abox/tools/qr-barcode-reader/src/linear.js';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-codes-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readPng(bytes, result, qr) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'generated.png', mimeType: 'image/png', buffer: bytes });
    return page.evaluate(async ({ result, qr }) => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
      let canvas;
      try {
        canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const foreground = [1, 3, 5].map(at => Number.parseInt(result.foreground.slice(at, at + 2), 16));
        const dark = (x, y) => foreground.every((value, channel) => pixels[(y * bitmap.width + x) * 4 + channel] === value) ? 1 : 0;
        const width = qr ? result.modules_per_side : bitmap.width;
        const height = qr ? width : 4;
        const bits = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            bits.push(qr
              ? dark((x + result.quiet) * result.scale + Math.floor(result.scale / 2), (y + result.quiet) * result.scale + Math.floor(result.scale / 2))
              : dark(x, 2 + y * Math.floor(result.bar_height / 5)));
          }
        }
        return { width, height, bits, image_width: bitmap.width, image_height: bitmap.height,
          corner: Array.from(pixels.subarray(0, 4)) };
      } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
    }, { result, qr });
  });
}

test('QR PNG decodes from actual colored output pixels with complete quiet margins', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'payload.txt'), output = path.join(directory, 'qr.png');
  const original = Buffer.from('Exact local QR payload: café 😀\n'); await writeFile(input, original);
  const result = await generateQr({ input_path: input, output_path: output, format: 'png', level: 'H', scale: 5,
    quiet: 6, foreground: '#123456', background: '#ffffff' });
  const pixels = await readPng(await readFile(output), result, true);
  assert.equal(pixels.image_width, result.width); assert.equal(pixels.image_height, result.height);
  assert.deepEqual(pixels.corner, [255, 255, 255, 255]);
  assert.equal(decodeMatrix(pixels.width, Uint8Array.from(pixels.bits)).text, original.toString('utf8'));
  assert.equal(result.verification.png_pixel_samples, (result.modules_per_side + 12) ** 2);
  assert.equal(hash(await readFile(input)), hash(original));
});

test('barcode PNG retains scannable pixel bars, source quiet zones and escaped labels', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'payload.txt');
  for (const [at, symbology, payload, expected, text] of [
    [0, 'code128', '<&" PRIVATE-1234', '<&" PRIVATE-1234', true],
    [1, 'ean13', '400638133393', '4006381333931', true],
    [2, 'code39', 'local', 'LOCAL', false],
  ]) {
    const original = Buffer.from(payload); await writeFile(input, original);
    const output = path.join(directory, `barcode-${at}.png`);
    const result = await generateBarcode({ input_path: input, output_path: output, symbology, format: 'png', scale: 3, height: 75, text });
    const pixels = await readPng(await readFile(output), result, false);
    assert.equal(pixels.image_width, result.width); assert.equal(pixels.image_height, result.height);
    assert.equal(readLinear(Uint8Array.from(pixels.bits), pixels.width, pixels.height, 4).text, expected);
    assert.equal(result.verification.png_pixel_samples, result.width / result.scale);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-1234'));
    assert.equal(hash(await readFile(input)), hash(original));
  }
});
