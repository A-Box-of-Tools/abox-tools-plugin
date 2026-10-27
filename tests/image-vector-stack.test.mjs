import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { traceImageToSvg, stackImages, MAX_STACK_IMAGES } from '../src/image-vector-stack.mjs';


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

async function frames(directory, values, size = [13, 11]) {
  const paths = [];
  for (const [index, value] of values.entries()) {
    const filename = path.join(directory, `frame-${index}.png`);
    await writeFile(filename, png(...size, value)); paths.push(filename);
  }
  return paths;
}

test('trace/stack settings, paths, stillness, dimensions, aggregate bytes and cancellation fail closed', async t => {
  const directory = await workspace(t), input_paths = await frames(directory, [[0, 0, 0, 255], [255, 255, 255, 255]]);
  const traceArgs = { input_path: input_paths[0], output_path: path.join(directory, 'output.svg') };
  for (const extra of [{ threshold: 256 }, { threshold: 'auto' }, { invert: 1 }, { detail: 0 }, { detail: Infinity },
    { corner_angle: 181 }, { min_area: -1 }, { fill: '#fff' }, { fill: 'url(file:///private)' }]) {
    await assert.rejects(traceImageToSvg({ ...traceArgs, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  const stackArgs = { input_paths, output_path: path.join(directory, 'output.png') };
  for (const extra of [{ input_paths: [] }, { input_paths: [input_paths[0]] }, { input_paths: Array(MAX_STACK_IMAGES + 1).fill(input_paths[0]) },
    { method: 'focus' }, { method: 'mean' }, { format: 'webp' }, { kappa: 2 }, { gain: 1 },
    { method: 'sigma', kappa: 0 }, { method: 'add', gain: 17 }, { quality: NaN }]) {
    await assert.rejects(stackImages({ ...stackArgs, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(traceImageToSvg({ ...traceArgs, output_path: path.join(directory, 'wrong.png') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(stackImages({ ...stackArgs, output_path: path.join(directory, 'wrong.svg') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(traceImageToSvg({ ...traceArgs, input_path: 'https://example.invalid/private.png' }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(stackImages({ ...stackArgs, input_paths: ['https://example.invalid/private.png', input_paths[0]] }), { code: 'LOCAL_PATH_REQUIRED' });
  const bad = path.join(directory, 'bad.png');
  await writeFile(bad, png(1, 1, [0, 0, 0, 255], { animated: true }));
  await assert.rejects(traceImageToSvg({ ...traceArgs, input_path: bad }), { code: 'ANIMATED_IMAGE' });
  await assert.rejects(stackImages({ ...stackArgs, input_paths: [bad, input_paths[0]] }), { code: 'ANIMATED_IMAGE' });
  await writeFile(bad, png(1, 1, [0, 0, 0, 255], { declaredWidth: 4000, declaredHeight: 1001 }));
  await assert.rejects(traceImageToSvg({ ...traceArgs, input_path: bad }), { code: 'IMAGE_DIMENSIONS' });
  await assert.rejects(stackImages({ ...stackArgs, input_paths: [bad, input_paths[0]] }), { code: 'IMAGE_DIMENSIONS' });
  await writeFile(bad, png(1, 1, [0, 0, 0, 255], { declaredWidth: 4097, declaredHeight: 1 }));
  await assert.rejects(traceImageToSvg({ ...traceArgs, input_path: bad }), { code: 'IMAGE_DIMENSIONS' });
  const large = [];
  for (const name of ['a', 'b']) {
    const filename = path.join(directory, `large-${name}`), file = await open(filename, 'w');
    await file.truncate(65 * 1024 * 1024); await file.close(); large.push(filename);
  }
  await assert.rejects(stackImages({ ...stackArgs, input_paths: large }), { code: 'INPUT_SIZE' });
  await assert.rejects(traceImageToSvg(traceArgs, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(stackImages(stackArgs, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(traceArgs.output_path), { code: 'ENOENT' });
  await assert.rejects(readFile(stackArgs.output_path), { code: 'ENOENT' });
});
