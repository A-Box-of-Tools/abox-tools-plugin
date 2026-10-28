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
  'tools/heic-to-jpg/src/heif.js', 'tools/heic-to-jpg/src/codecs.js',
  'tools/heic-to-jpg/src/example-data.js', 'tools/heic-to-jpg/README.md',
  'tools/heic-to-jpg/vendor/libheif.js', 'tools/heic-to-jpg/vendor/LICENSE',
  'tools/compress-video/src/encode.js', 'tools/compress-video/src/plan.js',
  'tools/crop-video/src/transcode.js', 'tools/crop-video/src/draw.js', 'tools/crop-video/src/mp4.js',
  'tools/grab-frame/src/frames.js', 'tools/grab-frame/src/plan.js', 'tools/grab-frame/src/still.js', 'tools/grab-frame/src/draw.js',
  'tools/extract-audio-from-video/src/mono.js',
  'tools/reverse-video/src/reverse.js', 'tools/reverse-video/src/timeline.js', 'tools/reverse-video/src/draw.js', 'tools/reverse-video/src/audio.js',
  'tools/timelapse-video/src/decode.js', 'tools/timelapse-video/src/encode.js', 'tools/timelapse-video/src/plan.js',
  'tools/video-to-gif/src/frames.js', 'tools/video-to-gif/src/encode.js', 'tools/video-to-gif/src/plan.js',
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
  'tools/image-layout/src/arrange.js',
  'tools/pdf-to-csv/src/read.js', 'tools/pdf-to-csv/src/rows.js',
  'tools/pdf-to-csv/src/check.js', 'tools/pdf-to-csv/src/csv.js',
  'shared/js/parse-json.js', 'tools/base64/src/encode.js',
  'tools/yaml-to-json/src/convert.js', 'shared/js/parse-xml.js',
  'tools/xml-formatter/src/convert.js', 'tools/json-formatter/src/format.js',
  'tools/json-formatter/src/css.js', 'tools/share-text/src/markdown.js',
  'tools/text-diff/src/diff.js',
  'shared/js/qr.js', 'tools/qr-barcode/src/barcode.js', 'tools/qr-barcode/src/render.js',
  'tools/qr-barcode/src/scan-advice.js',
  'tools/qr-barcode-reader/src/qr-decode.js', 'tools/qr-barcode-reader/src/linear.js',
  'tools/image-to-data-uri/src/sniff.js', 'tools/image-to-data-uri/src/encode.js',
  'tools/image-to-data-uri/src/shapes.js', 'tools/image-to-data-uri/src/metadata.js',
  'tools/gif-analyzer/src/gif.js', 'tools/gif-analyzer/src/budget.js', 'tools/gif-analyzer/src/lzw.js',
  'shared/js/gif-decode.js', 'shared/js/gif-compose.js',
  'tools/split-gif/src/frames.js', 'tools/split-gif/src/working.js',
  'tools/password-generator/src/generate.js', 'tools/password-generator/src/strength.js',
  'tools/redact-image/src/redact.js',
  'tools/image-to-svg/src/trace.js', 'tools/stack-images/src/stack.js',
  'tools/qr-barcode-reader/src/scan.js', 'tools/gif-maker/src/encode.js',
  'shared/js/pdf-crypt.js', 'shared/js/pdf-permissions.js',
  'tools/protect-pdf/src/password-validation.js', 'tools/unlock-pdf/src/document-for-export.js',
  'shared/js/audio-decode.js', 'shared/js/wav-async.js',
  'tools/edit-audio/src/edit.js', 'tools/trim-audio/src/trim.js',
  'shared/js/mp4-reader.js', 'tools/trim-video/src/copy.js', 'tools/trim-video/src/clips.js',
  'tools/document-scanner/src/write-scan.js', 'tools/document-scanner/src/warp.js',
  'tools/document-scanner/src/clean.js', 'tools/document-scanner/src/encode.js', 'tools/document-scanner/src/document.js',
  'tools/id-photo/src/geometry.js', 'tools/id-photo/src/sheet.js', 'tools/id-photo/src/encode.js',
  'tools/business-profile-preview/src/surfaces.js', 'tools/business-profile-preview/src/view.js',
  'tools/business-profile-preview/src/profile.js', 'tools/business-profile-preview/src/raster.js',
  'tools/business-profile-preview/src/preview-time.js', 'tools/business-profile-preview/src/photo.js',
  'tools/business-profile-preview/body.html',
  'tools/compare-heights/src/chart.js', 'tools/compare-heights/src/figures.js',
  'tools/compare-heights/src/units.js', 'tools/compare-heights/src/save.js',
  'tools/compare-heights/src/chart-measurements.js',
  'tools/compare-heights/vendor/LICENSE.md', 'tools/compare-heights/vendor/objects/LICENSE.md',
  'tools/compare-heights/vendor/objects/LICENSE-phosphor-MIT.txt',
  'tools/compare-heights/vendor/objects/LICENSE-material-symbols-Apache-2.0.txt',
  'tools/receipt-invoice-extractor/src/ocr.js', 'tools/receipt-invoice-extractor/src/receipt.js',
  'tools/dicom-viewer/src/dicom.js', 'tools/dicom-viewer/src/pixels.js', 'tools/dicom-viewer/src/window.js',
  'tools/images-to-video/src/encoder.js', 'tools/gif-to-mp4/src/encode.js',
  'tools/rotate-video/src/rotate.js', 'tools/convert-to-mp4/src/convert.js',
  'tools/gif-to-mp4/src/plan.js', 'tools/gif-to-mp4/src/working.js',
  'tools/receipt-invoice-extractor/vendor/README.md', 'tools/receipt-invoice-extractor/vendor/ocr-worker.js',
  'tools/receipt-invoice-extractor/vendor/worker.min.js', 'tools/receipt-invoice-extractor/vendor/worker.min.js.LICENSE.txt',
  'tools/receipt-invoice-extractor/vendor/tesseract-core-lstm.js', 'tools/receipt-invoice-extractor/vendor/wasm-data.js',
  'tools/receipt-invoice-extractor/vendor/eng-data.js', 'tools/receipt-invoice-extractor/vendor/LICENSE-tesseract-js.txt',
  'tools/receipt-invoice-extractor/vendor/LICENSE-tesseract-core', 'tools/receipt-invoice-extractor/vendor/LICENSE-language-data',
  'shared/js/pdf-reader.js', 'shared/js/pdf-writer.js', 'shared/js/example-pdf.js',
  'tools/compress-image/README.md', 'tools/resize-image/README.md',
  'tools/png-to-webp/README.md', 'tools/webp-to-jpg/README.md',
  'tools/exif-editor/README.md', 'tools/merge-pdf/README.md',
  'tools/images-to-pdf/README.md', 'tools/hash-checksum/README.md',
  'tools/compress-pdf/README.md', 'tools/watermark-pdf/README.md',
  'tools/image-to-ico/README.md', 'tools/svg-to-image/README.md',
  'tools/image-layout/README.md', 'tools/pdf-to-csv/README.md',
  'tools/json-formatter/README.md', 'tools/base64/README.md',
  'tools/yaml-to-json/README.md', 'tools/xml-formatter/README.md', 'tools/text-diff/README.md',
  'tools/qr-barcode/README.md', 'tools/qr-barcode-reader/README.md', 'tools/image-to-data-uri/README.md',
  'tools/gif-analyzer/README.md', 'tools/split-gif/README.md',
  'tools/password-generator/README.md', 'tools/redact-image/README.md',
  'tools/image-to-svg/README.md', 'tools/stack-images/README.md',
  'tools/gif-maker/README.md', 'tools/protect-pdf/README.md', 'tools/unlock-pdf/README.md',
  'tools/edit-audio/README.md', 'tools/trim-audio/README.md', 'tools/trim-video/README.md',
  'tools/document-scanner/README.md', 'tools/id-photo/README.md',
  'tools/business-profile-preview/README.md', 'tools/compare-heights/README.md',
  'tools/receipt-invoice-extractor/README.md',
  'tools/dicom-viewer/README.md', 'tools/images-to-video/README.md', 'tools/gif-to-mp4/README.md',
  'tools/rotate-video/README.md', 'tools/convert-to-mp4/README.md',
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
