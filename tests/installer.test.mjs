import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { installerUrl } from '../scripts/open-installer.mjs';

test('the installer preserves spaces, apostrophes, punctuation, and Unicode in the extracted folder path', () => {
  const root = path.resolve("O'Brien & 100% Québec", 'abox tools');
  const uri = installerUrl(root);
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'codex:');
  assert.equal(parsed.hostname, 'plugins');
  assert.equal(parsed.pathname, '/abox-tools');
  assert.deepEqual([...parsed.searchParams.keys()], ['marketplacePath']);
  assert.equal(parsed.searchParams.get('marketplacePath'), path.join(root, '.agents', 'plugins', 'marketplace.json'));
  assert.ok(!uri.includes("'"), 'The URL must be safe inside the Windows launcher handoff.');
});
