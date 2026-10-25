#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { 'from-release': { type: 'boolean', default: false } },
  strict: true, allowPositionals: false });
const run = promisify(execFile);
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function pngChunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 'ascii');
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}
const config = await json(path.join(ROOT, '_release/build.json'));
assert.equal(config.platform, process.platform);
assert.equal(config.arch, process.arch);
const extracted = await realpath(config.gemini_smoke_root);
assert.match(config.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const installationSource = values['from-release']
  ? 'https://github.com/A-Box-of-Tools/abox-tools-plugin' : extracted;
const installationRef = values['from-release'] ? `v${config.version}` : null;
const cliRoot = path.join(ROOT, 'node_modules/@google/gemini-cli');
const cliPackage = await json(path.join(cliRoot, 'package.json'));
const cliBin = typeof cliPackage.bin === 'string' ? cliPackage.bin : cliPackage.bin.gemini;
assert.ok(cliBin, 'Install the pinned Gemini CLI development dependency before this smoke test.');
const parent = await realpath(tmpdir());
const work = await realpath(await mkdtemp(path.join(parent, 'abox-gemini-smoke-')));
let transport;
let client;
try {
  const home = path.join(work, 'isolated Gemini home');
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  // Only this disposable test home is configured. No user settings, credentials,
  // or installed extensions are read or changed by the CLI integration test.
  await writeFile(path.join(home, '.gemini/settings.json'), JSON.stringify({
    telemetry: { enabled: false }, security: { folderTrust: { enabled: false } },
  }));
  const systemSettings = path.join(home, 'isolated-system-settings.json');
  await writeFile(systemSettings, '{}\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP'].includes(name.toUpperCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings, CI: 'true', NO_COLOR: '1' });
  const invocation = [path.join(cliRoot, cliBin)];
  const installArgs = ['extensions', 'install', installationSource,
    ...(installationRef ? ['--ref', installationRef] : []), '--consent', '--skip-settings'];
  await run(process.execPath, [...invocation, ...installArgs], {
    cwd: work, env, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  const listed = await run(process.execPath, [...invocation, 'extensions', 'list'], {
    cwd: work, env, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  const listing = `${listed.stdout}\n${listed.stderr}`;
  assert.match(listing, /abox-tools/, `Gemini must recognize the installed extension. Output: ${listing.slice(0, 2000)}`);
  assert.match(listing, /abox-local-files/, `Gemini must discover the shared operation skill. Output: ${listing.slice(0, 2000)}`);
  const installed = await realpath(path.join(home, '.gemini/extensions/abox-tools'));
  assert.notEqual(installed, extracted, 'The host must copy the archive payload into its installation.');
  const manifest = await json(path.join(installed, 'gemini-extension.json'));
  assert.equal(manifest.version, config.version);
  assert.equal(manifest.name, 'abox-tools');
  const skill = 'skills/abox-local-files/SKILL.md';
  assert.equal(sha256(await readFile(path.join(installed, skill))), sha256(await readFile(path.join(extracted, skill))));
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const server = manifest.mcpServers.abox;
  assert.equal(server.command, '${extensionPath}/runtime/' + runtimeName);
  assert.deepEqual(server.args, ['${extensionPath}/bin/abox-mcp.mjs']);
  assert.equal(server.cwd, '${extensionPath}');
  const expand = value => value.replaceAll('${extensionPath}', installed);
  const command = expand(server.command);
  const metadata = await json(path.join(installed, 'BUNDLE.json'));
  assert.equal(metadata.version, config.version);
  assert.equal(metadata.platform, config.platform);
  assert.equal(metadata.arch, config.arch, 'Gemini must select the release archive for this architecture.');
  assert.equal(sha256(await readFile(command)), metadata.runtime_sha256);
  if (process.platform !== 'win32') assert.ok((await lstat(command)).mode & 0o111);
  const mcpEnv = { ...env, PATH: process.platform === 'win32' ? path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32') : '' };
  transport = new StdioClientTransport({ command, args: server.args.map(expand), cwd: expand(server.cwd), env: mcpEnv, stderr: 'pipe' });
  client = new Client({ name: 'abox-gemini-install-smoke', version: config.version });
  await client.connect(transport);
  const tools = await client.listTools();
  const capabilities = await client.callTool({ name: 'abox_capabilities', arguments: {} });
  assert.ok(!capabilities.isError);
  const data = capabilities.structuredContent;
  assert.equal(data.version, config.version);
  assert.equal(data.processing, 'local');
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['abox_capabilities', ...data.operations.map(operation => operation.name)].sort());
  // A real file operation catches entry-point and local-path errors that a
  // successful protocol handshake alone would miss. Full native smoke tests
  // independently exercise every operation before this host integration check.
  const source = path.join(work, 'sample.png');
  const output = path.join(work, 'clean.png');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0Gemini local setup smoke', 'ascii')),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 64, 128, 192, 255]))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(source, bytes);
  const result = await client.callTool({ name: 'abox_exif_remove', arguments: { input_path: source, output_path: output } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual((await readFile(output)).subarray(0, 8), bytes.subarray(0, 8));
  assert.equal(sha256(await readFile(source)), sha256(bytes));
  console.log(JSON.stringify({ ok: true, gemini_cli: cliPackage.version,
    installation_source: installationSource, installation_ref: installationRef,
    installed_version: config.version, tools: tools.tools.length, shared_skill: true,
    bundled_runtime: true, local_file_operation: true }));
} finally {
  if (client) await client.close().catch(() => {});
  if (transport) await transport.close().catch(() => {});
  assert.equal(await realpath(work), work);
  assert.equal(path.dirname(work), parent);
  assert.ok(path.basename(work).startsWith('abox-gemini-smoke-'));
  assert.ok(!(await lstat(work)).isSymbolicLink());
  await rm(work, { recursive: true, force: true });
}
