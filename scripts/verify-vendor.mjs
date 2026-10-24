import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function verifyVendor() {
  const manifest = JSON.parse(await readFile(new URL('../vendor/abox/provenance.json', import.meta.url), 'utf8'));
  const failed = [];
  const entries = [
    ...manifest.files.map(file => ({ ...file, url: new URL(`../vendor/abox/${file.path}`, import.meta.url) })),
    ...manifest.assets.map(file => ({ ...file, url: new URL(`../${file.path}`, import.meta.url) })),
  ];
  for (const file of entries) {
    try {
      const data = await readFile(file.url);
      if (createHash('sha256').update(data).digest('hex') !== file.sha256) failed.push(file.path);
    } catch { failed.push(file.path); }
  }
  return { ok: failed.length === 0, commit: manifest.commit, checked_files: entries.length, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyVendor();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
