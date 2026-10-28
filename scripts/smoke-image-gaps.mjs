import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BYTES } from '../vendor/abox/tools/heic-to-jpg/src/example-data.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function smokeImageGaps({ call, client, workspace }) {
  const sources = new Map(), covered = [];
  const source = async (name, data) => { const file = path.join(workspace, name); await writeFile(file, data, { flag: 'wx' }); sources.set(file, hash(data)); return file; };
  const heic = await source('offline tiled iPhone.heic', Buffer.from(BYTES, 'base64'));
  const avif = await source('offline AVIF colors.avif', await readFile(new URL('../tests/fixtures/avif/colors_sdr_srgb.avif', import.meta.url)));
  for (const [name, args, width, height] of [
    ['abox_heic_convert', { input_path: heic, output_dir: path.join(workspace, 'offline converted HEIC'), format: 'png' }, 4032, 3024],
    ['abox_avif_convert', { input_path: avif, output_path: path.join(workspace, 'offline converted AVIF.png'), format: 'png' }, 200, 200],
  ]) {
    const result = await call(client, name, args); covered.push(name);
    assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.outputs.length, 1);
    assert.equal(result.verification.codec_geometry_admitted_before_decode, true);
    assert.equal(result.verification.all_output_pixels_compared, true); assert.equal(result.verification.metadata_copied, false);
    assert.equal(result.outputs[0].width, width); assert.equal(result.outputs[0].height, height); assert.equal(result.outputs[0].pixel_mean_absolute_error, 0);
    assert.equal(Object.hasOwn(result.outputs[0], 'data'), false);
    const made = await readFile(result.outputs[0].output_path);
    assert.equal(made.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(made.readUInt32BE(16), width); assert.equal(made.readUInt32BE(20), height);
  }
  for (const [filename, expected] of sources) assert.equal(hash(await readFile(filename)), expected);
  return { tools: covered, bundled_heic_decoder: true, all_png_pixels_compared: true, runtime_downloads: false, capability_absences: [] };
}
