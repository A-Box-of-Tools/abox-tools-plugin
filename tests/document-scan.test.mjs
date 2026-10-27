import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { scanDocument, MAX_SCAN_CONFIG_BYTES } from '../src/document-scan.mjs';
import { MAX_INPUT_BYTES } from '../src/files.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-scan-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const configured = (width = 128, height = 96) => ({ image_width: width, image_height: height,
  corners: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }] });

test('scan settings require supported typed modes, dimensions and format-specific options', async t => {
  const directory = await workspace(t), input = path.join(directory, 'missing.png'), config = path.join(directory, 'page.json');
  await writeFile(config, JSON.stringify({ pages: [configured()] }));
  const cases = [{ format: null }, { format: 'jpeg' }, { mode: null }, { mode: 'private-secret' }, { strength: -1 }, { strength: 101 },
    { max_side: 63 }, { max_side: 4097 }, { dpi: 1201 }, { dpi: null }, { quality: 0.29 }, { margin_mm: -1 }, { page_size: 'a3' },
    { format: 'png', dpi: 200 }, { format: 'png', quality: 0.82 }];
  for (const [index, chosen] of cases.entries()) {
    const output = path.join(directory, `bad-${index}.${chosen.format === 'png' ? 'png' : 'pdf'}`);
    await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: output, ...chosen }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  await assert.rejects(scanDocument({ input_paths: [], config_path: config, output_path: path.join(directory, 'empty.pdf') }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(scanDocument({ input_paths: [input, input], config_path: config, format: 'png', output_path: path.join(directory, 'batch.png') }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'wrong.png') }), { code: 'OUTPUT_EXTENSION' });
});

test('scan configuration refuses private malformed fields, duplicate keys, wrong page counts and unsafe quadrilaterals', async t => {
  const directory = await workspace(t), input = path.join(directory, 'missing.png'), config = path.join(directory, 'page.json');
  const page = configured(), badPages = [
    { ...page, image_width: null }, { ...page, private: 'private-secret' }, { ...page, image_width: 8193 },
    { ...page, corners: [...page.corners].reverse() }, { ...page, corners: [page.corners[0], page.corners[2], page.corners[1], page.corners[3]] },
    { ...page, corners: [{ x: -1, y: 0 }, ...page.corners.slice(1)] },
    { ...page, corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 96 }, { x: 0, y: 96 }] },
    { ...page, corners: [{ x: 0, y: 0 }, { x: 128, y: 0 }, { x: 64, y: 10 }, { x: 0, y: 96 }] },
  ];
  const cases = ['{"private-secret":', '{"pages":[],"pages":[]}', 'null', '[]', JSON.stringify({ pages: [] }),
    ...badPages.map(value => JSON.stringify({ pages: [value] })), '['.repeat(9) + '0' + ']'.repeat(9)];
  for (const [index, source] of cases.entries()) {
    await writeFile(config, source); const output = path.join(directory, `invalid-${index}.pdf`);
    await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: output }), error => {
      assert.equal(error.code, 'INVALID_SCAN_CONFIG'); assert.ok(!String(error).includes('private-secret'));
      assert.ok(!JSON.stringify(error).includes('private-secret')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(config, 'utf8'), source);
  }
  await writeFile(config, Buffer.from([0xff]));
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'utf8.pdf') }), { code: 'INVALID_UTF8' });
  await writeFile(config, ' '.repeat(MAX_SCAN_CONFIG_BYTES + 1));
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'large.pdf') }), { code: 'INPUT_SIZE' });
});

test('scan output pixels and page totals are bounded before reading image files or allocating warp buffers', async t => {
  const directory = await workspace(t), input = path.join(directory, 'missing.png'), config = path.join(directory, 'pages.json');
  await writeFile(config, JSON.stringify({ pages: [configured(4000, 3000)] }));
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'pixels.pdf'), max_side: 4096 }), { code: 'SCAN_PIXEL_LIMIT' });
  await writeFile(config, JSON.stringify({ pages: Array.from({ length: 16 }, () => configured(3200, 2400)) }));
  await assert.rejects(scanDocument({ input_paths: Array(16).fill(input), config_path: config, output_path: path.join(directory, 'total.pdf') }), { code: 'SCAN_PIXEL_LIMIT' });
});

function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const value of out.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png(width, height, animated = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(animated ? [chunk('acTL', animation)] : []),
    chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]);
}

test('scan input header admission refuses animation and excessive dimensions before native decoding', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'page.json');
  await writeFile(config, JSON.stringify({ pages: [configured()] }));
  for (const [index, bytes, code] of [[0, png(128, 96, true), 'ANIMATED_IMAGE'], [1, png(10000, 96), 'IMAGE_DIMENSIONS'],
    [2, png(8192, 8192), 'IMAGE_DIMENSIONS']]) {
    await writeFile(input, bytes); const output = path.join(directory, `refused-${index}.pdf`);
    await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: output }), { code });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), bytes);
  }
});

test('scan requires local paths, new outputs and bounded total bytes and honors cancellation', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'page.json'), output = path.join(directory, 'existing.pdf');
  await writeFile(config, JSON.stringify({ pages: [configured()] })); await writeFile(output, 'keep-existing'); await writeFile(input, png(128, 96));
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep-existing');
  await assert.rejects(scanDocument({ input_paths: ['https://example.invalid/source'], config_path: config, output_path: path.join(directory, 'remote.pdf') }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'cancelled.pdf') }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const file = await open(input, 'w'); await file.truncate(MAX_INPUT_BYTES + 1); await file.close();
  await assert.rejects(scanDocument({ input_paths: [input], config_path: config, output_path: path.join(directory, 'large.pdf') }), { code: 'INPUT_SIZE' });
});
