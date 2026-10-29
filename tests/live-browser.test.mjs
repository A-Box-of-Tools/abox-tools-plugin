import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createLiveManager, LIVE_ORIGIN } from '../src/live.mjs';
import { findBrowser } from '../src/browser.mjs';

const executablePath = await findBrowser();
function isolated() {
  let socketCount = 0;
  const manager = createLiveManager({ browserPath: async () => executablePath,
    launch: options => chromium.launch({ ...options, headless: true }),
    connectSocket: () => { socketCount++; throw new Error('A passive window attempted pairing.'); },
  });
  return { manager, sockets: () => socketCount };
}

test('all eight live roles load bundled controls without pairing or capture', { skip: !executablePath, timeout: 120000 }, async t => {
  const { manager, sockets } = isolated();
  t.after(() => manager.closeAll());
  for (const [tool, roles] of Object.entries({ 'share-text': ['host', 'reader'], 'remote-camera': ['host', 'viewer'], 'walkie-talkie': ['host', 'listener'], 'voice-oncall': ['host', 'sender'] })) {
    for (const role of roles) {
      const result = await manager.start(tool, { role });
      const page = manager.testPage(result.session_id);
      assert.equal(page.url().startsWith(LIVE_ORIGIN), true);
      assert.equal(await page.locator('main').count(), 1);
      assert.equal(await page.locator('#start').isEnabled(), true);
      const current = await manager.status({ session_id: result.session_id });
      assert.equal(current.phase, 'idle'); assert.equal(current.capture, 'none'); assert.equal(current.peer_count, 0);
      assert.equal(sockets(), 0);
      await manager.stop({ session_id: result.session_id });
      assert.equal(page.isClosed(), true);
    }
  }
});

test('the main-frame binding bounds local saves and does not expose source paths or remote names', { skip: !executablePath, timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abox-live-browser-'));
  const { manager, sockets } = isolated();
  t.after(async () => { await manager.closeAll(); await rm(directory, { recursive: true, force: true }); });
  const attachment = path.join(directory, 'private-source.bin');
  const text = path.join(directory, 'private-note.txt');
  await writeFile(attachment, Buffer.from([0, 255, 1, 9]));
  await writeFile(text, 'A private local note');
  const hosted = await manager.start('share-text', { role: 'host', input_paths: [attachment], text_path: text });
  const hostPage = manager.testPage(hosted.session_id);
  assert.equal(await hostPage.locator('#attachments').evaluate(input => input.files.length), 1);
  assert.equal(await hostPage.locator('#text-input').evaluate(input => input.files.length), 1);
  assert.ok(!JSON.stringify(hosted).includes('private-source'));
  assert.ok(!JSON.stringify(await hostPage.evaluate(() => window.aboxLive({ kind: 'config' }))).includes(directory));
  await manager.stop({ session_id: hosted.session_id });
  const output = path.join(directory, 'received');
  const result = await manager.start('share-text', { role: 'reader', output_dir: output, room_name: 'private-room-name' });
  const page = manager.testPage(result.session_id);
  const saved = await page.evaluate(async () => {
    const { id } = await window.aboxLive({ kind: 'save-begin', type: 'file', name: '../../untrusted.exe', size: 4 });
    await window.aboxLive({ kind: 'save-chunk', id, offset: 0, base64: 'AP8BCQ==' });
    return window.aboxLive({ kind: 'save-end', id });
  });
  assert.match(saved.filename, /^received-[a-f0-9-]+\.bin$/);
  assert.deepEqual(await readFile(path.join(output, saved.filename)), Buffer.from([0, 255, 1, 9]));
  for (const request of [{ kind: 'status', phase: 'private-content', connected: false, peer_count: 0, capture: 'none' }, { kind: 'config', path: attachment }, { kind: 'readFile', path: attachment }]) {
    assert.equal(await page.evaluate(async value => { try { await window.aboxLive(value); return false; } catch { return true; } }, request), true);
  }
  const status = await manager.status({ session_id: result.session_id });
  assert.equal(status.saved_files, 1); assert.equal(status.saved_bytes, 4);
  assert.ok(!JSON.stringify(status).includes('private-room-name'));
  assert.ok(!JSON.stringify(status).includes('untrusted.exe'));
  await page.evaluate(async () => { await window.aboxLive({ kind: 'save-begin', type: 'file', size: 10 }); });
  await manager.stop({ session_id: result.session_id });
  assert.deepEqual(await readdir(output), [saved.filename]);
  assert.equal(sockets(), 0);
});

test('foreign frames and attempted navigation cannot acquire the local binding', { skip: !executablePath, timeout: 60000 }, async t => {
  const { manager } = isolated();
  t.after(() => manager.closeAll());
  const result = await manager.start('remote-camera', { role: 'viewer' });
  const page = manager.testPage(result.session_id);
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.name = 'untrusted'; document.body.append(frame); });
  const frame = page.frames().find(value => value !== page.mainFrame());
  assert.ok(frame);
  const refused = await frame.evaluate(async () => { try { await window.aboxLive({ kind: 'config' }); return false; } catch { return true; } });
  assert.equal(refused, true);
  const externalFetchRefused = await page.evaluate(async () => { try { await fetch('https://example.com/private'); return false; } catch { return true; } });
  assert.equal(externalFetchRefused, true);
  await assert.rejects(page.goto('http://127.0.0.1:48372/private-user-file'));
  await manager.stop({ session_id: result.session_id });
});
