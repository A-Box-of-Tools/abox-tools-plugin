import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cursorServerConfig, installerUrl } from '../scripts/open-installer.mjs';

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

test('Cursor links preserve Unicode paths and select the bundled runtime on every platform', () => {
  const root = path.resolve("O'Brien & 100% Québec", 'abox tools');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const parsed = new URL(installerUrl(root, 'cursor', { platform }));
    assert.equal(parsed.protocol, 'cursor:');
    assert.equal(parsed.hostname, 'anysphere.cursor-deeplink');
    assert.equal(parsed.pathname, '/mcp/install');
    assert.equal(parsed.searchParams.get('name'), 'abox-tools');
    const config = JSON.parse(Buffer.from(parsed.searchParams.get('config'), 'base64').toString('utf8'));
    assert.deepEqual(config, cursorServerConfig(root, { platform }));
    assert.equal(config.command, path.join(root, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
    assert.deepEqual(config.args, [path.join(root, 'bin', 'abox-mcp.mjs')]);
    assert.ok(!parsed.href.includes("'"));
  }
  assert.throws(() => installerUrl(root, 'unknown'), /Choose codex or cursor/);
});
