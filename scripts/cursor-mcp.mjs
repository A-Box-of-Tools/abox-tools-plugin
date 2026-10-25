import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const labels = { win32: 'windows', linux: 'linux', darwin: 'macos' };
const sha256 = /^[a-f0-9]{64}$/;

function failure(message, code = 'CURSOR_CACHE_INVALID') {
  const error = new Error(`${message} Run the abox-local-files setup skill once for this version, or use the native ZIP's Add to Cursor button.`);
  error.code = code;
  return error;
}

function safeRelative(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\')
    && !name.includes(':') && !name.includes('\0') && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!safeRelative(name)) throw failure('The adapter cache contains an unsafe path.');
    const filename = path.join(root, ...name.split('/'));
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw failure('The adapter cache contains a symbolic link.');
    if (info.isDirectory()) files.push(...await regularFiles(root, name));
    else if (info.isFile()) files.push(name);
    else throw failure('The adapter cache contains a special file.');
  }
  return files.sort();
}

export function defaultAdapterRoot(version, { home = homedir(), platform = process.platform, arch = process.arch } = {}) {
  return path.join(home, '.abox-tools', 'adapters', version, `${platform}-${arch}`);
}

export async function resolveCursorAdapter({ version, adapterRoot, home = homedir(), platform = process.platform, arch = process.arch } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !labels[platform]
      || !['x64', 'arm64'].includes(arch) || (platform !== 'darwin' && arch !== 'x64')) {
    throw failure('The requested adapter version or platform is unsupported.');
  }
  const root = adapterRoot ?? defaultAdapterRoot(version, { home, platform, arch });
  if (!path.isAbsolute(root) || /^[\\/]{2}/.test(root) || root.includes('\0')) {
    throw failure('--adapter-root must be an absolute local directory.');
  }
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw failure('The adapter cache must be a regular directory.');
    const receiptPath = path.join(root, 'INSTALL.json');
    const receiptInfo = await lstat(receiptPath);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 16 * 1024 * 1024) {
      throw failure('The adapter installation receipt is missing or invalid.');
    }
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.schema_version !== 1 || receipt.version !== version || receipt.platform !== platform || receipt.arch !== arch
        || receipt.archive !== `abox-tools-${version}-${labels[platform]}-${arch}.zip`
        || !sha256.test(receipt.archive_sha256 ?? '') || /^0{64}$/.test(receipt.archive_sha256)) {
      throw failure('The adapter installation receipt does not match this plugin version and computer.');
    }
    if (!receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files)) {
      throw failure('The adapter installation receipt has no file inventory.');
    }
    const expected = Object.keys(receipt.files).sort();
    if (!expected.length || expected.length > 50_000 || expected.includes('INSTALL.json')
        || expected.some(name => !safeRelative(name) || !sha256.test(receipt.files[name]))) {
      throw failure('The adapter installation receipt contains an invalid file inventory.');
    }
    if (new Set(expected.map(name => name.toLowerCase())).size !== expected.length) {
      throw failure('The adapter installation receipt contains ambiguous file paths.');
    }
    const found = (await regularFiles(root)).filter(name => name !== 'INSTALL.json');
    if (JSON.stringify(found) !== JSON.stringify(expected)) throw failure('The adapter cache contains missing or unexpected files.');
    for (const name of expected) {
      if (await hashFile(path.join(root, ...name.split('/'))) !== receipt.files[name]) {
        throw failure(`The installed adapter file has changed: ${name}.`);
      }
    }
    const executable = platform === 'win32' ? 'node.exe' : 'node';
    const runtimeRelative = `runtime/${executable}`;
    for (const required of [runtimeRelative, 'bin/abox-mcp.mjs', 'bin/abox.mjs', 'BUNDLE.json', 'package.json']) {
      if (!Object.hasOwn(receipt.files, required)) throw failure(`The adapter cache lacks ${required}.`);
    }
    const bundle = JSON.parse(await readFile(path.join(root, 'BUNDLE.json'), 'utf8'));
    const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (bundle.version !== version || project.version !== version || bundle.platform !== platform || bundle.arch !== arch
        || bundle.runtime_sha256 !== receipt.files[runtimeRelative]) {
      throw failure('The adapter bundle metadata does not match its verified installation receipt.');
    }
    const runtime = path.join(root, 'runtime', executable);
    if (platform !== 'win32' && !((await lstat(runtime)).mode & 0o111)) throw failure('The adapter runtime is not executable.');
    return { root, runtime, entry: path.join(root, 'bin', 'abox-mcp.mjs'), version };
  } catch (error) {
    if (error.code?.startsWith('CURSOR_')) throw error;
    if (error.code === 'ENOENT') throw failure('This abox.tools adapter version has not been installed.', 'CURSOR_SETUP_REQUIRED');
    throw failure(`The adapter cache could not be verified: ${error.message}`);
  }
}

export async function launchCursorAdapter({ adapterRoot, version } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    throw failure('The source Cursor plugin requires Node.js 22.15 or newer on PATH.', 'CURSOR_NODE_REQUIRED');
  }
  const desired = version ?? JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  const adapter = await resolveCursorAdapter({ version: desired, adapterRoot });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['NODE_PATH', 'NODE_OPTIONS'].includes(name.toUpperCase())));
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.runtime, [adapter.entry], { cwd: adapter.root, env, windowsHide: true, stdio: 'inherit' });
    const stop = signal => child.kill(signal);
    const terminate = () => stop('SIGTERM');
    const interrupt = () => stop('SIGINT');
    process.on('SIGTERM', terminate);
    process.on('SIGINT', interrupt);
    const cleanup = () => { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); resolve(code ?? 1); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'adapter-root': { type: 'string' } } });
    process.exitCode = await launchCursorAdapter({ adapterRoot: values['adapter-root'] });
  } catch (error) {
    console.error(`abox.tools Cursor setup: ${error.message}`);
    process.exitCode = 1;
  }
}
