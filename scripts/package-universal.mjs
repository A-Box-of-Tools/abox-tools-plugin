#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

export const macosLauncher = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")/.." && pwd)
case "$(/usr/bin/uname -m)" in
  arm64) runtime=macos-arm64 ;;
  x86_64) runtime=macos-x64 ;;
  *) printf '%s\\n' 'abox.tools does not support this macOS architecture.' >&2; exit 1 ;;
esac
exec "$root/runtime/$runtime/node" "$root/bin/abox-mcp.mjs" "$@"
`;

export function universalManifest(version) {
  return {
    manifest_version: '0.3', name: 'abox-tools', display_name: 'abox.tools', version,
    description: 'Resize, convert and compress images; merge, select and split PDFs; remove image metadata locally.',
    long_description: 'Published by Abox Technologies. Includes local Node runtimes for Windows x64, Linux x64, and macOS Intel and Apple silicon. File bytes stay local. Image processing, PDF compression and PDF watermark rendering need installed Edge, Chrome or Chromium; PDF page operations, metadata operations and checksums need no browser.',
    author: { name: 'Abox Technologies', url: 'https://github.com/A-Box-of-Tools' },
    homepage: 'https://abox.tools/',
    documentation: 'https://github.com/A-Box-of-Tools/abox-tools-plugin#readme',
    support: 'https://github.com/A-Box-of-Tools/abox-tools-plugin/issues',
    icon: 'assets/icon.png', license: 'MIT',
    server: {
      type: 'binary', entry_point: 'runtime/windows-x64/node.exe',
      mcp_config: {
        command: '${__dirname}/runtime/windows-x64/node.exe',
        args: ['${__dirname}/bin/abox-mcp.mjs'],
        platform_overrides: {
          linux: { command: '${__dirname}/runtime/linux-x64/node', args: ['${__dirname}/bin/abox-mcp.mjs'] },
          darwin: { command: '/bin/sh', args: ['${__dirname}/scripts/launch-macos.sh'] },
        },
      },
    },
    compatibility: { platforms: ['win32', 'linux', 'darwin'] },
  };
}

export async function packageUniversal() {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/package-universal.mjs');
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  const revision = stdout.trim();
  if (process.env.GITHUB_SHA) assert.equal(revision, process.env.GITHUB_SHA, 'CI must package the checked-out workflow commit.');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const helper = path.join(ROOT, 'scripts', 'universal-archive.py');
  const payload = path.join(ROOT, '_release', `abox-tools-${version}-universal`);
  await run(python, [helper, 'prepare', '--inputs', path.join(ROOT, 'release'), '--destination', payload, '--version', version, '--revision', revision], { maxBuffer: 1024 * 1024 });
  await writeFile(path.join(payload, 'manifest.json'), `${JSON.stringify(universalManifest(version), null, 2)}\n`, { flag: 'wx' });
  const launcher = path.join(payload, 'scripts', 'launch-macos.sh');
  await writeFile(launcher, macosLauncher, { flag: 'wx' });
  await chmod(launcher, 0o755);
  const validatorRoot = path.join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb');
  const validator = JSON.parse(await readFile(path.join(validatorRoot, 'package.json'), 'utf8'));
  const bin = typeof validator.bin === 'string' ? validator.bin : validator.bin.mcpb;
  const validation = await run(process.execPath, [path.join(validatorRoot, bin), 'validate', path.join(payload, 'manifest.json')], { maxBuffer: 1024 * 1024 });
  process.stdout.write(validation.stdout);
  const output = path.join(ROOT, 'release', `abox-tools-${version}-universal.mcpb`);
  await run(python, [helper, 'finalize', '--root', payload, '--output', output], { maxBuffer: 1024 * 1024 });
  console.log(JSON.stringify({ ok: true, version, output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await packageUniversal(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
