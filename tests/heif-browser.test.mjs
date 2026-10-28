import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertHeic, convertAvif } from '../src/heif-convert.mjs';
import { BYTES } from '../vendor/abox/tools/heic-to-jpg/src/example-data.js';

async function workspace(t) { const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-heif-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('HEIC conversion decodes a real tiled Apple photo with the shipped offline codec and verifies every PNG pixel', async t => {
  const dir = await workspace(t); const input = path.join(dir, 'input.heic'); await writeFile(input, Buffer.from(BYTES, 'base64'));
  const result = await convertHeic({ input_path: input, output_dir: path.join(dir, 'converted'), format: 'png' });
  assert.equal(result.verified, true); assert.equal(result.outputs.length, 1); assert.equal(result.outputs[0].width, 4032); assert.equal(result.outputs[0].height, 3024);
  assert.equal(result.outputs[0].pixel_mean_absolute_error, 0); assert.equal(result.verification.codec_geometry_admitted_before_decode, true);
  assert.ok((await readFile(result.outputs[0].output_path)).length > 100);
  await assert.rejects(convertHeic({ input_path: input, output_dir: path.join(dir, 'converted') }), error => error.code === 'OUTPUT_EXISTS');
});
test('AVIF still conversion verifies all output pixels and keeps encoded data off the result', async t => {
  const dir = await workspace(t);
  for (const [i, name] of ['white_1x1.avif', 'colors_sdr_srgb.avif'].entries()) {
    const input = path.join(dir, `${i}.avif`); await writeFile(input, await readFile(new URL(`./fixtures/avif/${name}`, import.meta.url)));
    const output = path.join(dir, `${i}.png`); const result = await convertAvif({ input_path: input, output_path: output, format: 'png' });
    assert.equal(result.verified, true); assert.equal(result.outputs[0].pixel_mean_absolute_error, 0); assert.equal(result.outputs[0].data, undefined);
    assert.deepEqual([result.outputs[0].width, result.outputs[0].height], i === 0 ? [1, 1] : [200, 200]);
  }
});
