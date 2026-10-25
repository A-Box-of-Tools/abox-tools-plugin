import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyVendor } from './verify-vendor.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const labels = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const platform = process.platform;
const arch = process.arch;
if (!labels[platform] || !['x64', 'arm64'].includes(arch)) throw new Error('This platform is not supported by the release builder.');
if ((process.env.ABOX_EXPECT_PLATFORM && process.env.ABOX_EXPECT_PLATFORM !== platform)
    || (process.env.ABOX_EXPECT_ARCH && process.env.ABOX_EXPECT_ARCH !== arch)) {
  throw new Error('The runner architecture does not match its release label.');
}
const project = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(path.join(ROOT, 'plugin.json'), 'utf8'));
if (project.version !== plugin.version) throw new Error('Plugin and package versions must agree before packaging.');
const receipt = await verifyVendor();
if (!receipt.ok) throw new Error('Restore the recorded upstream sources before packaging.');
const name = `abox-tools-${project.version}-${labels[platform]}-${arch}`;
const stage = path.join(ROOT, '_release');
const destination = path.join(stage, name);
await mkdir(stage, { recursive: true });
// An existing build is evidence worth keeping. Never remove or replace it implicitly.
await mkdir(destination);
for (const relative of [
  'bin', 'src', 'vendor', 'assets', 'skills', '.agents',
  'plugin.json', 'mcp.json', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md',
  'scripts/verify-vendor.mjs', 'scripts/open-installer.mjs',
]) {
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(ROOT, relative), path.join(destination, relative), { recursive: true, errorOnExist: true, force: false });
}
// npm ci in CI installs the lockfile. Copy its production graph so users never
// need npm, a package download, or a development checkout at operation time.
const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
const dependencies = Object.entries(lock.packages).filter(([relative, metadata]) => relative && !metadata.dev && relative.startsWith('node_modules/'));
for (const [relative, metadata] of dependencies) {
  try { await stat(path.join(ROOT, relative)); }
  catch (error) {
    if (error.code === 'ENOENT' && metadata.optional) continue;
    throw error;
  }
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(ROOT, relative), path.join(destination, relative), {
    recursive: true, dereference: true, force: false, errorOnExist: false,
    filter: file => !['.bin', '.cache'].includes(path.basename(file)),
  });
}
const runtime = path.join(destination, 'runtime');
await mkdir(runtime);
const executable = platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, path.join(runtime, executable));
if (platform !== 'win32') await chmod(path.join(runtime, executable), 0o755);
const binaryDir = path.dirname(process.execPath);
const licenseCandidates = [
  path.join(binaryDir, 'LICENSE'), path.join(binaryDir, '..', 'LICENSE'),
  path.join(binaryDir, '..', 'share', 'doc', 'node', 'LICENSE'),
  path.join(binaryDir, '..', '..', 'LICENSE'),
];
let nodeLicense;
for (const candidate of licenseCandidates) {
  try {
    const text = await readFile(candidate, 'utf8');
    if (text.includes('Node.js') && text.includes('Permission is hereby granted')) { nodeLicense = text; break; }
  } catch { /* Try the next official distribution location. */ }
}
if (!nodeLicense) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Could not obtain the official license for this exact Node runtime.');
  nodeLicense = await response.text();
  if (Buffer.byteLength(nodeLicense) > 4 * 1024 * 1024 || !nodeLicense.startsWith('Node.js is licensed for use as follows:')) {
    throw new Error('The official Node license response was not the expected license text.');
  }
}
await writeFile(path.join(runtime, 'LICENSE'), nodeLicense);

const mcp = JSON.parse(await readFile(path.join(destination, 'mcp.json'), 'utf8'));
mcp.mcpServers.abox.command = `\${PLUGIN_ROOT}/runtime/${executable}`;
await writeFile(path.join(destination, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
const bundledPackage = { ...project, scripts: { start: project.scripts.start, doctor: project.scripts.doctor } };
await writeFile(path.join(destination, 'package.json'), `${JSON.stringify(bundledPackage, null, 2)}\n`);
const mcpb = {
  manifest_version: '0.3', name: 'abox-tools', display_name: 'abox.tools', version: project.version,
  description: 'Compress images, split PDFs, and remove image metadata locally.',
  long_description: 'Runs the existing abox.tools engines on explicit local file paths. This bundle includes Node and all server dependencies. Image compression uses an installed Edge, Chrome, or Chromium; file bytes are never uploaded for processing.',
  author: { name: 'A Box of Tools', url: 'https://abox.tools/' },
  homepage: 'https://abox.tools/',
  documentation: 'https://github.com/A-Box-of-Tools/abox-tools-plugin#readme',
  support: 'https://github.com/A-Box-of-Tools/abox-tools-plugin/issues',
  icon: 'assets/icon.png', license: 'MIT',
  server: { type: 'binary', entry_point: `runtime/${executable}`, mcp_config: {
    command: `\${__dirname}/runtime/${executable}`, args: ['${__dirname}/bin/abox-mcp.mjs'],
  } },
  compatibility: { platforms: [platform] },
};
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(mcpb, null, 2)}\n`);
const validatorRoot = path.join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb');
const validatorPackage = JSON.parse(await readFile(path.join(validatorRoot, 'package.json'), 'utf8'));
const validatorBin = typeof validatorPackage.bin === 'string' ? validatorPackage.bin : validatorPackage.bin.mcpb;
await run(process.execPath, [path.join(validatorRoot, validatorBin), 'validate', path.join(destination, 'manifest.json')], { maxBuffer: 1024 * 1024 });
const { stdout: revision } = await run('git', ['-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, '-C', ROOT, 'rev-parse', 'HEAD']);
const { stdout: dirty } = await run('git', ['-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, '-C', ROOT, 'status', '--porcelain']);
const bundle = {
  version: project.version, platform, arch, node_version: process.versions.node,
  source_revision: revision.trim(), dirty_source: Boolean(dirty.trim()),
  upstream_commit: receipt.commit, runtime_sha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
};
await writeFile(path.join(destination, 'BUNDLE.json'), `${JSON.stringify(bundle, null, 2)}\n`);

const script = `const file=new URL('./.agents/plugins/marketplace.json',location.href);let p=decodeURIComponent(file.pathname);if(/^\\/[a-z]:\\//i.test(p))p=p.slice(1);document.getElementById('install').href='codex://plugins/abox-tools?marketplacePath='+encodeURIComponent(p).replaceAll("'",'%27');`;
const css = `:root{font-family:system-ui,sans-serif;color:#173a30;background:#f3f7f4}body{max-width:680px;margin:8vh auto;padding:24px}h1{font-size:42px;margin-bottom:8px}p,li{line-height:1.6}main{background:white;border:1px solid #d6e3da;border-radius:20px;padding:32px}a{color:#166647}.button{display:inline-block;background:#166647;color:white;text-decoration:none;border-radius:8px;padding:14px 22px;font-weight:650}small{color:#496557}code{overflow-wrap:anywhere}`;
const hash = value => createHash('sha256').update(value).digest('base64');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(css)}'; base-uri 'none'; form-action 'none'"><title>Install abox.tools</title><style>${css}</style></head><body><main><small>abox.tools ${project.version} · ${labels[platform]} ${arch}</small><h1>Your agent's local toolbox.</h1><p>Compress images, split PDFs, and remove photo metadata. Your files are processed on this computer.</p><ol><li>Keep this extracted folder somewhere permanent.</li><li>Select the button below, then choose <strong>Install</strong> in Codex desktop.</li><li>Start a new local chat and ask the agent to process a file.</li></ol><p><a id="install" class="button">Install in Codex</a></p><p>The runtime and dependencies are included. You do not need Node.js, npm, Git, or a terminal.</p><p>Image compression uses an installed Edge, Chrome, or Chromium. PDF splitting and metadata removal do not need a browser.</p><p>For Claude Desktop, open the matching <strong>.mcpb</strong> download instead. It installs the MCP tools; the Codex package also includes the shared skill.</p><small>This page opens Codex's installation screen. It does not change app settings itself. <a href="https://github.com/A-Box-of-Tools/abox-tools-plugin#readme">Help and updates</a></small></main><script>${script}</script></body></html>\n`;
await writeFile(path.join(destination, 'START-HERE.html'), html);
if (platform === 'win32') {
  await writeFile(path.join(destination, 'Install in Codex.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\open-installer.mjs"\r\nif errorlevel 1 pause\r\n');
} else {
  const launcher = path.join(destination, platform === 'darwin' ? 'Install in Codex.command' : 'Install in Codex.sh');
  await writeFile(launcher, '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./runtime/node ./scripts/open-installer.mjs\n');
  await chmod(launcher, 0o755);
}
await writeFile(path.join(stage, 'build.json'), `${JSON.stringify({ name, root: destination, version: project.version, platform, arch }, null, 2)}\n`);
await run(platform === 'win32' ? 'python' : 'python3', [path.join(ROOT, 'scripts/archive-release.py'), '--config', path.join(stage, 'build.json')], { maxBuffer: 1024 * 1024 });
console.log(JSON.stringify({ name, platform, arch, node_version: process.versions.node, release_directory: path.join(ROOT, 'release') }));
