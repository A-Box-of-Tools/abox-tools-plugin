import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createLiveManager } from '../src/live.mjs';
import { findBrowser } from '../src/browser.mjs';

// Explicitly opt in: these tests create their own ephemeral service rooms.
// Browser-generated media and synthetic bytes are the only transmitted content.
const enabled = process.env.ABOX_TEST_LIVE_NETWORK === '1';
const executablePath = enabled ? await findBrowser() : null;
function managerForTest() {
  return createLiveManager({ browserPath: async () => executablePath, launch: async options => {
    const browser = await chromium.launch({ ...options, headless: true,
      args: [...options.args, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const context = browser.newContext.bind(browser);
    browser.newContext = async settings => {
      const value = await context(settings);
      await value.addInitScript(() => {
        const original = MediaStreamTrack.prototype.stop;
        window.testVideoStopCallers = [];
        MediaStreamTrack.prototype.stop = function (...args) {
          if (this.kind === 'video' && window.testVideoStopCallers.length < 8) window.testVideoStopCallers.push(new Error().stack.split('\n').slice(1, 7).map(line => /at ([A-Za-z0-9_.]+)/.exec(line)?.[1] ?? 'anonymous'));
          return original.apply(this, args);
        };
        const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          if (!constraints.video) return nativeGetUserMedia(constraints);
          if (constraints.audio) throw new Error('Synthetic camera test is video-only.');
          // A generated source makes video input independent of the native
          // fake-camera driver while retaining real MediaStream/RTP/decoder
          // and service behavior.
          const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
          const drawing = canvas.getContext('2d');
          const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
          let frame = 0;
          const draw = () => { drawing.fillStyle = frame++ % 2 ? '#ff3020' : '#2080ff'; drawing.fillRect(0, 0, 160, 96); track.requestFrame(); };
          const timer = setInterval(draw, 100); draw();
          const stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); stop(); };
          return stream;
        };
      });
      return value;
    };
    return browser;
  } });
}
async function awaitStatus(manager, session_id, predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await manager.status({ session_id });
    if (predicate(value)) return value;
    if (value.phase === 'error') throw new Error('The test session reached a transport error.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The test peer did not reach its expected state before the deadline.');
}

test('existing pairing service joins two private share peers and transfers exact synthetic file bytes', { skip: !enabled || !executablePath, timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abox-live-peer-'));
  assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('abox-live-peer-'));
  const manager = managerForTest();
  t.after(async () => { await manager.closeAll(); await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'synthetic.bin'), output = path.join(directory, 'received');
  const bytes = Buffer.from(Array.from({ length: 70000 }, (_, index) => index % 256));
  await writeFile(source, bytes);
  const host = await manager.start('share-text', { role: 'host', room_name: `test-${randomUUID()}`, input_paths: [source] });
  const hostPage = manager.testPage(host.session_id);
  await hostPage.locator('#share-text').fill('Synthetic peer test text');
  await hostPage.locator('#start').click();
  await hostPage.locator('#invitation-row').waitFor({ state: 'visible' });
  const invitation = await hostPage.locator('#invitation').inputValue();
  await awaitStatus(manager, host.session_id, value => value.phase === 'waiting');
  const reader = await manager.start('share-text', { role: 'reader', output_dir: output });
  const readerPage = manager.testPage(reader.session_id);
  await readerPage.locator('#room-name').fill(invitation);
  await readerPage.locator('#start').click();
  await readerPage.locator('#knock').waitFor({ state: 'visible', timeout: 45000 });
  assert.equal(await readerPage.locator('#received-text').textContent(), '');
  await readerPage.locator('#knock').click();
  await hostPage.getByRole('button', { name: 'Approve reader', exact: true }).click({ timeout: 30000 });
  await readerPage.waitForFunction(() => document.getElementById('received-text').textContent === 'Synthetic peer test text', { timeout: 30000 });
  await readerPage.getByRole('button', { name: 'Receive and save', exact: true }).click();
  await awaitStatus(manager, reader.session_id, value => value.saved_files === 1);
  const files = await readdir(output);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(path.join(output, files[0])), bytes);
  await hostPage.locator('#stop').click();
  await awaitStatus(manager, host.session_id, value => value.phase === 'stopped');
});

test('existing camera pairing with fake capture withholds frames until viewer approval', { skip: !enabled || !executablePath, timeout: 90000 }, async t => {
  const manager = managerForTest();
  t.after(() => manager.closeAll());
  const host = await manager.start('remote-camera', { role: 'host' });
  const hostPage = manager.testPage(host.session_id);
  await hostPage.locator('#start').click();
  await hostPage.locator('#invitation-output').waitFor({ state: 'visible', timeout: 30000 });
  try {
    await hostPage.waitForFunction(() => { const video = document.getElementById('camera'); return video.videoWidth > 0 && video.currentTime > 0 && video.srcObject.getVideoTracks().every(track => track.readyState === 'live'); }, null, { timeout: 15000 });
  } catch {
    const source = await hostPage.locator('#camera').evaluate(video => ({ width: video.videoWidth, time: video.currentTime, paused: video.paused, ready: video.readyState, tracks: video.srcObject?.getVideoTracks().map(track => ({ ready: track.readyState, muted: track.muted, enabled: track.enabled })) ?? [] }));
    const message = await hostPage.locator('#status').textContent();
    const stopCallers = await hostPage.evaluate(() => window.testVideoStopCallers);
    throw new Error(`Synthetic camera preview failed before joining: ${JSON.stringify({ source, message, stopCallers })}`);
  }
  const invitation = await hostPage.locator('#share-link').inputValue();
  const viewer = await manager.start('remote-camera', { role: 'viewer' });
  const viewerPage = manager.testPage(viewer.session_id);
  await viewerPage.locator('#invitation').fill(invitation);
  await viewerPage.locator('#start').click();
  await hostPage.getByRole('button', { name: 'Approve viewer', exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await viewerPage.locator('#camera').evaluate(node => node.srcObject?.getVideoTracks().length ?? 0), 0);
  const sourceLive = await hostPage.locator('#camera').evaluate(video => video.srcObject?.getVideoTracks().every(track => track.readyState === 'live'));
  if (!sourceLive) throw new Error(`The source capture ended before approval: ${JSON.stringify(await hostPage.evaluate(() => ({ stopCallers: window.testVideoStopCallers, hidden: document.hidden })))}`);
  await hostPage.getByRole('button', { name: 'Approve viewer', exact: true }).click();
  try {
    await viewerPage.waitForFunction(() => { const video = document.getElementById('camera'); return video.videoWidth > 0 && video.currentTime > 0; }, null, { timeout: 30000 });
  } catch {
    const view = await viewerPage.locator('#camera').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime, paused: video.paused, ready: video.readyState, tracks: video.srcObject?.getVideoTracks().map(track => ({ ready: track.readyState, muted: track.muted })) ?? [] }));
    const source = await hostPage.locator('#camera').evaluate(video => ({ width: video.videoWidth, time: video.currentTime, tracks: video.srcObject?.getVideoTracks().map(track => ({ ready: track.readyState, muted: track.muted })) ?? [] }));
    const hostState = await manager.status({ session_id: host.session_id }), viewerState = await manager.status({ session_id: viewer.session_id });
    const hostMessage = await hostPage.locator('#status').textContent(), viewerMessage = await viewerPage.locator('#status').textContent();
    throw new Error(`Synthetic camera frames did not arrive: ${JSON.stringify({ view, source, host: { phase: hostState.phase, peers: hostState.peer_count, message: hostMessage }, viewer: { phase: viewerState.phase, peers: viewerState.peer_count, message: viewerMessage } })}`);
  }
  await awaitStatus(manager, viewer.session_id, value => value.connected);
  await hostPage.locator('#stop').click();
  assert.equal(await hostPage.locator('#camera').evaluate(node => node.srcObject), null);
  await awaitStatus(manager, host.session_id, value => value.capture === 'none' && value.phase === 'stopped');
});

for (const [tool, receiverRole, sourceRole] of [['walkie-talkie', 'listener', 'host'], ['voice-oncall', 'host', 'sender']]) {
  test(`existing ${tool} pairing carries fake push-to-talk audio and releases capture`, { skip: !enabled || !executablePath, timeout: 90000 }, async t => {
    const manager = managerForTest();
    t.after(() => manager.closeAll());
    const host = await manager.start(tool, { role: 'host', room_name: 'Synthetic peer test' });
    const hostPage = manager.testPage(host.session_id);
    await hostPage.locator('#start').click();
    await hostPage.locator('#invitation-output').waitFor({ state: 'visible', timeout: 30000 });
    const invitation = await hostPage.locator('#share-link').inputValue();
    const peer = await manager.start(tool, { role: tool === 'walkie-talkie' ? 'listener' : 'sender' });
    const peerPage = manager.testPage(peer.session_id);
    await peerPage.locator('#invitation').fill(invitation);
    await peerPage.locator('#start').click();
    const source = sourceRole === 'host' ? host : peer, receiver = receiverRole === 'host' ? host : peer;
    const sourcePage = manager.testPage(source.session_id), receiverPage = manager.testPage(receiver.session_id);
    await awaitStatus(manager, source.session_id, value => value.connected);
    await awaitStatus(manager, receiver.session_id, value => value.connected);
    await receiverPage.locator('#sound').click();
    await sourcePage.locator('#talk').focus();
    await sourcePage.keyboard.down('Space');
    await receiverPage.waitForFunction(() => [...document.querySelectorAll('audio')].some(node => node.srcObject?.getAudioTracks().some(track => track.readyState === 'live') && node.currentTime > 0), { timeout: 30000 });
    await sourcePage.keyboard.up('Space');
    assert.equal(await sourcePage.locator('#talk').getAttribute('aria-pressed'), 'false');
    await sourcePage.locator('#stop').click();
    await awaitStatus(manager, source.session_id, value => value.phase === 'stopped' && value.capture === 'none');
  });
}
