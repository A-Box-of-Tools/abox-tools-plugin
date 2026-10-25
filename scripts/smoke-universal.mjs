#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { smokeRelease } from './smoke-release.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
assert.equal(args.length, 0, 'Usage: node scripts/smoke-universal.mjs');
if (process.env.ABOX_EXPECT_PLATFORM) assert.equal(process.platform, process.env.ABOX_EXPECT_PLATFORM);
if (process.env.ABOX_EXPECT_ARCH) assert.equal(process.arch, process.env.ABOX_EXPECT_ARCH);
const archive = path.join(ROOT, 'release', `abox-tools-${version}-universal.mcpb`);
const tempParent = await realpath(tmpdir());
const work = await realpath(await mkdtemp(path.join(tempParent, 'abox-universal-smoke-')));
const extracted = path.join(work, 'extracted bundle');
try {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  await run(python, [path.join(ROOT, 'scripts', 'universal-archive.py'), 'extract', '--archive', archive, '--destination', extracted], { maxBuffer: 1024 * 1024 });
  await smokeRelease({ version, platform: process.platform, arch: process.arch, root: ROOT, smoke_root: extracted }, { universal: true });
} catch (error) {
  console.error(`Universal smoke failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  assert.ok(!(await lstat(work)).isSymbolicLink(), 'Refusing to remove a replaced smoke directory.');
  assert.equal(await realpath(work), work);
  assert.equal(path.dirname(work), tempParent);
  assert.ok(path.basename(work).startsWith('abox-universal-smoke-'));
  await rm(work, { recursive: true, force: true });
}
