import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { previewBusinessProfile, compareHeights } from '../src/profile-heights.mjs';
import { findBrowser, withBrowser } from '../src/browser.mjs';

const browserOptions = { skip: !await findBrowser(), timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-profile-heights-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function redPng() {
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rows.set([255, 0, 0, 255], y * 65 + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('private\0private-photo-description')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function colors(filename, lossyPhoto = false) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: await readFile(filename) });
    return page.evaluate(async lossyPhoto => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
      try {
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const counts = { red: 0, blue: 0, white: 0, transparent: 0 };
        for (let at = 0; at < pixels.length; at += 4) {
          if ((lossyPhoto ? pixels[at] >= 240 && pixels[at + 1] <= 15 && pixels[at + 2] <= 15
            : pixels[at] === 255 && pixels[at + 1] === 0 && pixels[at + 2] === 0) && pixels[at + 3] === 255) counts.red++;
          if (pixels[at] === 0 && pixels[at + 1] === 0 && pixels[at + 2] === 255 && pixels[at + 3] === 255) counts.blue++;
          if (pixels[at] === 255 && pixels[at + 1] === 255 && pixels[at + 2] === 255 && pixels[at + 3] === 255) counts.white++;
          if (!pixels[at + 3]) counts.transparent++;
        }
        return { width: bitmap.width, height: bitmap.height, counts };
      } finally { bitmap.close(); }
    }, lossyPhoto);
  });
}

test('all business surfaces export passive SVG with source English labels and keep private text out of results', browserOptions, async t => {
  const directory = await workspace(t), config = path.join(directory, 'profile.json');
  const profile = { name: 'Private <script>alert(1)</script> & Cafe', category: 'Private category', status: 'open24',
    address: 'Private address 123', website: 'https://example.invalid/private-path', phone: '555-555-1234', rating: 4.5, reviews: 128,
    description: 'Private description', attributes: 'Private attribute', clock: '24' };
  for (const surface of ['panel', 'mobile', 'listing']) {
    const source = JSON.stringify({ profile, surface, preview_time: '2026-10-27T12:00' }); await writeFile(config, source);
    const output = path.join(directory, `${surface}.svg`), result = await previewBusinessProfile({ config_path: config, output_path: output, format: 'svg' });
    const svg = await readFile(output, 'utf8');
    assert.equal(result.verified, true); assert.equal(result.item_count, 1); assert.equal(result.verification.passive_svg, true);
    assert.ok(svg.includes('Private')); assert.ok(svg.includes('Open 24 hours'));
    assert.ok(!/<script|foreignObject|\son\w+=|href="https?:/i.test(svg));
    assert.ok(!svg.includes('label.reviews')); assert.ok(!svg.includes('status.open24'));
    assert.ok(!JSON.stringify(result).includes('Private')); assert.ok(!JSON.stringify(result).includes('example.invalid'));
    assert.equal(await readFile(config, 'utf8'), source);
    await assert.rejects(previewBusinessProfile({ config_path: config, output_path: output, format: 'svg' }), { code: 'OUTPUT_EXISTS' });
  }
});

test('business cover photos are re-encoded locally, metadata is omitted, and PNG pixels verify', browserOptions, async t => {
  const directory = await workspace(t), config = path.join(directory, 'profile.json'), photo = path.join(directory, 'photo.png');
  const source = redPng(); await writeFile(photo, source);
  await writeFile(config, JSON.stringify({ profile: { name: 'Private shop', status: 'open24' }, surface: 'panel' }));
  const svgPath = path.join(directory, 'cover.svg');
  await previewBusinessProfile({ config_path: config, output_path: svgPath, photo_path: photo, format: 'svg' });
  const svg = await readFile(svgPath, 'utf8'); assert.match(svg, /<image href="data:image\/jpeg;base64,/);
  assert.ok(!svg.includes('private-photo-description'));
  const output = path.join(directory, 'cover.png'), result = await previewBusinessProfile({ config_path: config, output_path: output, photo_path: photo, scale: 1 });
  assert.equal(result.verification.png_pixel_checks, result.width * result.height);
  // The unchanged cover reader intentionally embeds JPEG at quality 0.82;
  // its near-red pixels are expected to differ from the original exact RGB.
  const decoded = await colors(output, true); assert.equal(decoded.width, result.width); assert.equal(decoded.height, result.height);
  assert.ok(decoded.counts.red > 1000); assert.ok(decoded.counts.white > 1000); assert.equal(decoded.counts.transparent, 0);
  assert.equal(hash(await readFile(photo)), hash(source));
});

test('height SVG geometry uses exact source measurements and PNG preserves chart colors/transparency', browserOptions, async t => {
  const directory = await workspace(t), config = path.join(directory, 'heights.json');
  const source = JSON.stringify({ figures: [{ name: 'Private child', height: '150 cm', shape: 'object', width: '50 cm', color: '#ff0000' },
    { name: 'Private object', height: '3 m', shape: 'object', width: '50 cm', color: '#0000ff' }], unit: 'cm', plot_height: 400, background: 'none' });
  await writeFile(config, source);
  const svgPath = path.join(directory, 'heights.svg'), svgResult = await compareHeights({ config_path: config, output_path: svgPath, format: 'svg' });
  const svg = await readFile(svgPath, 'utf8');
  const height = color => Number(new RegExp('<rect[^>]*height="([\\d.]+)"[^>]*fill="' + color + '"').exec(svg)?.[1]);
  assert.ok(height('#ff0000') > 0); assert.ok(Math.abs(height('#0000ff') - height('#ff0000') * 2) <= 0.02);
  assert.ok(svg.includes('150 cm') && svg.includes('300 cm')); assert.equal(svgResult.item_count, 2);
  assert.ok(!JSON.stringify(svgResult).includes('Private')); assert.ok(!Object.hasOwn(svgResult, 'figures'));
  const output = path.join(directory, 'heights.png'), result = await compareHeights({ config_path: config, output_path: output, scale: 1 });
  const decoded = await colors(output);
  assert.equal(result.verification.png_pixel_checks, result.width * result.height);
  assert.ok(decoded.counts.red > 1000); assert.ok(decoded.counts.blue > 1000); assert.ok(decoded.counts.transparent > 1000);
  assert.equal(await readFile(config, 'utf8'), source);
});

test('bundled people, feet/inches, invalid wall times and unreadable measurements retain source behavior', browserOptions, async t => {
  const directory = await workspace(t), config = path.join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ figures: ['man', 'woman', 'boy', 'girl'].map(shape => ({ height: "5'8\"", shape })), unit: 'ft' }));
  const output = path.join(directory, 'people.svg'), result = await compareHeights({ config_path: config, output_path: output, format: 'svg' });
  assert.equal(result.item_count, 4); assert.ok((await readFile(output, 'utf8')).includes('5 ft 8 in'));
  await writeFile(config, JSON.stringify({ figures: [{ height: "5'14\"" }] }));
  await assert.rejects(compareHeights({ config_path: config, output_path: path.join(directory, 'invalid.svg'), format: 'svg' }), { code: 'HEIGHT_MEASUREMENT' });
  await writeFile(config, JSON.stringify({ profile: { name: 'Private', status: 'open24' }, preview_time: '2026-02-30T12:00' }));
  await assert.rejects(previewBusinessProfile({ config_path: config, output_path: path.join(directory, 'invalid.png') }), { code: 'INVALID_CONFIG' });
});

test('preview cancellation leaves source configuration and output location intact', browserOptions, async t => {
  const directory = await workspace(t), config = path.join(directory, 'config.json');
  for (const [operation, value] of [[previewBusinessProfile, { profile: { name: 'Private', status: 'open24' } }],
    [compareHeights, { figures: [{ height: '173 cm' }] }]]) {
    const source = JSON.stringify(value), output = path.join(directory, `${operation.name}.png`); await writeFile(config, source);
    const controller = new AbortController(), pending = operation({ config_path: config, output_path: output }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
    assert.equal(await readFile(config, 'utf8'), source); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});
