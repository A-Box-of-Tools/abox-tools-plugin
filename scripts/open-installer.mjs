import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';

function localServerConfig(root, { platform = process.platform } = {}, client) {
  if (!path.isAbsolute(root) || !['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`${client} installation requires an absolute local bundle path on a supported platform.`);
  }
  return {
    type: 'stdio',
    command: path.join(root, 'runtime', platform === 'win32' ? 'node.exe' : 'node'),
    args: [path.join(root, 'bin', 'abox-mcp.mjs')],
  };
}

export function cursorServerConfig(root, options = {}) {
  return localServerConfig(root, options, 'Cursor');
}

export function vscodeServerConfig(root, options = {}) {
  return { name: 'abox-tools', ...localServerConfig(root, options, 'VS Code') };
}

export function installerUrl(root, client = 'codex', options = {}) {
  if (client === 'cursor') {
    const config = Buffer.from(JSON.stringify(cursorServerConfig(root, options)), 'utf8').toString('base64');
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=abox-tools&config=${encodeURIComponent(config)}`;
  }
  if (client === 'vscode') {
    const config = encodeURIComponent(JSON.stringify(vscodeServerConfig(root, options))).replaceAll("'", '%27');
    return `vscode:mcp/install?${config}`;
  }
  if (client !== 'codex') throw new Error('Choose codex, cursor, or vscode as the installation client.');
  return `codex://plugins/abox-tools?marketplacePath=${encodeURIComponent(path.join(root, '.agents', 'plugins', 'marketplace.json')).replaceAll("'", '%27')}`;
}

export async function openInstaller(root, client = 'codex') {
  const uri = installerUrl(root, client);
  const required = client === 'codex'
    ? [path.join(root, '.agents', 'plugins', 'marketplace.json')]
    : [localServerConfig(root, {}, client === 'vscode' ? 'VS Code' : 'Cursor').command, path.join(root, 'bin', 'abox-mcp.mjs')];
  for (const filename of required) {
    if (!(await stat(filename)).isFile()) throw new Error('Extract the complete download before opening the installer.');
  }
  let command;
  let args;
  if (process.platform === 'win32') {
    command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // The URI contains only fixed text and an encoded path. An encoded command
    // keeps cmd.exe's percent expansion out of this handoff entirely.
    const script = `Start-Process -FilePath '${uri}' -ErrorAction Stop`;
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    args = [uri];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    const app = { codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code' }[client];
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not open ${app}. Install or open the desktop app, then try again.`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { client: { type: 'string', default: 'codex' } } });
    await openInstaller(fileURLToPath(new URL('../', import.meta.url)), values.client);
  } catch (error) {
    console.error(error.message);
    console.error('You can also open START-HERE.html and select your desktop app.');
    process.exitCode = 1;
  }
}
