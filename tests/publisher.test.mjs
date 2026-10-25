import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { universalManifest } from '../scripts/package-universal.mjs';

const publisher = 'Abox Technologies';
const product = 'abox.tools';
const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

test('plugin, bundle, registry, and directory listing identify the same publisher', async () => {
  const [plugin, project, registry, listing] = await Promise.all([
    readJson('../plugin.json'),
    readJson('../package.json'),
    readJson('../registry/server.template.json'),
    readFile(new URL('../docs/directory-submissions.md', import.meta.url), 'utf8'),
  ]);
  const universal = universalManifest(project.version);
  assert.equal(project.author.name, publisher);
  assert.equal(plugin.author.name, publisher);
  assert.equal(plugin.extensions['com.openai'].interface.developerName, publisher);
  assert.equal(universal.author.name, publisher);
  assert.equal(registry._meta['io.modelcontextprotocol.registry/publisher-provided'].publisher.name, publisher);
  const listedPublisher = /^Publisher:\s+\*\*(.+)\*\*\s*$/m.exec(listing);
  assert.ok(listedPublisher, 'Directory submission materials must include a Publisher field.');
  assert.equal(listedPublisher[1], publisher);
  assert.equal(plugin.extensions['com.openai'].interface.displayName, product);
  assert.equal(universal.display_name, product);
  assert.equal(registry.title, product);
});
