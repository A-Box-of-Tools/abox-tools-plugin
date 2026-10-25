import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { boundedText, checksumFor, publicRequest } from './prepare-registry.mjs';

const run = promisify(execFile);
const VERSION = '1.8.4';
const ARCHIVE = 'mcp-publisher_linux_amd64.tar.gz';
const SHA256 = '5dc2fd415369c73551259f31cd33e2aacc9e0d1021e7f08fef1492d93b781628';
const BASE = `https://github.com/modelcontextprotocol/registry/releases/download/v${VERSION}`;

export async function installPublisher(output, options = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The pinned publisher installer supports the Linux x64 CI runner only.');
  const checksums = await boundedText(await publicRequest(`${BASE}/registry_${VERSION}_checksums.txt`, options), 64 * 1024);
  if (checksumFor(checksums, ARCHIVE) !== SHA256) throw new Error('The official publisher checksum differs from the reviewed pinned hash.');
  const directory = await mkdtemp(path.join(tmpdir(), 'abox-mcp-publisher-'));
  const archive = path.join(directory, ARCHIVE);
  const executable = path.join(directory, 'mcp-publisher');
  try {
    const response = await publicRequest(`${BASE}/${ARCHIVE}`, options);
    if (!response.body) throw new Error('The publisher download response had no body.');
    const file = await open(archive, 'wx', 0o600);
    const hash = createHash('sha256');
    let length = 0;
    try {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) throw new Error('The publisher archive exceeded its size limit.');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    if (hash.digest('hex') !== SHA256) throw new Error('The publisher download did not match its reviewed SHA-256 hash.');
    await run('tar', ['-xzf', archive, '-C', directory, 'mcp-publisher']);
    await copyFile(executable, path.resolve(output), constants.COPYFILE_EXCL);
    await chmod(path.resolve(output), 0o755);
    console.log(`Installed verified mcp-publisher ${VERSION}.`);
  } finally {
    await rm(archive, { force: true }).catch(() => {});
    await rm(executable, { force: true }).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' } } });
    if (!values.output) throw new Error('Use --output with the destination path for mcp-publisher.');
    await installPublisher(values.output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
