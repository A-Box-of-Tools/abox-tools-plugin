import path from 'node:path';
import { open, realpath, stat, access, unlink } from 'node:fs/promises';
import { AdapterError } from './errors.mjs';

export const MAX_INPUT_BYTES = 128 * 1024 * 1024;

export function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)
      || /^[\\/]{2}/.test(value) || /^[a-z]+:\/\//i.test(value) || value.includes('\0')) {
    throw new AdapterError('LOCAL_PATH_REQUIRED', 'Use an absolute local filesystem path, not a URL or network share.');
  }
  if (process.platform === 'win32') {
    const remainder = value.replace(/^[a-z]:/i, '');
    if (remainder.includes(':') || remainder.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new AdapterError('LOCAL_PATH_REQUIRED', 'Windows device paths and alternate data streams are not supported.');
    }
  }
  return path.normalize(value);
}

export async function readInput(value) {
  const input = localPath(await realpath(localPath(value)));
  if (!(await stat(input)).isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
  const file = await open(input, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
    if (!info.size || info.size > MAX_INPUT_BYTES) {
      throw new AdapterError('INPUT_SIZE', `Input files must contain 1 to ${MAX_INPUT_BYTES} bytes.`);
    }
    const parts = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_INPUT_BYTES + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_INPUT_BYTES) throw new AdapterError('INPUT_SIZE', 'The input grew beyond the supported size.');
      parts.push(buffer.subarray(0, bytesRead));
    }
    if (!size) throw new AdapterError('INPUT_SIZE', 'The input became empty while it was being read.');
    const data = Buffer.concat(parts, size);
    return { path: input, data };
  } finally {
    await file.close();
  }
}

export async function newOutput(value) {
  let output = localPath(value);
  const parent = await realpath(path.dirname(output));
  if (!path.isAbsolute(parent) || /^[\\/]{2}/.test(parent)) {
    throw new AdapterError('LOCAL_PATH_REQUIRED', 'The output directory must resolve to a local path.');
  }
  if (!(await stat(parent)).isDirectory()) throw new AdapterError('OUTPUT_DIRECTORY', 'The output parent must be a directory.');
  output = path.join(parent, path.basename(output));
  try {
    await access(output);
    throw new AdapterError('OUTPUT_EXISTS', 'The output already exists. Choose a new path.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

export async function writeNew(output, data) {
  const file = await open(output, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(output).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}

export function requireExtension(output, mime) {
  const expected = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
  }[mime];
  if (!expected?.includes(path.extname(output).toLowerCase())) {
    throw new AdapterError('OUTPUT_EXTENSION', `Use an output filename ending in ${expected?.join(' or ') ?? mime}.`);
  }
}
