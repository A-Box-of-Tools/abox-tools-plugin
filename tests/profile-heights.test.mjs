import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewBusinessProfile, compareHeights, MAX_PREVIEW_CONFIG_BYTES } from '../src/profile-heights.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-profile-heights-bounds-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
test('preview exporters refuse invalid paths, formats, configuration shapes, duplicate keys and unsafe references', async t => {
  const directory = await workspace(t), config = path.join(directory, 'private.json');
  for (const [operation, examples] of [
    [previewBusinessProfile, [null, {}, { profile: {} }, { profile: { status: null } },
      { profile: { status: 'open24', photo: 'https://example.invalid/private' } },
      { profile: { status: 'open24', name: '\u0001private' } }, { profile: { status: 'open24', name: '\ud800' } },
      { profile: { status: 'open24', rating: 6 } }, { profile: { status: 'open24', reviews: '-1' } },
      { profile: { status: 'open24' }, surface: 'unknown' }, { profile: { status: 'auto', hours: [] } },
      { profile: { status: 'open24', hours: Array(7).fill({ closed: false, open: '25:00', close: '17:00' }) } }]],
    [compareHeights, [null, {}, { figures: [] }, { figures: Array(21).fill({ height: '173cm' }) },
      { figures: [{ height: '173cm', shape: 'uploaded' }] }, { figures: [{ height: '173cm', markup: '<script/>' }] },
      { figures: [{ height: '173cm', color: 'url(file:///private)' }] }, { figures: [{ height: '173cm', width: '60cm' }] },
      { figures: [{ height: '173cm', name: '\u0000private' }] }, { figures: [{ height: '173cm' }], unit: 'm' },
      { figures: [{ height: '173cm' }], plot_height: 1201 }, { figures: [{ height: '173cm' }], background: 'transparent' }]],
  ]) {
    for (const [index, value] of examples.entries()) {
      await writeFile(config, JSON.stringify(value)); const output = path.join(directory, `${operation.name}-${index}.png`);
      await assert.rejects(operation({ config_path: config, output_path: output }), error => {
        assert.equal(error.code, 'INVALID_CONFIG'); assert.ok(!String(error).includes('private')); return true;
      });
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    }
    await writeFile(config, '{"private":"value","private":2}');
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, `${operation.name}-duplicate.png`) }), { code: 'INVALID_CONFIG' });
    await writeFile(config, '['.repeat(9) + '0' + ']'.repeat(9));
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, `${operation.name}-depth.png`) }), { code: 'INVALID_CONFIG' });
    await writeFile(config, Buffer.from([0xff]));
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, `${operation.name}-encoding.png`) }), { code: 'INVALID_UTF8' });
    await writeFile(config, ' '.repeat(MAX_PREVIEW_CONFIG_BYTES + 1));
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, `${operation.name}-size.png`) }), { code: 'INPUT_SIZE' });
    await assert.rejects(operation({ config_path: 'https://example.invalid/private', output_path: path.join(directory, 'url.png') }), { code: 'LOCAL_PATH_REQUIRED' });
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, 'wrong.svg') }), { code: 'OUTPUT_EXTENSION' });
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, 'scale.svg'), format: 'svg', scale: 2 }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(operation({ config_path: config, output_path: path.join(directory, 'cancel.png') }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  }
});

test('new preview output locations are never overwritten', async t => {
  const directory = await workspace(t), output = path.join(directory, 'keep.png'); await writeFile(output, 'existing');
  for (const operation of [previewBusinessProfile, compareHeights]) {
    await assert.rejects(operation({ config_path: path.join(directory, 'absent.json'), output_path: output }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(output, 'utf8'), 'existing');
  }
});
