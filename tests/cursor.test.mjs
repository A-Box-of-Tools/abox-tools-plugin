import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultAdapterRoot, resolveCursorAdapter } from '../scripts/cursor-mcp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const project = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const labels = { win32: 'windows', linux: 'linux', darwin: 'macos' };

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function fixture(t, { deferCleanup = false } = {}) {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-cursor-test-')));
  const cleanup = () => rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!deferCleanup) t.after(cleanup);
  const root = path.join(workspace, "adapter cache Québec & O'Brien");
  const runtime = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const entry = path.join(root, 'bin', 'abox-mcp.mjs');
  await mkdir(path.dirname(runtime), { recursive: true });
  await mkdir(path.dirname(entry));
  try {
    if (process.platform === 'win32') await copyFile(process.execPath, runtime);
    else await link(process.execPath, runtime);
  }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    await copyFile(process.execPath, runtime);
  }
  // The fixture launches the real MCP server. Its deliberately small receipt
  // makes cache safety tests independent of the release download and network.
  const entryBytes = `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'bin', 'abox-mcp.mjs')).href)});\n`;
  await writeFile(entry, entryBytes);
  await writeFile(path.join(root, 'bin', 'abox.mjs'), 'export {};\n');
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ version: project.version, type: 'module' })}\n`);
  const runtimeHash = await hashFile(runtime);
  await writeFile(path.join(root, 'BUNDLE.json'), `${JSON.stringify({
    version: project.version, platform: process.platform, arch: process.arch, runtime_sha256: runtimeHash,
  })}\n`);
  const files = {};
  for (const relative of [`runtime/${path.basename(runtime)}`, 'bin/abox-mcp.mjs', 'bin/abox.mjs', 'package.json', 'BUNDLE.json']) {
    files[relative] = await hashFile(path.join(root, ...relative.split('/')));
  }
  const receipt = {
    schema_version: 1, version: project.version, platform: process.platform, arch: process.arch,
    archive: `abox-tools-${project.version}-${labels[process.platform]}-${process.arch}.zip`,
    archive_sha256: 'a'.repeat(64), files,
  };
  const receiptPath = path.join(root, 'INSTALL.json');
  const saveReceipt = value => writeFile(receiptPath, `${JSON.stringify(value)}\n`);
  await saveReceipt(receipt);
  return { workspace, root, runtime, entry, entryBytes, receipt, saveReceipt, cleanup };
}

test('Cursor has an explicit client config while Codex keeps its standard root variable', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, '.cursor-plugin', 'plugin.json'), 'utf8'));
  const cursor = JSON.parse(await readFile(path.join(ROOT, 'cursor-mcp.json'), 'utf8'));
  const codex = JSON.parse(await readFile(path.join(ROOT, 'mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'abox-tools');
  assert.equal(manifest.version, project.version);
  assert.equal(manifest.author.name, 'Abox Technologies');
  assert.equal(manifest.publisher, 'Abox Technologies');
  assert.equal(manifest.mcpServers, './cursor-mcp.json');
  assert.equal(cursor.mcpServers.abox.command, 'node');
  assert.deepEqual(cursor.mcpServers.abox.args, ['${CURSOR_PLUGIN_ROOT}/scripts/cursor-mcp.mjs']);
  assert.equal(cursor.mcpServers.abox.cwd, '${CURSOR_PLUGIN_ROOT}');
  assert.deepEqual(codex.mcpServers.abox.args, ['${PLUGIN_ROOT}/bin/abox-mcp.mjs']);
  assert.equal(codex.mcpServers.abox.cwd, '${PLUGIN_ROOT}');
  assert.equal(manifest.hooks, undefined);
});

test('cache verification refuses changed files, extra files, mismatched versions, and escaping receipt paths', async t => {
  const made = await fixture(t);
  const options = { version: project.version, adapterRoot: made.root };
  assert.equal((await resolveCursorAdapter(options)).runtime, made.runtime);
  await writeFile(made.entry, 'throw new Error("Changed after setup");\n');
  await assert.rejects(resolveCursorAdapter(options), error => error.code === 'CURSOR_CACHE_INVALID' && /has changed/.test(error.message));
  await writeFile(made.entry, made.entryBytes);
  const extra = path.join(made.root, 'unverified.mjs');
  await writeFile(extra, 'export {};\n');
  await assert.rejects(resolveCursorAdapter(options), /missing or unexpected files/);
  await rm(extra);
  await made.saveReceipt({ ...made.receipt, version: '0.0.0' });
  await assert.rejects(resolveCursorAdapter(options), /does not match this plugin version/);
  await made.saveReceipt({ ...made.receipt, files: { ...made.receipt.files, '../outside': 'a'.repeat(64) } });
  await assert.rejects(resolveCursorAdapter(options), /invalid file inventory/);
  const missing = path.join(made.workspace, 'missing adapter');
  await assert.rejects(resolveCursorAdapter({ ...options, adapterRoot: missing }), error => error.code === 'CURSOR_SETUP_REQUIRED' && /setup skill/.test(error.message));
  await assert.rejects(resolveCursorAdapter({ ...options, adapterRoot: 'relative' }), /absolute local directory/);
  assert.equal(defaultAdapterRoot(project.version, { home: made.workspace }), path.join(made.workspace, '.abox-tools', 'adapters', project.version, `${process.platform}-${process.arch}`));
});

test('the offline Cursor launcher serves the real MCP server from a verified cache and unrelated cwd', { timeout: 60_000 }, async t => {
  const made = await fixture(t, { deferCleanup: true });
  let client;
  t.after(async () => {
    try { await client?.close(); }
    finally { await made.cleanup(); }
  });
  const cwd = path.join(made.workspace, 'unrelated working directory');
  await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['PATH', 'NODE_PATH', 'NODE_OPTIONS'].includes(name.toUpperCase())));
  env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'scripts', 'cursor-mcp.mjs'), '--adapter-root', made.root],
    cwd, env, stderr: 'pipe',
  });
  client = new Client({ name: 'abox-cursor-test', version: '1.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'abox_capabilities'));
  assert.ok(listed.tools.some(tool => tool.name === 'abox_pdf_split'));
  const response = await client.callTool({ name: 'abox_capabilities', arguments: {} });
  assert.ok(!response.isError);
  const result = JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.equal(result.version, project.version);
  assert.equal(result.publisher, 'Abox Technologies');
  assert.equal(result.processing, 'local-files-and-opt-in-live-sessions');
  assert.equal(result.operations.length, listed.tools.length - 1);
});
