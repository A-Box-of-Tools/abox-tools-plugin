import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectedAssets, verifyReleaseAssets } from '../scripts/publish-release.mjs';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

test('the publication gate verifies every platform asset and detects a changed download', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-release-assets-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = expectedAssets(version);
  for (const name of names.filter(name => !name.endsWith('.sha256'))) {
    const bytes = Buffer.from(`Fixture for ${name}`);
    await writeFile(path.join(dir, name), bytes);
    await writeFile(path.join(dir, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  assert.equal((await verifyReleaseAssets(version, dir)).length, 16);
  await writeFile(path.join(dir, names[0]), 'Changed after the checksum was recorded');
  await assert.rejects(verifyReleaseAssets(version, dir), /checksum does not match/);
});
