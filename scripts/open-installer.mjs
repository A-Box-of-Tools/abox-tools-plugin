import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export function installerUrl(root) {
  return `codex://plugins/abox-tools?marketplacePath=${encodeURIComponent(path.join(root, '.agents', 'plugins', 'marketplace.json')).replaceAll("'", '%27')}`;
}

export async function openInstaller(root) {
  const manifest = path.join(root, '.agents', 'plugins', 'marketplace.json');
  if (!(await stat(manifest)).isFile()) throw new Error('Extract the complete download before opening the installer.');
  const uri = installerUrl(root);
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
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open Codex. Install or open the desktop app, then try again.')));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await openInstaller(fileURLToPath(new URL('../', import.meta.url)));
  } catch (error) {
    console.error(error.message);
    console.error('You can also open START-HERE.html and select Install in Codex.');
    process.exitCode = 1;
  }
}
