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
    const checksum = /^(win32|linux|darwin)\./.test(name) ? `checksums.${name}.sha256` : `${name}.sha256`;
    await writeFile(path.join(dir, checksum), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  assert.equal((await verifyReleaseAssets(version, dir)).length, 26);
  assert.ok(names.includes(`abox-tools-${version}-universal.mcpb`));
  assert.ok(names.includes(`abox-tools-${version}-universal.mcpb.sha256`));
  for (const target of ['win32.x64', 'linux.x64', 'darwin.arm64', 'darwin.x64']) {
    assert.ok(names.includes(`${target}.abox-tools.zip`));
    assert.ok(names.includes(`checksums.${target}.abox-tools.zip.sha256`));
    assert.deepEqual(names.filter(name => name.startsWith(`${target}.`)), [`${target}.abox-tools.zip`], 'Gemini must never select a checksum instead of its platform archive.');
  }
  await writeFile(path.join(dir, names[0]), 'Changed after the checksum was recorded');
  await assert.rejects(verifyReleaseAssets(version, dir), /checksum does not match/);
});
