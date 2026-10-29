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
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { smokeNewTools } from './smoke-new-tools.mjs';
import { smokeImageGaps } from './smoke-image-gaps.mjs';
import { smokeAudioGaps } from './smoke-audio-gaps.mjs';
import { smokeDocumentGaps } from './smoke-document-gaps.mjs';
import { smokeVideoGaps } from './smoke-video-gaps.mjs';
import { smokeLive } from './smoke-live.mjs';

const runFile = promisify(execFile);
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const expectedTools = [
  'abox_share_session', 'abox_camera_session', 'abox_walkie_session', 'abox_voice_oncall_session', 'abox_live_status', 'abox_live_stop',
  'abox_barcode_generate', 'abox_base64', 'abox_capabilities', 'abox_exif_inspect', 'abox_exif_remove', 'abox_file_hash', 'abox_gif_inspect', 'abox_gif_split',
  'abox_image_compress', 'abox_image_convert', 'abox_image_data_uri', 'abox_image_layout', 'abox_image_redact', 'abox_image_resize', 'abox_image_stack', 'abox_image_to_ico', 'abox_image_trace', 'abox_images_to_pdf', 'abox_json_format', 'abox_password_generate',
  'abox_pdf_compress', 'abox_pdf_merge', 'abox_pdf_rotate', 'abox_pdf_select', 'abox_pdf_split', 'abox_pdf_to_csv', 'abox_pdf_watermark', 'abox_qr_generate', 'abox_svg_to_image', 'abox_text_diff', 'abox_xml_format', 'abox_yaml_json',
    'abox_code_read', 'abox_gif_create', 'abox_pdf_protect', 'abox_pdf_unlock', 'abox_audio_edit', 'abox_audio_trim',
    'abox_exif_edit',
    'abox_video_rotate', 'abox_video_remux',
    'abox_code_format', 'abox_xml_json', 'abox_markdown_html',
    'abox_heic_convert', 'abox_avif_convert', 'abox_pdf_redact', 'abox_audio_extract',
    'abox_video_compress', 'abox_video_crop', 'abox_video_frame', 'abox_video_reverse', 'abox_video_timelapse', 'abox_video_to_gif', 'abox_video_rotate_bake',
    'abox_video_inspect', 'abox_video_trim', 'abox_video_join', 'abox_document_scan', 'abox_id_photo', 'abox_business_profile',
    'abox_height_compare', 'abox_receipt_extract', 'abox_dicom_inspect', 'abox_dicom_render', 'abox_images_to_video', 'abox_gif_to_mp4',
].sort();
const expectedPublisher = 'Abox Technologies';

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

function webpDimensions(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let dimensions;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + length <= bytes.length, 'WebP chunk must remain in bounds.');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let found;
    if (type === 'VP8X') {
      assert.ok(data.length >= 10);
      found = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
    } else if (type === 'VP8 ') {
      assert.ok(data.length >= 10);
      assert.deepEqual(data.subarray(3, 6), Buffer.from([0x9d, 0x01, 0x2a]));
      found = { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    } else if (type === 'VP8L') {
      assert.ok(data.length >= 5);
      assert.equal(data[0], 0x2f);
      const bits = data.readUInt32LE(1);
      found = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (found) {
      if (dimensions) assert.deepEqual(found, dimensions);
      dimensions = found;
    }
    offset += 8 + length + (length & 1);
  }
  assert.equal(offset, bytes.length);
  assert.ok(dimensions, 'WebP output must include dimensions in a supported image chunk.');
  return dimensions;
}

async function pdfPageFingerprints(bytes) {
  const document = await PdfDocument.open(new Uint8Array(bytes));
  const source = readSource(document, 'Smoke fixture');
  assert.equal(source.pages.length, document.countPages());
  return Promise.all(source.pages.map(async page => {
    const contents = document.resolve(page.dict.get('Contents'));
    const streams = Array.isArray(contents) ? contents.map(item => document.resolve(item)) : [contents];
    assert.ok(streams.length > 0, 'Fixture pages must have visible content.');
    const decoded = [];
    for (const stream of streams) {
      assert.ok(stream?.dict instanceof Map && stream.raw instanceof Uint8Array, 'Page content must resolve to a stream.');
      const result = await decodeStream(stream, item => document.resolve(item));
      assert.deepEqual(result.remaining, []);
      decoded.push(Buffer.from(result.bytes));
    }
    return hash(Buffer.concat(decoded));
  }));
}

async function tablePdfBytes() {
  const rows = [
    ['Date', '@Description', 'Amount', 'Balance'],
    ['03/04/2026', 'Opening', '0.00', '1000.00'],
    ['04/04/2026', 'Coffee, cafe', '-10.00', '990.00'],
    ['05/04/2026', 'Refund', '20.00', '1010.00'],
    ['06/04/2026', '=SUM(1,2)', '-5.00', '1005.00'],
    ['07/04/2026', 'Final', '1.00', '1006.00'],
  ];
  const writer = new PdfWriter();
  const catalog = writer.reserve(), tree = writer.reserve(), font = writer.reserve();
  const page = writer.reserve(), content = writer.reserve();
  const x = [40, 150, 340, 450];
  const literal = value => value.replace(/[\\()]/g, char => `\\${char}`);
  const drawing = rows.map((row, index) => row.map((cell, column) =>
    `BT /F1 10 Tf 1 0 0 1 ${x[column]} ${720 - index * 18} Tm (${literal(cell)}) Tj ET`).join('\n')).join('\n');
  writer.object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  writer.stream(content, '', new TextEncoder().encode(drawing));
  writer.object(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  writer.object(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  return Buffer.from(await writer.finish({ root: catalog }).arrayBuffer());
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

export async function smokeRelease(config, { universal = false } = {}) {
  assert.equal(config.version, expectedVersion);
  assert.equal(config.platform, process.platform, 'Run the smoke test on the bundle target platform.');
  assert.equal(config.arch, process.arch, 'Run the smoke test on the bundle target architecture.');
  assert.ok(path.isAbsolute(config.smoke_root), 'Archive the release before running its smoke test.');
  const bundle = await realpath(config.smoke_root);
  assert.ok(bundle.includes(' '), 'The extracted bundle path must contain a space to test relocation.');
  assert.notEqual(bundle, await realpath(config.root), 'Smoke testing must use the extracted payload.');
  const manifest = await jsonFile(path.join(bundle, 'manifest.json'));
  const metadata = await jsonFile(path.join(bundle, 'BUNDLE.json'));
  assert.equal(manifest.name, 'abox-tools');
  assert.equal(manifest.author.name, expectedPublisher);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(metadata.version, expectedVersion);
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const labels = { win32: 'windows', linux: 'linux', darwin: 'macos' };
  const runtimeLabel = `${labels[process.platform]}-${process.arch}`;
  const runtimeRelative = universal ? `runtime/${runtimeLabel}/${runtimeName}` : `runtime/${runtimeName}`;
  const runtime = path.join(bundle, ...runtimeRelative.split('/'));
  const entry = path.join(bundle, 'bin', 'abox-mcp.mjs');
  assert.equal(manifest.server.type, 'binary');
  assert.ok(!Object.hasOwn(manifest.server.mcp_config, 'cwd'), 'MCPB must not rely on a current directory.');
  let receipt = metadata;
  if (universal) {
    assert.equal(metadata.kind, 'universal-mcpb');
    assert.equal(manifest.server.entry_point, 'runtime/windows-x64/node.exe');
    assert.deepEqual(manifest.compatibility.platforms, ['win32', 'linux', 'darwin']);
    assert.equal(manifest.author.url, 'https://github.com/A-Box-of-Tools');
    receipt = metadata.runtimes[runtimeLabel];
    assert.ok(receipt, 'Universal bundle lacks this platform and architecture.');
    assert.equal(hash(await readFile(runtime)), receipt.runtime_sha256);
    const override = manifest.server.mcp_config.platform_overrides?.[process.platform];
    if (process.platform === 'darwin') {
      assert.equal(override.command, '/bin/sh');
      assert.deepEqual(override.args, ['${__dirname}/scripts/launch-macos.sh']);
      assert.ok((await lstat(path.join(bundle, 'scripts', 'launch-macos.sh'))).mode & 0o111);
    } else {
      assert.equal((override ?? manifest.server.mcp_config).command, '${__dirname}/' + runtimeRelative);
    }
  } else {
    const plugin = await jsonFile(path.join(bundle, 'plugin.json'));
    const mcp = await jsonFile(path.join(bundle, 'mcp.json'));
    const cursorPlugin = await jsonFile(path.join(bundle, '.cursor-plugin', 'plugin.json'));
    const cursorMcp = await jsonFile(path.join(bundle, 'cursor-mcp.json'));
    assert.equal(plugin.name, 'abox-tools');
    assert.equal(plugin.version, expectedVersion);
    assert.equal(plugin.author.name, expectedPublisher);
    assert.equal(plugin.extensions['com.openai'].interface.developerName, expectedPublisher);
    assert.equal(manifest.server.entry_point, runtimeRelative);
    assert.equal(manifest.server.mcp_config.command, '${__dirname}/' + runtimeRelative);
    assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/bin/abox-mcp.mjs']);
    assert.equal(mcp.mcpServers.abox.command, '${PLUGIN_ROOT}/' + runtimeRelative);
    assert.deepEqual(mcp.mcpServers.abox.args, ['${PLUGIN_ROOT}/bin/abox-mcp.mjs']);
    assert.equal(mcp.mcpServers.abox.cwd, '${PLUGIN_ROOT}');
    assert.equal(cursorPlugin.name, 'abox-tools');
    assert.equal(cursorPlugin.version, expectedVersion);
    assert.equal(cursorPlugin.author.name, expectedPublisher);
    assert.equal(cursorPlugin.publisher, expectedPublisher);
    assert.equal(cursorPlugin.mcpServers, './cursor-mcp.json');
    assert.equal(cursorMcp.mcpServers.abox.command, '${CURSOR_PLUGIN_ROOT}/' + runtimeRelative);
    assert.deepEqual(cursorMcp.mcpServers.abox.args, ['${CURSOR_PLUGIN_ROOT}/bin/abox-mcp.mjs']);
    assert.equal(cursorMcp.mcpServers.abox.cwd, '${CURSOR_PLUGIN_ROOT}');
  }
  assert.equal(receipt.platform, process.platform);
  assert.equal(receipt.arch, process.arch);
  const override = manifest.server.mcp_config.platform_overrides?.[process.platform];
  const launch = { ...manifest.server.mcp_config, ...override };
  const expand = value => value.replaceAll('${__dirname}', bundle);
  const command = expand(launch.command);
  const args = launch.args.map(expand);
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
    assert.equal(runtimeVersion.replace(/^v/, ''), receipt.node_version.replace(/^v/, ''));
    const probeCode = `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(pathToFileURL(${JSON.stringify(entry)}));console.log(JSON.stringify({runtime:process.execPath,sdk:require.resolve('@modelcontextprotocol/sdk/server/index.js'),path:process.env.PATH,node_path:process.env.NODE_PATH??null,node_options:process.env.NODE_OPTIONS??null}));`;
    const probe = JSON.parse((await runFile(runtime, ['--input-type=module', '--eval', probeCode], { cwd: workspace, env, windowsHide: true, timeout: 15_000 })).stdout);
    assert.equal(await realpath(probe.runtime), await realpath(runtime));
    assert.ok(isInside(await realpath(probe.sdk), bundle), 'MCP dependencies must resolve from the extracted bundle.');
    assert.equal(probe.path, env.PATH);
    assert.equal(probe.node_path, null);
    assert.equal(probe.node_options, null);

    transport = new StdioClientTransport({ command, args, cwd: workspace, env, stderr: 'pipe' });
    client = new Client({ name: 'abox-release-smoke', version: expectedVersion });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expectedTools);
    const capabilities = await call(client, 'abox_capabilities', {});
    assert.equal(capabilities.version, expectedVersion);
    assert.equal(capabilities.processing, 'local-files-and-opt-in-live-sessions');
    assert.equal(capabilities.max_input_bytes, 128 * 1024 * 1024);
    assert.deepEqual(capabilities.operations.map(operation => operation.name).sort(), expectedTools.filter(name => name !== 'abox_capabilities'));
    assert.equal(capabilities.browser.available, true, 'Real compression requires an installed supported local browser.');

    if (!universal) {
      const { chromium } = await import('playwright-core');
      const installerBrowser = await chromium.launch({ executablePath: capabilities.browser.path, headless: true, chromiumSandbox: true });
      let cursorConfig, vscodeConfig;
      try {
        const page = await installerBrowser.newPage();
        await page.goto(pathToFileURL(path.join(bundle, 'START-HERE.html')).href);
        const install = new URL(await page.locator('#install').getAttribute('href'));
        assert.equal(install.protocol, 'codex:');
        assert.equal(install.hostname, 'plugins');
        assert.equal(install.pathname, '/abox-tools');
        assert.equal(path.normalize(install.searchParams.get('marketplacePath')), path.join(bundle, '.agents', 'plugins', 'marketplace.json'));
        const cursor = new URL(await page.locator('#install-cursor').getAttribute('href'));
        assert.equal(cursor.protocol, 'cursor:');
        assert.equal(cursor.hostname, 'anysphere.cursor-deeplink');
        assert.equal(cursor.pathname, '/mcp/install');
        assert.equal(cursor.searchParams.get('name'), 'abox-tools');
        cursorConfig = JSON.parse(Buffer.from(cursor.searchParams.get('config'), 'base64').toString('utf8'));
        assert.deepEqual(Object.keys(cursorConfig).sort(), ['args', 'command', 'type']);
        assert.equal(cursorConfig.type, 'stdio');
        assert.equal(path.normalize(cursorConfig.command), runtime);
        assert.deepEqual(cursorConfig.args.map(argument => path.normalize(argument)), [entry]);
        const vscode = new URL(await page.locator('#install-vscode').getAttribute('href'));
        assert.equal(vscode.protocol, 'vscode:');
        assert.equal(vscode.pathname, 'mcp/install');
        assert.equal(vscode.hash, '');
        vscodeConfig = JSON.parse(decodeURIComponent(vscode.search.slice(1)));
        assert.deepEqual(Object.keys(vscodeConfig).sort(), ['args', 'command', 'name', 'type']);
        assert.equal(vscodeConfig.name, 'abox-tools');
        assert.equal(vscodeConfig.type, 'stdio');
        assert.equal(path.normalize(vscodeConfig.command), runtime);
        assert.deepEqual(vscodeConfig.args.map(argument => path.normalize(argument)), [entry]);
      } finally {
        await installerBrowser.close();
      }
      for (const [label, installed] of [['cursor', cursorConfig], ['vscode', vscodeConfig]]) {
        const installedClient = new Client({ name: `abox-${label}-release-smoke`, version: expectedVersion });
        try {
          await installedClient.connect(new StdioClientTransport({ command: installed.command, args: installed.args, cwd: workspace, env, stderr: 'pipe' }));
          const installedCapabilities = await call(installedClient, 'abox_capabilities', {});
          assert.equal(installedCapabilities.version, expectedVersion);
          assert.equal(installedCapabilities.publisher, expectedPublisher);
          assert.deepEqual(installedCapabilities.operations.map(operation => operation.name).sort(), expectedTools.filter(name => name !== 'abox_capabilities'));
        } finally {
          await installedClient.close();
        }
      }
    }

    const png = noisyPng();
    const imageInput = path.join(workspace, 'private input.png');
    const imageClean = path.join(workspace, 'metadata removed.png');
    const imageCompressed = path.join(workspace, 'compressed image.jpg');
    await writeFile(imageInput, png);
    const inspected = await call(client, 'abox_exif_inspect', { input_path: imageInput });
    assert.equal(inspected.format, 'png');
    assert.ok(inspected.metadata.text_chunks > 0);
    assert.ok(!JSON.stringify(inspected).includes('Private note'));
    const checksums = await call(client, 'abox_file_hash', { input_path: imageInput, algorithms: ['sha256', 'sha512'] });
    assert.equal(checksums.hashes.sha256, hash(png));
    assert.equal(checksums.hashes.sha512, createHash('sha512').update(png).digest('hex'));
    assert.equal(checksums.input_bytes, png.length);
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

    const imageResized = path.join(workspace, 'resized image.png');
    const resized = await call(client, 'abox_image_resize', {
      input_path: imageInput, output_path: imageResized, width: 96, height: 64,
      fit: 'contain', allow_upscale: false, format: 'png',
    });
    assert.equal(resized.verified, true);
    assert.equal(resized.output_path, imageResized);
    assert.equal(resized.mime, 'image/png');
    assert.equal(resized.format, 'png');
    assert.equal(resized.input_width, 256);
    assert.equal(resized.input_height, 256);
    assert.equal(resized.width, 64);
    assert.equal(resized.height, 64);
    const resizedBytes = await readFile(imageResized);
    assert.equal(resized.output_bytes, resizedBytes.length);
    const resizedHeader = pngChunks(resizedBytes).find(chunk => chunk.type === 'IHDR').data;
    assert.equal(resizedHeader.readUInt32BE(0), 64);
    assert.equal(resizedHeader.readUInt32BE(4), 64);

    const imageConverted = path.join(workspace, 'converted image.webp');
    const converted = await call(client, 'abox_image_convert', {
      input_path: imageResized, output_path: imageConverted, format: 'webp', quality: 0.82,
    });
    assert.equal(converted.verified, true);
    assert.equal(converted.output_path, imageConverted);
    assert.equal(converted.mime, 'image/webp');
    assert.equal(converted.format, 'webp');
    assert.equal(converted.input_width, 64);
    assert.equal(converted.input_height, 64);
    assert.equal(converted.width, 64);
    assert.equal(converted.height, 64);
    assert.equal(typeof converted.lossless, 'boolean');
    const convertedBytes = await readFile(imageConverted);
    assert.equal(converted.output_bytes, convertedBytes.length);
    assert.deepEqual(webpDimensions(convertedBytes), { width: 64, height: 64 });
    assert.equal(hash(await readFile(imageResized)), hash(resizedBytes));
    assert.equal(hash(await readFile(imageInput)), hash(png));

    const pdfInput = path.join(workspace, 'three pages.pdf');
    const pdfOutput = path.join(workspace, 'split pages');
    const pdfFile = examplePdfFile('three pages.pdf', { pages: 3 });
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer());
    const originalPages = await pdfPageFingerprints(pdfBytes);
    assert.equal(new Set(originalPages).size, 3, 'The PDF fixture must distinguish page order.');
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
      assert.deepEqual(await pdfPageFingerprints(bytes), [originalPages[index]]);
    }

    const secondPdfInput = path.join(workspace, 'two pages.pdf');
    const secondPdf = examplePdfFile('two pages.pdf', { pages: 2 });
    const secondPdfBytes = Buffer.from(await secondPdf.arrayBuffer());
    const secondPages = await pdfPageFingerprints(secondPdfBytes);
    await writeFile(secondPdfInput, secondPdfBytes);
    const mergedOutput = path.join(workspace, 'merged statements.pdf');
    const merged = await call(client, 'abox_pdf_merge', {
      input_paths: [pdfInput, secondPdfInput], output_path: mergedOutput, keep_bookmarks: true,
    });
    assert.equal(merged.verified, true);
    assert.equal(merged.output_path, mergedOutput);
    assert.equal(merged.page_count, 5);
    const mergedBytes = await readFile(mergedOutput);
    assert.equal(merged.output_bytes, mergedBytes.length);
    assert.deepEqual(await pdfPageFingerprints(mergedBytes), [...originalPages, ...secondPages]);

    const selectedOutput = path.join(workspace, 'reordered statements.pdf');
    const selected = await call(client, 'abox_pdf_select', {
      input_path: pdfInput, output_path: selectedOutput, pages: '3,1-2,3', keep_bookmarks: true,
    });
    assert.equal(selected.verified, true);
    assert.equal(selected.output_path, selectedOutput);
    assert.equal(selected.page_count, 4);
    assert.deepEqual(selected.page_order, [3, 1, 2, 3]);
    assert.equal(selected.page_order_truncated, false);
    const selectedBytes = await readFile(selectedOutput);
    assert.equal(selected.output_bytes, selectedBytes.length);
    assert.deepEqual(await pdfPageFingerprints(selectedBytes), [originalPages[2], originalPages[0], originalPages[1], originalPages[2]]);

    const rotatedOutput = path.join(workspace, 'rotated statements.pdf');
    const rotated = await call(client, 'abox_pdf_rotate', {
      input_path: pdfInput, output_path: rotatedOutput, degrees: 90, pages: '2', keep_bookmarks: true,
    });
    assert.equal(rotated.verified, true);
    assert.equal(rotated.rotation_verified, true);
    assert.equal(rotated.page_count, 3);
    assert.equal(rotated.rotated_page_count, 1);
    assert.deepEqual(rotated.rotated_pages, [2]);
    const rotatedBytes = await readFile(rotatedOutput);
    assert.equal(rotated.output_bytes, rotatedBytes.length);
    const rotatedDoc = await PdfDocument.open(new Uint8Array(rotatedBytes));
    assert.deepEqual(readSource(rotatedDoc, 'Rotated smoke fixture').pages.map(page => page.rotate), [0, 90, 0]);
    assert.deepEqual(await pdfPageFingerprints(rotatedBytes), originalPages);

    const picturesOutput = path.join(workspace, 'local pictures.pdf');
    const pictures = await call(client, 'abox_images_to_pdf', {
      input_paths: [imageResized, imageCompressed, imageResized], output_path: picturesOutput,
      page_size: 'fit', dpi: 72, image_mode: 'keep', margin_mm: 0,
    });
    assert.equal(pictures.verified, true);
    assert.equal(pictures.dimensions_verified, true);
    assert.equal(pictures.page_count, 3);
    assert.equal(pictures.copied_jpegs, 1);
    const picturesBytes = await readFile(picturesOutput);
    assert.equal(pictures.output_bytes, picturesBytes.length);
    const picturesDoc = await PdfDocument.open(new Uint8Array(picturesBytes));
    const picturePages = readSource(picturesDoc, 'Image smoke fixture').pages;
    assert.equal(picturesDoc.countPages(), 3);
    const expectedDimensions = [[64, 64], [compressed.width, compressed.height], [64, 64]];
    for (const [index, page] of picturePages.entries()) {
      const [width, height] = expectedDimensions[index];
      assert.ok(Math.abs(page.box[2] - page.box[0] - width) < 0.01);
      assert.ok(Math.abs(page.box[3] - page.box[1] - height) < 0.01);
      const resources = picturesDoc.get(page.dict, 'Resources');
      const objects = picturesDoc.get(resources, 'XObject');
      const image = picturesDoc.resolve(objects.get('Im0'));
      assert.equal(picturesDoc.get(image.dict, 'Width'), width);
      assert.equal(picturesDoc.get(image.dict, 'Height'), height);
      if (index === 1) assert.deepEqual(Buffer.from(image.raw), compressedBytes);
    }
    assert.ok(pictures.warnings.some(warning => warning.includes('embedded metadata')));

    const compressedPdfPath = path.join(workspace, 'screen optimized pictures.pdf');
    const compressedPdf = await call(client, 'abox_pdf_compress', {
      input_path: picturesOutput, output_path: compressedPdfPath, preset: 'smallest', dpi: 18,
    });
    assert.equal(compressedPdf.verified, true);
    assert.equal(compressedPdf.content_verified, true);
    assert.equal(compressedPdf.page_count, 3);
    assert.ok(compressedPdf.images_changed > 0, 'PDF compression must exercise image recompression.');
    assert.equal(compressedPdf.smaller, true);
    const compressedPdfBytes = await readFile(compressedPdfPath);
    assert.equal(compressedPdf.output_bytes, compressedPdfBytes.length);
    assert.deepEqual(await pdfPageFingerprints(compressedPdfBytes), await pdfPageFingerprints(picturesBytes));
    assert.equal(hash(await readFile(picturesOutput)), hash(picturesBytes));

    const watermarkedPath = path.join(workspace, 'draft statements.pdf');
    const watermarked = await call(client, 'abox_pdf_watermark', {
      input_path: pdfInput, output_path: watermarkedPath, text: 'DRAFT', color: 'red', opacity: 0.3,
      first_page_only: true, diagonal: false,
    });
    assert.equal(watermarked.verified, true);
    assert.equal(watermarked.stamps_verified, true);
    assert.equal(watermarked.page_count, 3);
    assert.equal(watermarked.stamped_page_count, 1);
    assert.equal(watermarked.stamp_count, 1);
    const stampedDoc = await PdfDocument.open(new Uint8Array(await readFile(watermarkedPath)));
    const stampedPages = readSource(stampedDoc, 'Watermarked smoke fixture').pages;
    for (const [index, page] of stampedPages.entries()) {
      const content = stampedDoc.resolve(page.dict.get('Contents'));
      const streams = (Array.isArray(content) ? content : [content]).map(value => stampedDoc.resolve(value));
      assert.ok(streams.length >= (index === 0 ? 3 : 1));
      const expectedOriginal = streams[index === 0 ? 1 : 0];
      const decoded = await decodeStream(expectedOriginal, value => stampedDoc.resolve(value));
      assert.equal(hash(decoded.bytes), originalPages[index]);
    }

    const iconPath = path.join(workspace, 'multi size app icon.ico');
    const icon = await call(client, 'abox_image_to_ico', { input_path: imageResized, output_path: iconPath });
    assert.equal(icon.verified, true);
    assert.deepEqual(icon.entries.map(entry => [entry.width, entry.kind]), [[16, 'bmp'], [32, 'bmp'], [48, 'bmp'], [256, 'png']]);
    const iconBytes = await readFile(iconPath);
    assert.equal(iconBytes.readUInt16LE(0), 0);
    assert.equal(iconBytes.readUInt16LE(2), 1);
    assert.equal(iconBytes.readUInt16LE(4), 4);
    let iconEnd = 70;
    for (const [index, entry] of icon.entries.entries()) {
      const offset = iconBytes.readUInt32LE(6 + index * 16 + 12);
      const length = iconBytes.readUInt32LE(6 + index * 16 + 8);
      assert.equal(offset, iconEnd);
      assert.equal(length, entry.bytes);
      const frame = iconBytes.subarray(offset, offset + length);
      if (entry.kind === 'png') {
        const header = pngChunks(frame).find(chunk => chunk.type === 'IHDR').data;
        assert.equal(header.readUInt32BE(0), entry.width);
        assert.equal(header.readUInt32BE(4), entry.height);
      } else {
        assert.equal(frame.readUInt32LE(0), 40);
        assert.equal(frame.readInt32LE(4), entry.width);
        assert.equal(frame.readInt32LE(8), entry.height * 2);
      }
      iconEnd += length;
    }
    assert.equal(iconEnd, iconBytes.length);

    const svgPath = path.join(workspace, 'local vector.svg');
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="4" height="4" fill="#f00"/></svg>');
    await writeFile(svgPath, svgBytes);
    const vectorPath = path.join(workspace, 'rasterized vector.png');
    const vector = await call(client, 'abox_svg_to_image', { input_path: svgPath, output_path: vectorPath, width: 80 });
    assert.equal(vector.verified, true);
    assert.equal(vector.width, 80);
    assert.equal(vector.height, 40);
    const vectorHeader = pngChunks(await readFile(vectorPath)).find(chunk => chunk.type === 'IHDR').data;
    assert.equal(vectorHeader.readUInt32BE(0), 80);
    assert.equal(vectorHeader.readUInt32BE(4), 40);
    assert.equal(hash(await readFile(svgPath)), hash(svgBytes));

    const layoutPath = path.join(workspace, 'combined local images.png');
    const layout = await call(client, 'abox_image_layout', {
      input_paths: [imageInput, imageResized], output_path: layoutPath,
      layout: 'grid', columns: 2, width: 200, gap: 0, padding: 0,
    });
    assert.equal(layout.verified, true);
    assert.equal(layout.image_count, 2);
    assert.equal(layout.width, 200);
    assert.equal(layout.height, 100);
    const layoutHeader = pngChunks(await readFile(layoutPath)).find(chunk => chunk.type === 'IHDR').data;
    assert.equal(layoutHeader.readUInt32BE(0), 200);
    assert.equal(layoutHeader.readUInt32BE(4), 100);

    const tableInput = path.join(workspace, 'selectable table.pdf');
    const tableBytes = await tablePdfBytes();
    await writeFile(tableInput, tableBytes);
    const csvPath = path.join(workspace, 'extracted table.csv');
    const csv = await call(client, 'abox_pdf_to_csv', { input_path: tableInput, output_path: csvPath, date_order: 'dmy' });
    assert.equal(csv.verified, true);
    assert.equal(csv.csv_structure_verified, true);
    assert.equal(csv.table_count, 1);
    assert.equal(csv.row_count, 5);
    assert.equal(await readFile(csvPath, 'utf8'), '\ufeffDate,"\'@Description",Amount,Balance\r\n'
      + '2026-04-03,Opening,0.00,1000.00\r\n2026-04-04,"Coffee, cafe",-10.00,990.00\r\n'
      + '2026-04-05,Refund,20.00,1010.00\r\n2026-04-06,"\'=SUM(1,2)",-5.00,1005.00\r\n2026-04-07,Final,1.00,1006.00\r\n');
    assert.ok(!JSON.stringify(csv).includes('Coffee'));
    assert.equal(hash(await readFile(tableInput)), hash(tableBytes));

    const jsonInput = path.join(workspace, 'precise source.json');
    const jsonBytes = Buffer.from('{"10":123456789012345678901,"2":1e999,"same":1,"same":2}');
    await writeFile(jsonInput, jsonBytes);
    const jsonOutput = path.join(workspace, 'formatted.json');
    const formatted = await call(client, 'abox_json_format', { input_path: jsonInput, output_path: jsonOutput });
    assert.equal(formatted.verified, true);
    assert.equal(await readFile(jsonOutput, 'utf8'), '{\n  "10": 123456789012345678901,\n  "2": 1e999,\n  "same": 1,\n  "same": 2\n}\n');
    assert.equal(hash(await readFile(jsonInput)), hash(jsonBytes));
    const base64Path = path.join(workspace, 'encoded binary.base64');
    const encoded = await call(client, 'abox_base64', { input_path: imageInput, output_path: base64Path, mode: 'encode', url_safe: true });
    assert.equal(encoded.verified, true);
    assert.equal(await readFile(base64Path, 'ascii'), png.toString('base64url'));
    const decodedPath = path.join(workspace, 'decoded binary.png');
    const decodedFile = await call(client, 'abox_base64', { input_path: base64Path, output_path: decodedPath, mode: 'decode', url_safe: true, canonical: true });
    assert.equal(decodedFile.verified, true);
    assert.deepEqual(await readFile(decodedPath), png);

    const uriPath = path.join(workspace, 'local image.css');
    const uri = await call(client, 'abox_image_data_uri', { input_path: imageInput, output_path: uriPath, shape: 'css-var', identifier: 'smoke-image' });
    assert.equal(uri.verified, true);
    assert.equal(uri.bytes_preserved, true);
    assert.equal(uri.image_decode_verified, false);
    const embedded = /url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\)/.exec(await readFile(uriPath, 'utf8'));
    assert.ok(embedded);
    assert.deepEqual(Buffer.from(embedded[1], 'base64'), png);
    assert.ok(!JSON.stringify(uri).includes(png.toString('base64')));

    const yamlInput = path.join(workspace, 'local config.yaml');
    const yamlBytes = Buffer.from('# local fixture\none: 1\nflag: true\n');
    await writeFile(yamlInput, yamlBytes);
    const yamlJsonPath = path.join(workspace, 'converted config.json');
    const yamlJson = await call(client, 'abox_yaml_json', { input_path: yamlInput, output_path: yamlJsonPath, direction: 'yaml-to-json' });
    assert.equal(yamlJson.verified, true);
    assert.deepEqual(JSON.parse(await readFile(yamlJsonPath, 'utf8')), { one: 1, flag: true });
    const yamlBackPath = path.join(workspace, 'round trip config.yml');
    const yamlBack = await call(client, 'abox_yaml_json', { input_path: yamlJsonPath, output_path: yamlBackPath, direction: 'json-to-yaml' });
    assert.equal(yamlBack.verified, true);
    assert.equal(await readFile(yamlBackPath, 'utf8'), 'one: 1\nflag: true\n');
    assert.deepEqual(await readFile(yamlInput), yamlBytes);

    const xmlInput = path.join(workspace, 'local document.xml');
    const xmlBytes = Buffer.from('<root><a>value &amp; more</a><b/></root>');
    await writeFile(xmlInput, xmlBytes);
    const xmlPath = path.join(workspace, 'formatted document.xml');
    const xml = await call(client, 'abox_xml_format', { input_path: xmlInput, output_path: xmlPath });
    assert.equal(xml.verified, true);
    const xmlText = await readFile(xmlPath, 'utf8');
    assert.match(xmlText, /^<root>\n/);
    assert.ok(xmlText.includes('<a>value &amp; more</a>'));
    assert.ok(xmlText.endsWith('</root>\n'));
    assert.deepEqual(await readFile(xmlInput), xmlBytes);

    const qrInput = path.join(workspace, 'qr payload.txt');
    const qrPayload = Buffer.from('https://abox.tools/'); await writeFile(qrInput, qrPayload);
    const qrPath = path.join(workspace, 'generated qr.png');
    const qr = await call(client, 'abox_qr_generate', { input_path: qrInput, output_path: qrPath, format: 'png' });
    assert.equal(qr.verified, true);
    assert.equal(qr.verification.payload_decoded, true);
    assert.ok(qr.verification.png_pixel_samples > 0);
    const qrHeader = pngChunks(await readFile(qrPath)).find(chunk => chunk.type === 'IHDR').data;
    assert.equal(qrHeader.readUInt32BE(0), qr.width);
    assert.equal(qrHeader.readUInt32BE(4), qr.height);
    assert.ok(!JSON.stringify(qr).includes(qrPayload.toString('utf8')));
    assert.deepEqual(await readFile(qrInput), qrPayload);

    const barcodeInput = path.join(workspace, 'barcode payload.txt');
    const barcodePayload = Buffer.from('400638133393'); await writeFile(barcodeInput, barcodePayload);
    const barcodePath = path.join(workspace, 'generated retail barcode.svg');
    const barcode = await call(client, 'abox_barcode_generate', { input_path: barcodeInput, output_path: barcodePath, symbology: 'ean13' });
    assert.equal(barcode.verified, true);
    assert.equal(barcode.verification.payload_decoded, true);
    assert.equal(barcode.check_digit_added, true);
    assert.ok((await readFile(barcodePath, 'utf8')).includes('<svg '));
    assert.ok(!JSON.stringify(barcode).includes(barcodePayload.toString('utf8')));
    assert.deepEqual(await readFile(barcodeInput), barcodePayload);

    const leftPath = path.join(workspace, 'left text.txt'), rightPath = path.join(workspace, 'right text.txt');
    const leftBytes = Buffer.from('alpha\r\nold'), rightBytes = Buffer.from('alpha\r\nnew\n');
    await writeFile(leftPath, leftBytes); await writeFile(rightPath, rightBytes);
    const patchPath = path.join(workspace, 'verified change.diff');
    const diff = await call(client, 'abox_text_diff', { left_path: leftPath, right_path: rightPath, output_path: patchPath });
    assert.equal(diff.verified, true);
    assert.equal(diff.source_reconstruction_verified, true);
    assert.equal(diff.patch_application_verified, true);
    const patch = await readFile(patchPath, 'utf8');
    assert.ok(patch.startsWith('--- a\n+++ b\n'));
    assert.ok(patch.includes('-old\n\\ No newline at end of file\n+new\n'));
    assert.deepEqual(await readFile(leftPath), leftBytes); assert.deepEqual(await readFile(rightPath), rightBytes);

    const gifPath = path.join(workspace, 'local animation.gif');
    // Independent clear/literal/end LZW codes, with one opaque black pixel.
    const gifBytes = Buffer.from('47494638396101000100800000000000ffffff21f90404010000002c00000000010001000002024401003b', 'hex');
    await writeFile(gifPath, gifBytes);
    const gifInfo = await call(client, 'abox_gif_inspect', { input_path: gifPath });
    assert.equal(gifInfo.container_complete, true); assert.equal(gifInfo.frame_count, 1);
    assert.equal(gifInfo.header_only, true); assert.equal(gifInfo.verified, false);
    const gifFrames = await call(client, 'abox_gif_split', { input_path: gifPath, output_dir: path.join(workspace, 'extracted frames') });
    assert.equal(gifFrames.verified, true); assert.equal(gifFrames.output_count, 1);
    const gifManifest = JSON.parse(await readFile(gifFrames.manifest_path, 'utf8'));
    assert.equal(gifManifest.outputs.length, 1); assert.equal(gifManifest.outputs[0].delay_cs, 1);
    const frameHeader = pngChunks(await readFile(gifManifest.outputs[0].output_path)).find(chunk => chunk.type === 'IHDR').data;
    assert.equal(frameHeader.readUInt32BE(0), 1); assert.equal(frameHeader.readUInt32BE(4), 1);
    assert.deepEqual(await readFile(gifPath), gifBytes);

    const tracedPath = path.join(workspace, 'traced shape.svg');
    const traced = await call(client, 'abox_image_trace', { input_path: vectorPath, output_path: tracedPath, threshold: 128 });
    assert.equal(traced.verified, true); assert.equal(traced.width, 80); assert.equal(traced.height, 40);
    assert.ok(traced.verification.passive_single_path); assert.ok(traced.contours > 0);
    assert.ok((await readFile(tracedPath, 'utf8')).includes('<path '));

    const stackPath = path.join(workspace, 'averaged local images.png');
    const stacked = await call(client, 'abox_image_stack', { input_paths: [imageInput, imageInput], output_path: stackPath });
    assert.equal(stacked.verified, true); assert.equal(stacked.image_count, 2);
    assert.equal(stacked.width, 256); assert.equal(stacked.height, 256);
    assert.equal(stacked.verification.png_pixel_checks, 256 * 256);

    const regionsPath = path.join(workspace, 'redaction regions.json');
    await writeFile(regionsPath, JSON.stringify({ image_width: 256, image_height: 256, regions: [{ x: 2, y: 2, width: 4, height: 4 }] }));
    const redactedPath = path.join(workspace, 'redacted local image.png');
    const redacted = await call(client, 'abox_image_redact', { input_path: imageInput, output_path: redactedPath, regions_path: regionsPath });
    assert.equal(redacted.verified, true); assert.equal(redacted.redacted_pixels, 16);
    assert.equal(redacted.redaction, 'opaque-black-fill'); assert.equal(redacted.source_metadata_copied, false);
    assert.equal(redacted.verification.all_pixels_checked, 256 * 256);
    assert.ok(!pngChunks(await readFile(redactedPath)).some(chunk => chunk.type === 'tEXt'));

    const secretsPath = path.join(workspace, 'generated secrets.txt');
    const generated = await call(client, 'abox_password_generate', { output_path: secretsPath });
    assert.equal(generated.verified, true); assert.equal(generated.count, 1); assert.equal(generated.length, 24);
    const generatedBytes = await readFile(secretsPath);
    assert.equal(generatedBytes.length, 25); assert.equal(generatedBytes.at(-1), 10);
    assert.ok(!JSON.stringify(generated).includes(generatedBytes.toString('utf8').trim()));
    generatedBytes.fill(0);
    const expanded = await smokeNewTools({ call, client, workspace, imageInput, imageResized, pdfInput, qrPath, qrPayload });
    const engineering_gaps = {
      live_companion: await smokeLive({ runFile, runtime, bundle, cwd: workspace, env }),
      images: await smokeImageGaps({ call, client, workspace }),
      audio: await smokeAudioGaps({ call, client, workspace }),
      documents: await smokeDocumentGaps({ run: (name, args) => call(client, name, args), workspace }),
      video: await smokeVideoGaps({ call, client, workspace }),
    };
    assert.equal(hash(await readFile(imageInput)), hash(png));
    assert.equal(hash(await readFile(imageResized)), hash(resizedBytes));
    assert.equal(hash(await readFile(imageCompressed)), hash(compressedBytes));
    assert.equal(hash(await readFile(pdfInput)), hash(pdfBytes));
    assert.equal(hash(await readFile(secondPdfInput)), hash(secondPdfBytes));
    console.log(JSON.stringify({ ok: true, universal, version: expectedVersion, runtime: runtimeVersion, platform: process.platform, arch: process.arch, tools: expectedTools, expanded, engineering_gaps, image_bytes: compressedBytes.length, image_target_bytes: targetBytes, image_resize: { width: resized.width, height: resized.height }, image_convert: converted.format, pdf_outputs: split.outputs.length, pdf_merge_pages: merged.page_count, pdf_select_pages: selected.page_count, relocated: true, system_node_required: false }));
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await smokeRelease(await jsonFile(parseArguments())); }
  catch (error) { console.error(`Release smoke failed: ${error.stack || error.message || error}`); process.exitCode = 1; }
}
