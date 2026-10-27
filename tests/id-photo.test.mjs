import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { makeIdPhoto, MAX_ID_PHOTO_SETTINGS_BYTES, MAX_ID_PHOTO_INPUT_BYTES } from '../src/id-photo.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-id-photo-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png({ width = 600, height = 800, animated = false, declaredWidth = width, declaredHeight = height } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(declaredWidth); header.writeUInt32BE(declaredHeight, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1), 255); for (let y = 0; y < height; y++) rows[y * (width * 4 + 1)] = 0;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(animated ? [chunk('acTL', actl)] : []), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const defaults = () => ({ image_width: 600, image_height: 800, width_mm: 35, height_mm: 45, dpi: 300,
  head_min_mm: 30, head_max_mm: 32, eye_min_mm: 24, eye_max_mm: 26,
  landmarks: { crown: { x: 300, y: 100 }, chin: { x: 300, y: 580 }, left_eye: { x: 240, y: 340 }, right_eye: { x: 360, y: 340 } } });

test('ID-photo settings refuse ambiguous JSON, undeclared profiles, invalid measurements and malformed landmarks', async t => {
  const directory = await workspace(t), image = path.join(directory, 'input.png'), config = path.join(directory, 'settings.json'); await writeFile(image, png());
  const values = [null, [], { ...defaults(), country: 'private-country' }, { ...defaults(), image_width: undefined },
    { ...defaults(), image_width: 0 }, { ...defaults(), dpi: 601 }, { ...defaults(), width_mm: 0 },
    { ...defaults(), head_min_mm: 33 }, { ...defaults(), eye_max_mm: 46 }, { ...defaults(), paper_width_mm: 200 },
    { ...defaults(), margin_mm: 0 }, { ...defaults(), gap_mm: 0 }, { ...defaults(), quality: 0.1 }, { ...defaults(), background: 'url(private)' },
    { ...defaults(), allow_upscale: 'yes' }, { ...defaults(), landmarks: { ...defaults().landmarks, private: {} } },
    { ...defaults(), landmarks: { ...defaults().landmarks, crown: { x: 600, y: 100 } } },
    { ...defaults(), landmarks: { ...defaults().landmarks, chin: { x: 300, y: 200 } } },
    { ...defaults(), landmarks: { ...defaults().landmarks, right_eye: { x: 240, y: 340 } } }];
  for (const [index, value] of values.entries()) {
    await writeFile(config, JSON.stringify(value)); const output = path.join(directory, `invalid-${index}`);
    await assert.rejects(makeIdPhoto({ input_path: image, settings_path: config, output_dir: output }), error => {
      assert.equal(error.code, 'ID_PHOTO_SETTINGS'); assert.ok(!String(error).includes('private-country')); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  const source = JSON.stringify(defaults());
  for (const text of [source.replace('"dpi":300', '"dpi":300,"dpi":300'), '{"private-sensitive": ]}', '['.repeat(1000) + '0']) {
    await writeFile(config, text);
    await assert.rejects(makeIdPhoto({ input_path: image, settings_path: config, output_dir: path.join(directory, 'bad-json') }), error => {
      assert.equal(error.code, 'ID_PHOTO_SETTINGS'); assert.ok(!String(error).includes('private-sensitive')); return true;
    });
  }
});

test('ID-photo preflight refuses clipped geometry, scaled preview points, upscaling and unusable or oversized paper', async t => {
  const directory = await workspace(t), image = path.join(directory, 'input.png'), config = path.join(directory, 'settings.json'); await writeFile(image, png());
  const cases = [
    [{ ...defaults(), landmarks: { ...defaults().landmarks, right_eye: { x: 360, y: 350 } } }, 'ID_PHOTO_FRAMING'],
    [{ ...defaults(), landmarks: { ...defaults().landmarks, left_eye: { x: 240, y: 500 }, right_eye: { x: 360, y: 500 } } }, 'ID_PHOTO_FRAMING'],
    [{ ...defaults(), image_width: 300, image_height: 400, landmarks: { crown: { x: 150, y: 50 }, chin: { x: 150, y: 290 }, left_eye: { x: 120, y: 170 }, right_eye: { x: 180, y: 170 } } }, 'ID_PHOTO_COORDINATES'],
    [{ ...defaults(), dpi: 600 }, 'ID_PHOTO_UPSCALE'],
    [{ ...defaults(), paper_width_mm: 20, paper_height_mm: 20 }, 'ID_PHOTO_COPIES'],
    [{ ...defaults(), paper_width_mm: 500, paper_height_mm: 500, dpi: 72 }, 'ID_PHOTO_COPIES'],
    [{ ...defaults(), paper_width_mm: 500, paper_height_mm: 500, dpi: 600, allow_upscale: true }, 'ID_PHOTO_DIMENSIONS'],
  ];
  for (const [index, [value, code]] of cases.entries()) {
    const output = path.join(directory, `refused-${index}`); await writeFile(config, JSON.stringify(value));
    await assert.rejects(makeIdPhoto({ input_path: image, settings_path: config, output_dir: output }), { code });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('ID-photo file caps, stillness, absolute paths, exclusive directories and cancellation preserve input files', async t => {
  const directory = await workspace(t), image = path.join(directory, 'input.png'), config = path.join(directory, 'settings.json');
  const settings = JSON.stringify(defaults()); await writeFile(config, settings); await writeFile(image, png({ animated: true }));
  const args = { input_path: image, settings_path: config, output_dir: path.join(directory, 'output') };
  await assert.rejects(makeIdPhoto(args), { code: 'ANIMATED_IMAGE' });
  await writeFile(image, png({ width: 1, height: 1, declaredWidth: 8192, declaredHeight: 8192 }));
  await assert.rejects(makeIdPhoto(args), { code: 'ID_PHOTO_DIMENSIONS' });
  await writeFile(config, Buffer.from([0xff])); await assert.rejects(makeIdPhoto(args), { code: 'ID_PHOTO_SETTINGS' });
  const largeSettings = await open(config, 'w'); await largeSettings.truncate(MAX_ID_PHOTO_SETTINGS_BYTES + 1); await largeSettings.close();
  await assert.rejects(makeIdPhoto(args), { code: 'INPUT_SIZE' });
  await writeFile(config, settings); const largeImage = await open(image, 'w'); await largeImage.truncate(MAX_ID_PHOTO_INPUT_BYTES + 1); await largeImage.close();
  await assert.rejects(makeIdPhoto(args), { code: 'INPUT_SIZE' });
  await assert.rejects(makeIdPhoto({ ...args, settings_path: 'relative.json' }), { code: 'LOCAL_PATH_REQUIRED' });
  await mkdir(args.output_dir); const sentinel = path.join(args.output_dir, 'keep.txt'); await writeFile(sentinel, 'keep existing');
  await assert.rejects(makeIdPhoto(args), { code: 'OUTPUT_EXISTS' }); assert.equal(await readFile(sentinel, 'utf8'), 'keep existing');
  await assert.rejects(makeIdPhoto({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(await readFile(config, 'utf8'), settings);
});
