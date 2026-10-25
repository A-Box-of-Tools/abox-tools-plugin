#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { examplePdfFile } from '../vendor/abox/shared/js/example-pdf.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';

const runFile = promisify(execFile);
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const expectedTools = ['abox_capabilities', 'abox_exif_remove', 'abox_image_compress', 'abox_pdf_split'];

function parseArguments() {
  const args = process.argv.slice(2);
  if (!args.length) return fileURLToPath(new URL('../_release/build.json', import.meta.url));
  assert.equal(args.length, 2, 'Usage: node scripts/smoke-release.mjs [--config /absolute/build.json]');
  assert.equal(args[0], '--config', 'Only --config is supported.');
  assert.ok(path.isAbsolute(args[1]), '--config must be an absolute path.');
  return args[1];
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function cleanEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['PATH', 'NODE_PATH', 'NODE_OPTIONS'].includes(name.toUpperCase())));
  // Windows browser launchers still need OS helpers such as cmd.exe. Keep only
  // Windows itself on PATH; development runtimes and package managers stay out.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  env.PATH = process.platform === 'win32' ? [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter) : '';
  return env;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

function noisyPng() {
  const size = 256;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(size * (1 + size * 4));
  let random = 0x12345678;
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        pixels[pixel + channel] = random & 255;
      }
      pixels[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0Release smoke private annotation', 'ascii')),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunks(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'PNG chunk must remain in bounds.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + length + 8), crc32(bytes.subarray(offset + 4, offset + length + 8)));
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.equal(offset, bytes.length);
  return chunks;
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const block = response.content?.find(item => item.type === 'text');
  assert.ok(block, `${name} did not return JSON text.`);
  const result = JSON.parse(block.text);
  assert.ok(!response.isError, `${name} failed: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `${name} did not succeed.`);
  assert.deepEqual(response.structuredContent, result, `${name} structured and text results disagree.`);
  return result;
}

async function safeCleanup(workspace, tempParent) {
  const info = await lstat(workspace);
  assert.ok(!info.isSymbolicLink(), 'Refusing to remove a replaced smoke directory.');
  const canonical = await realpath(workspace);
  assert.equal(canonical, workspace);
  assert.equal(path.dirname(canonical), tempParent);
  assert.ok(path.basename(canonical).startsWith('abox-release-smoke-'));
  await rm(canonical, { recursive: true, force: true });
}

async function main() {
  const config = await jsonFile(parseArguments());
  assert.equal(config.version, expectedVersion);
  assert.equal(config.platform, process.platform, 'Run the smoke test on the bundle target platform.');
  assert.equal(config.arch, process.arch, 'Run the smoke test on the bundle target architecture.');
  assert.ok(path.isAbsolute(config.smoke_root), 'Archive the release before running its smoke test.');
  const bundle = await realpath(config.smoke_root);
  assert.ok(bundle.includes(' '), 'The extracted bundle path must contain a space to test relocation.');
  assert.notEqual(bundle, await realpath(config.root), 'Smoke testing must use the extracted payload.');
  const plugin = await jsonFile(path.join(bundle, 'plugin.json'));
  const manifest = await jsonFile(path.join(bundle, 'manifest.json'));
  const mcp = await jsonFile(path.join(bundle, 'mcp.json'));
  const metadata = await jsonFile(path.join(bundle, 'BUNDLE.json'));
  assert.equal(plugin.name, 'abox-tools');
  assert.equal(plugin.version, expectedVersion);
  assert.equal(manifest.name, plugin.name);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.platform, process.platform);
  assert.equal(metadata.arch, process.arch);
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const runtimeRelative = `runtime/${runtimeName}`;
  const runtime = path.join(bundle, 'runtime', runtimeName);
  const entry = path.join(bundle, 'bin', 'abox-mcp.mjs');
  assert.equal(manifest.server.type, 'binary');
  assert.equal(manifest.server.entry_point, runtimeRelative);
  assert.equal(manifest.server.mcp_config.command, '${__dirname}/' + runtimeRelative);
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/bin/abox-mcp.mjs']);
  assert.ok(!Object.hasOwn(manifest.server.mcp_config, 'cwd'), 'MCPB must not rely on a current directory.');
  assert.equal(mcp.mcpServers.abox.command, '${PLUGIN_ROOT}/' + runtimeRelative);
  assert.deepEqual(mcp.mcpServers.abox.args, ['${PLUGIN_ROOT}/bin/abox-mcp.mjs']);
  assert.equal(mcp.mcpServers.abox.cwd, '${PLUGIN_ROOT}');
  assert.ok(!(await lstat(runtime)).isSymbolicLink(), 'The bundled runtime must be a regular file.');
  if (process.platform !== 'win32') assert.ok((await lstat(runtime)).mode & 0o111, 'The bundled runtime lost its executable mode.');

  const tempParent = await realpath(tmpdir());
  const workspace = await realpath(await mkdtemp(path.join(tempParent, 'abox-release-smoke-')));
  assert.ok(!isInside(workspace, bundle), 'The child working directory must be unrelated to the bundle.');
  const env = cleanEnvironment();
  let client;
  let transport;
  try {
    const versionProbe = await runFile(runtime, ['--version'], { cwd: workspace, env, windowsHide: true, timeout: 15_000 });
    const runtimeVersion = versionProbe.stdout.trim();
    assert.match(runtimeVersion, /^v\d+\.\d+\.\d+$/);
    assert.equal(runtimeVersion.replace(/^v/, ''), metadata.node_version.replace(/^v/, ''));
    const probeCode = `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(pathToFileURL(${JSON.stringify(entry)}));console.log(JSON.stringify({runtime:process.execPath,sdk:require.resolve('@modelcontextprotocol/sdk/server/index.js'),path:process.env.PATH,node_path:process.env.NODE_PATH??null,node_options:process.env.NODE_OPTIONS??null}));`;
    const probe = JSON.parse((await runFile(runtime, ['--input-type=module', '--eval', probeCode], { cwd: workspace, env, windowsHide: true, timeout: 15_000 })).stdout);
    assert.equal(await realpath(probe.runtime), await realpath(runtime));
    assert.ok(isInside(await realpath(probe.sdk), bundle), 'MCP dependencies must resolve from the extracted bundle.');
    assert.equal(probe.path, env.PATH);
    assert.equal(probe.node_path, null);
    assert.equal(probe.node_options, null);

    transport = new StdioClientTransport({ command: runtime, args: [entry], cwd: workspace, env, stderr: 'pipe' });
    client = new Client({ name: 'abox-release-smoke', version: expectedVersion });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expectedTools);
    const capabilities = await call(client, 'abox_capabilities', {});
    assert.equal(capabilities.version, expectedVersion);
    assert.equal(capabilities.processing, 'local');
    assert.equal(capabilities.max_input_bytes, 128 * 1024 * 1024);
    assert.equal(capabilities.browser.available, true, 'Real compression requires an installed supported local browser.');

    const { chromium } = await import('playwright-core');
    const installerBrowser = await chromium.launch({ executablePath: capabilities.browser.path, headless: true, chromiumSandbox: true });
    try {
      const page = await installerBrowser.newPage();
      await page.goto(pathToFileURL(path.join(bundle, 'START-HERE.html')).href);
      const install = new URL(await page.locator('#install').getAttribute('href'));
      assert.equal(install.protocol, 'codex:');
      assert.equal(install.hostname, 'plugins');
      assert.equal(install.pathname, '/abox-tools');
      assert.equal(path.normalize(install.searchParams.get('marketplacePath')), path.join(bundle, '.agents', 'plugins', 'marketplace.json'));
    } finally {
      await installerBrowser.close();
    }

    const png = noisyPng();
    const imageInput = path.join(workspace, 'private input.png');
    const imageClean = path.join(workspace, 'metadata removed.png');
    const imageCompressed = path.join(workspace, 'compressed image.jpg');
    await writeFile(imageInput, png);
    const removed = await call(client, 'abox_exif_remove', {
      input_path: imageInput, output_path: imageClean, keep_orientation: false, keep_icc: false,
    });
    assert.equal(removed.verified, true);
    assert.equal(removed.output_path, imageClean);
    assert.equal(removed.after.exif_present, false);
    assert.equal(removed.after.icc_present, false);
    assert.equal(removed.after.xmp_present, false);
    const cleanedBytes = await readFile(imageClean);
    assert.equal(removed.output_bytes, cleanedBytes.length);
    const cleanedChunks = pngChunks(cleanedBytes);
    assert.deepEqual(cleanedChunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual(cleanedChunks.find(chunk => chunk.type === 'IDAT').data, pngChunks(png).find(chunk => chunk.type === 'IDAT').data);

    const targetBytes = 16_000;
    const compressed = await call(client, 'abox_image_compress', {
      input_path: imageInput, output_path: imageCompressed, target_bytes: targetBytes, format: 'jpeg', allow_resize: true,
    });
    assert.equal(compressed.verified, true);
    assert.equal(compressed.fitted, true);
    assert.equal(compressed.output_path, imageCompressed);
    assert.equal(compressed.mime, 'image/jpeg');
    assert.equal(compressed.target_bytes, targetBytes);
    const compressedBytes = await readFile(imageCompressed);
    assert.equal(compressed.output_bytes, compressedBytes.length);
    assert.ok(compressedBytes.length > 0 && compressedBytes.length <= targetBytes);
    assert.deepEqual(compressedBytes.subarray(0, 3), Buffer.from([255, 216, 255]));
    assert.ok(compressed.width > 0 && compressed.height > 0);
    assert.equal(hash(await readFile(imageInput)), hash(png));

    const pdfInput = path.join(workspace, 'three pages.pdf');
    const pdfOutput = path.join(workspace, 'split pages');
    const pdfFile = examplePdfFile('three pages.pdf', { pages: 3 });
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer());
    await writeFile(pdfInput, pdfBytes);
    const split = await call(client, 'abox_pdf_split', { input_path: pdfInput, output_dir: pdfOutput });
    assert.equal(split.verified, true);
    assert.equal(split.input_pages, 3);
    assert.equal(split.output_dir, pdfOutput);
    assert.equal(split.outputs.length, 3);
    const outputPaths = new Set();
    for (let index = 0; index < split.outputs.length; index++) {
      const output = split.outputs[index];
      assert.ok(path.isAbsolute(output.output_path));
      assert.equal(path.dirname(output.output_path), pdfOutput);
      assert.ok(!outputPaths.has(output.output_path));
      outputPaths.add(output.output_path);
      assert.equal(output.verified, true);
      assert.equal(output.page_count, 1);
      assert.deepEqual(output.pages, [index + 1]);
      const bytes = await readFile(output.output_path);
      assert.equal(bytes.length, output.output_bytes);
      assert.equal((await PdfDocument.open(new Uint8Array(bytes))).countPages(), 1);
    }
    assert.equal(hash(await readFile(pdfInput)), hash(pdfBytes));
    console.log(JSON.stringify({ ok: true, version: expectedVersion, runtime: runtimeVersion, platform: process.platform, arch: process.arch, tools: expectedTools, image_bytes: compressedBytes.length, image_target_bytes: targetBytes, pdf_outputs: split.outputs.length, relocated: true, system_node_required: false }));
  } finally {
    // On Windows the server may still hold browser or output handles until its
    // transport closes. Close it before removing the directory we created.
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } finally {
      await safeCleanup(workspace, tempParent);
    }
  }
}

main().catch(error => {
  console.error(`Release smoke failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
