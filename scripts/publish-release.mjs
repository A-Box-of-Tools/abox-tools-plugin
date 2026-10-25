import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RELEASE = path.join(ROOT, 'release');
const run = promisify(execFile);
const platforms = [
  { label: 'Windows x64', suffix: 'windows-x64' },
  { label: 'Linux x64', suffix: 'linux-x64' },
  { label: 'macOS Apple silicon', suffix: 'macos-arm64' },
  { label: 'macOS Intel', suffix: 'macos-x64' },
];

export function expectedAssets(version) {
  const native = platforms.flatMap(({ suffix }) => ['zip', 'mcpb'].flatMap(extension => {
    const archive = `abox-tools-${version}-${suffix}.${extension}`;
    return [archive, `${archive}.sha256`];
  }));
  const universal = `abox-tools-${version}-universal.mcpb`;
  return [...native, universal, `${universal}.sha256`];
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyReleaseAssets(version, directory = RELEASE) {
  const expected = expectedAssets(version);
  const found = (await readdir(directory)).sort();
  if (JSON.stringify(found) !== JSON.stringify([...expected].sort())) {
    throw new Error('The release directory must contain four native ZIPs, four native MCPBs, one universal MCPB, and their SHA-256 files.');
  }
  const files = [];
  for (const name of expected) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.size === 0) throw new Error(`The release asset is not a nonempty regular file: ${name}`);
    if (name.endsWith('.sha256') && info.size > 512) throw new Error(`The checksum file is unexpectedly large: ${name}`);
    files.push({ name, filename, size: info.size });
  }
  for (const archive of files.filter(file => !file.name.endsWith('.sha256'))) {
    const checksum = await readFile(`${archive.filename}.sha256`, 'utf8');
    const parsed = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/i.exec(checksum);
    if (!parsed || parsed[2] !== archive.name || parsed[1].toLowerCase() !== await sha256(archive.filename)) {
      throw new Error(`The release checksum does not match its archive: ${archive.name}`);
    }
  }
  return files;
}

async function git(args) {
  try { return (await run('git', args, { cwd: ROOT, encoding: 'utf8' })).stdout.trim(); }
  catch { throw new Error('The checked-out source could not be verified against the pushed tag.'); }
}

async function gh(args) {
  try { return (await run('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch { throw new Error(`GitHub CLI failed during ${args[0]} ${args[1]}; any incomplete release remains a draft.`); }
}

async function releaseInfo(tag, repository) {
  try {
    const { stdout } = await run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,assets,url'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 1 && /release not found/i.test(error.stderr ?? '')) return null;
    throw new Error('The existing release could not be inspected; no release changes were made.');
  }
}

function checkDraft(info, tag, files, complete = false) {
  if (!info || info.tagName !== tag || !info.isDraft) {
    throw new Error('A published release will never be replaced. Only an unpublished draft for this tag can be recovered.');
  }
  const expected = new Map(files.map(file => [file.name, file.size]));
  const names = new Set();
  for (const asset of info.assets) {
    if (!expected.has(asset.name) || names.has(asset.name)) throw new Error('The draft contains unexpected assets and needs manual review.');
    names.add(asset.name);
    if (complete && asset.size !== expected.get(asset.name)) throw new Error(`The uploaded asset has an unexpected size: ${asset.name}`);
  }
  if (complete && names.size !== expected.size) throw new Error('The draft is missing release assets and will not be published.');
}

function releaseNotes(version, tag, repository) {
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const downloads = platforms.map(({ label, suffix }) => {
    const name = `abox-tools-${version}-${suffix}`;
    return `- ${label}: [ZIP](${base}/${name}.zip), [MCPB](${base}/${name}.mcpb).`;
  }).join('\n');
  return `abox.tools ${version}, published by Abox Technologies, runs seven operations locally: image compression, resizing and conversion; PDF splitting, merging and page selection/reordering; and image metadata removal. Each bundle includes its runtime.\n\n`
    + `For Codex, download the ZIP for your computer, extract it, open START-HERE.html, and click Install in Codex. Keep the extracted folder in place.\n\n`
    + `For Claude Desktop and compatible MCPB hosts, download the [universal MCPB](${base}/abox-tools-${version}-universal.mcpb). It includes the four bundled runtimes and selects the host platform. MCP execution is checked on all four targets; desktop installation was verified on Windows with version 0.2.1.\n\n`
    + `${downloads}\n\nEach archive has a matching SHA-256 file. Source commit: ${process.env.GITHUB_SHA}.\n`;
}

export async function publishRelease() {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const source = process.env.GITHUB_SHA;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
      || process.env.GITHUB_EVENT_NAME !== 'push' || tag !== `v${version}`
      || process.env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error('Publishing is allowed only for a pushed version tag that exactly matches package.json.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40,64}$/.test(source ?? '')) {
    throw new Error('The workflow repository and source commit are missing or invalid.');
  }
  if (!process.env.GH_TOKEN) throw new Error('The publish job must provide its GitHub token through GH_TOKEN.');
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const tagged = await git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (head !== source || tagged !== source) throw new Error('The pushed tag, workflow commit, and checked-out source do not agree.');
  await git(['diff', '--quiet', 'HEAD', '--']);
  const files = await verifyReleaseAssets(version);
  const remote = (await gh(['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'])).trim();
  if (remote !== source) throw new Error('The remote tag no longer points to the verified source commit.');
  const existing = await releaseInfo(tag, repository);
  if (existing) checkDraft(existing, tag, files);

  const notesDirectory = await mkdtemp(path.join(tmpdir(), 'abox-release-notes-'));
  const notes = path.join(notesDirectory, 'notes.md');
  try {
    await writeFile(notes, releaseNotes(version, tag, repository), { encoding: 'utf8', flag: 'wx' });
    if (existing) {
      // Draft assets can be replaced to recover a partial upload; published bytes are never touched.
      await gh(['release', 'upload', tag, ...files.map(file => file.filename), '--repo', repository, '--clobber']);
    } else {
      await gh(['release', 'create', tag, ...files.map(file => file.filename), '--repo', repository,
        '--verify-tag', '--draft', '--title', `abox.tools ${version}`, '--notes-file', notes]);
    }
    checkDraft(await releaseInfo(tag, repository), tag, files, true);
    await gh(['release', 'edit', tag, '--repo', repository, '--verify-tag', '--draft=false',
      '--title', `abox.tools ${version}`, '--notes-file', notes]);
    console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
  } finally {
    await rm(notes, { force: true }).catch(() => {});
    await rmdir(notesDirectory).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await publishRelease(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
