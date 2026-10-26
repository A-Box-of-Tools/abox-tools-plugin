import path from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { staticImports } from './static-imports.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VENDOR = path.join(ROOT, 'vendor/abox');
const run = promisify(execFile);
const sha = data => createHash('sha256').update(data).digest('hex');
const seeds = [
  'tools/compress-image/src/process.js',
  'tools/resize-image/src/run.js',
  'shared/js/image-convert.js',
  'tools/exif-editor/src/container.js',
  'tools/exif-editor/src/clean-copy.js',
  'tools/merge-pdf/src/assemble.js',
  'tools/merge-pdf/src/plan.js',
  'tools/images-to-pdf/src/document.js',
  'tools/hash-checksum/src/hash.js',
  'tools/compress-pdf/src/compress.js',
  'tools/watermark-pdf/src/apply.js', 'tools/watermark-pdf/src/render.js', 'tools/watermark-pdf/src/stamp.js',
  'tools/image-to-ico/src/render.js', 'tools/image-to-ico/src/ico.js', 'tools/image-to-ico/src/sizes.js',
  'tools/svg-to-image/src/svg.js', 'tools/svg-to-image/src/sizing.js',
  'tools/svg-to-image/src/render.js', 'tools/svg-to-image/src/svg-linked-assets.js',
  'shared/js/pdf-reader.js', 'shared/js/pdf-writer.js', 'shared/js/example-pdf.js',
  'tools/compress-image/README.md', 'tools/resize-image/README.md',
  'tools/png-to-webp/README.md', 'tools/webp-to-jpg/README.md',
  'tools/exif-editor/README.md', 'tools/merge-pdf/README.md',
  'tools/images-to-pdf/README.md', 'tools/hash-checksum/README.md',
  'tools/compress-pdf/README.md', 'tools/watermark-pdf/README.md',
  'tools/image-to-ico/README.md', 'tools/svg-to-image/README.md',
  'LICENSE',
];

const { values } = parseArgs({ options: { source: { type: 'string' } } });
if (!values.source || !path.isAbsolute(values.source)) throw new Error('Use --source with an absolute local website checkout path.');
const sourceRoot = path.resolve(values.source);
const { stdout: revision } = await run('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']);
const commit = revision.trim();
if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Could not identify the upstream commit.');
const files = new Map();
const bridges = new Map();

async function visit(relative) {
  relative = relative.replaceAll('\\', '/');
  if (files.has(relative)) return;
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('An import escaped the source checkout.');
  const data = await readFile(path.join(sourceRoot, relative));
  const { stdout: committed } = await run('git', ['-C', sourceRoot, 'show', `${commit}:${relative}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  if (!data.equals(committed)) throw new Error(`Refusing uncommitted source changes: ${relative}`);
  files.set(relative, data);
  if (!relative.endsWith('.js')) return;
  for (const specifier of staticImports(data.toString('utf8'))) {
    if (!specifier.startsWith('.')) throw new Error(`Review the new external import in ${relative}: ${specifier}`);
    let child = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
    try { await access(path.join(sourceRoot, child)); }
    catch (error) {
      if (error.code !== 'ENOENT' || !specifier.startsWith('./shared/')) throw error;
      const shared = `shared/js/${specifier.slice('./shared/'.length)}`;
      const destination = path.posix.relative(path.posix.dirname(child), shared);
      bridges.set(child, Buffer.from(`// The website build resolves this shared part; the upstream module stays unchanged.\nexport * from '${destination.startsWith('.') ? destination : `./${destination}`}';\n`));
      child = shared;
    }
    await visit(child);
  }
}

for (const seed of seeds) await visit(seed);
const records = [];
for (const [relative, data] of [...files, ...bridges].sort(([a], [b]) => a.localeCompare(b))) {
  const destination = path.join(VENDOR, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, data);
  records.push({ path: relative, sha256: sha(data), generated: bridges.has(relative) });
}
const iconSource = 'tools/compress-image/icon.png';
const icon = await readFile(path.join(sourceRoot, iconSource));
await mkdir(path.join(ROOT, 'assets'), { recursive: true });
await writeFile(path.join(ROOT, 'assets/icon.png'), icon);
await writeFile(path.join(VENDOR, 'provenance.json'), `${JSON.stringify({
  repository: 'https://github.com/A-Box-of-Tools/website', commit,
  entrypoints: seeds.filter(file => file.endsWith('.js')),
  files: records, assets: [{ source: iconSource, path: 'assets/icon.png', sha256: sha(icon) }],
}, null, 2)}\n`);
console.log(JSON.stringify({ commit, upstream_files: files.size, generated_bridges: bridges.size }));
