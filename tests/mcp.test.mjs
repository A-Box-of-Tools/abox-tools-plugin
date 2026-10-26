import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin', 'abox.mjs');
const server = path.join(root, 'bin', 'abox-mcp.mjs');

async function workspace(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-protocol-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cliRun(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`CLI terminated with ${signal}: ${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
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

function privatePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0Private note', 'ascii')),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 128, 255, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('MCP initializes, advertises all operations, and returns structured local capabilities from an unrelated cwd', { timeout: 30_000 }, async t => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-protocol-test-')));
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd, stderr: 'pipe' });
  const client = new Client({ name: 'abox-integration-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'abox_capabilities', 'abox_exif_inspect', 'abox_exif_remove', 'abox_file_hash', 'abox_image_compress', 'abox_image_convert',
    'abox_image_resize', 'abox_image_to_ico', 'abox_images_to_pdf', 'abox_pdf_compress', 'abox_pdf_merge', 'abox_pdf_rotate', 'abox_pdf_select', 'abox_pdf_split', 'abox_pdf_watermark', 'abox_svg_to_image',
  ]);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.type, 'object');
  const result = await client.callTool({ name: 'abox_capabilities', arguments: {} });
  assert.ok(!result.isError);
  assert.ok(result.structuredContent);
  const text = result.content.find(item => item.type === 'text');
  assert.ok(text);
  const json = JSON.parse(text.text);
  assert.deepEqual(json, result.structuredContent);
  assert.equal(json.ok, true);
  assert.equal(json.processing, 'local');
  assert.equal(json.max_input_bytes, 128 * 1024 * 1024);
  assert.deepEqual(json.operations.map(operation => operation.name).sort(), listed.tools.map(tool => tool.name).filter(name => name !== 'abox_capabilities').sort());
  const rejected = await client.callTool({
    name: 'abox_exif_remove',
    arguments: { input_path: 'https://example.com/private.png', output_path: path.join(cwd, 'unused.png') },
  });
  assert.equal(rejected.isError, true);
  const error = JSON.parse(rejected.content.find(item => item.type === 'text').text);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'LOCAL_PATH_REQUIRED');
});

test('CLI capabilities works independently of the caller working directory', { timeout: 30_000 }, async t => {
  const cwd = await workspace(t);
  const result = await cliRun(['capabilities'], cwd);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.processing, 'local');
  assert.equal(json.operations.length, 15);
});

test('CLI processes a JSON request file and exposes machine-readable failure without overwriting files', { timeout: 30_000 }, async t => {
  const cwd = await workspace(t);
  const input = path.join(cwd, 'private.png');
  const output = path.join(cwd, 'clean.png');
  const requestFile = path.join(cwd, 'request.json');
  const original = privatePng();
  await writeFile(input, original);
  await writeFile(requestFile, JSON.stringify({ input_path: input, output_path: output }));
  const success = await cliRun(['remove-exif', '--request-file', requestFile], cwd);
  assert.equal(success.code, 0, success.stderr || success.stdout);
  const json = JSON.parse(success.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.output_path, output);
  assert.equal(json.verified, true);
  assert.ok((await readFile(output)).length < original.length);
  assert.deepEqual(await readFile(input), original);
  const written = await readFile(output);
  const failure = await cliRun(['remove-exif', '--request-file', requestFile], cwd);
  assert.equal(failure.code, 1);
  const error = JSON.parse(failure.stdout);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'OUTPUT_EXISTS');
  assert.equal(typeof error.error.message, 'string');
  assert.deepEqual(await readFile(output), written);
});
