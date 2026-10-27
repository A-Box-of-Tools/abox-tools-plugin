import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { makeIdPhoto } from '../src/id-photo.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const hash = value => createHash('sha256').update(value).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-id-photo-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(pixel) {
  const width = 600, height = 800, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0Private original metadata')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const defaults = () => ({ image_width: 600, image_height: 800, width_mm: 35, height_mm: 45, dpi: 300,
  head_min_mm: 30, head_max_mm: 32, eye_min_mm: 24, eye_max_mm: 26,
  landmarks: { crown: { x: 300, y: 100 }, chin: { x: 300, y: 580 }, left_eye: { x: 240, y: 340 }, right_eye: { x: 360, y: 340 } } });
async function samples(filename, points) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'print.jpg', mimeType: 'image/jpeg', buffer: await readFile(filename) });
    return page.evaluate(async points => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]), canvas = document.createElement('canvas');
      try {
        canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
      } finally { bitmap.close(); canvas.width = canvas.height = 0; }
    }, points);
  });
}
const near = (actual, expected, tolerance = 12) => actual.forEach((value, at) => assert.ok(Math.abs(value - expected[at]) <= tolerance));

test('custom ID-photo uses supplied landmarks, exact pixel geometry and independently read JPEG DPI', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'settings.json');
  const source = png((x, y) => [x < 300 ? 200 : 20, y < 400 ? 40 : 180, 60, 255]), settings = JSON.stringify(defaults());
  await writeFile(input, source); await writeFile(config, '\ufeff' + settings);
  const result = await makeIdPhoto({ input_path: input, settings_path: config, output_dir: path.join(directory, 'prints') });
  assert.equal(result.output_count, 3); assert.equal(result.copies, 8); assert.equal(result.dpi, 300); assert.equal(result.verified, true);
  assert.equal(result.verification.pixel_identity, false); assert.equal(result.verification.custom_geometry, true);
  assert.ok(!JSON.stringify(result).includes('crown')); assert.ok(!JSON.stringify(result).includes('left_eye')); assert.ok(!JSON.stringify(result).includes('"x":'));
  const report = JSON.parse(await readFile(result.manifest_path, 'utf8'));
  assert.deepEqual(report.plan.fitted.rect, { x: 29, y: 30, width: 542, height: 697 });
  assert.equal(report.regulatory_approval, false); assert.equal(report.plan.sheet.columns, 4); assert.equal(report.plan.sheet.rows, 2);
  const [photo, sheet] = result.outputs; assert.deepEqual([photo.width, photo.height], [413, 531]);
  const image = await samples(photo.output_path, [[80, 100], [330, 100], [80, 450], [330, 450]]);
  near(image.pixels[0], [200, 40, 60, 255]); near(image.pixels[1], [20, 40, 60, 255]);
  near(image.pixels[2], [200, 180, 60, 255]); near(image.pixels[3], [20, 180, 60, 255]);
  for (const output of result.outputs) {
    const bytes = await readFile(output.output_path), jfif = bytes.indexOf(Buffer.from('JFIF\0'));
    assert.ok(jfif > 0); assert.equal(bytes[jfif + 7], 1); assert.equal(bytes.readUInt16BE(jfif + 8), 300); assert.equal(bytes.readUInt16BE(jfif + 10), 300);
    assert.ok(!bytes.includes(Buffer.from('Private original metadata')));
  }
  const cells = report.plan.sheet.cells, points = cells.map(cell => [cell.x + 80, cell.y + 100]);
  const printedSheet = await samples(sheet.output_path, [[0, 0], ...points]); near(printedSheet.pixels[0], [255, 255, 255, 255], 3);
  for (const pixel of printedSheet.pixels.slice(1)) near(pixel, [200, 40, 60, 255]);
  for (const mark of report.plan.sheet.marks) for (const cell of cells) {
    const verticalInside = mark.x1 === mark.x2 && mark.x1 > cell.x && mark.x1 < cell.x + cell.width
      && Math.max(mark.y1, mark.y2) > cell.y && Math.min(mark.y1, mark.y2) < cell.y + cell.height;
    const horizontalInside = mark.y1 === mark.y2 && mark.y1 > cell.y && mark.y1 < cell.y + cell.height
      && Math.max(mark.x1, mark.x2) > cell.x && Math.min(mark.x1, mark.x2) < cell.x + cell.width;
    assert.equal(verticalInside || horizontalInside, false);
  }
  assert.equal(hash(await readFile(input)), hash(source)); assert.equal(await readFile(config, 'utf8'), '\ufeff' + settings);
});

test('ID-photo fills transparency without replacing the image and refuses wrong native display orientation', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'settings.json');
  await writeFile(input, png(() => [0, 0, 0, 0])); await writeFile(config, JSON.stringify({ ...defaults(), background: '#e0c090' }));
  const result = await makeIdPhoto({ input_path: input, settings_path: config, output_dir: path.join(directory, 'transparent') });
  for (const pixel of (await samples(result.outputs[0].output_path, [[10, 10], [200, 250]])).pixels) near(pixel, [224, 192, 144, 255], 3);
  await writeFile(config, JSON.stringify({ ...defaults(), image_width: 800, image_height: 600, allow_upscale: true,
    landmarks: { crown: { x: 400, y: 80 }, chin: { x: 400, y: 440 }, left_eye: { x: 340, y: 260 }, right_eye: { x: 460, y: 260 } } }));
  const output = path.join(directory, 'wrong-orientation');
  await assert.rejects(makeIdPhoto({ input_path: input, settings_path: config, output_dir: output }), { code: 'ID_PHOTO_COORDINATES' });
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('ID-photo cancellation during native work does not create a partial print set', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'settings.json');
  const source = png(() => [160, 80, 40, 255]), settings = JSON.stringify(defaults()); await writeFile(input, source); await writeFile(config, settings);
  const output = path.join(directory, 'cancelled'), controller = new AbortController();
  const pending = makeIdPhoto({ input_path: input, settings_path: config, output_dir: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source)); assert.equal(await readFile(config, 'utf8'), settings);
});
