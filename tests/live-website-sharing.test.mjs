import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createLiveManager, allowedLiveSocket } from '../src/live.mjs';
import { findBrowser } from '../src/browser.mjs';

// Opt in explicitly: the counterpart is the currently published website, not a
// fixture or a local copy. Only this test's synthetic data enters fresh rooms.
const enabled = process.env.ABOX_TEST_LIVE_WEBSITE === '1';
const executablePath = enabled ? await findBrowser() : null;
const options = { skip: !enabled || !executablePath, timeout: 120000 };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const boundedPush = (list, value, maximum = 16) => { if (list.length < maximum) list.push(value); };
function safeFailure(value) {
  const text = String(value ?? '');
  const network = /net::(ERR_[A-Z0-9_]{1,64})/.exec(text); if (network) return network[1];
  const upgrade = /(?:response code|status(?: code)?)[\s:]+([1-5][0-9]{2})/i.exec(text); if (upgrade) return `HTTP_${upgrade[1]}`;
  if (/does not provide an export named/.test(text)) return 'MISSING_MODULE_EXPORT';
  if (/Failed to fetch dynamically imported module/.test(text)) return 'MODULE_FETCH_FAILED';
  if (/Cannot read properties|Cannot set properties/.test(text)) return 'UNDEFINED_PROPERTY';
  if (/not a function/.test(text)) return 'NOT_A_FUNCTION';
  if (/not defined/.test(text)) return 'UNDEFINED_BINDING';
  return 'UNCLASSIFIED_FAILURE';
}
function socketShape(url, allowed, sameRoom) {
  const take = (key, values) => values.includes(url.searchParams.get(key)) ? url.searchParams.get(key) : url.searchParams.has(key) ? '[other]' : null;
  return { family: url.pathname.startsWith('/ws/') ? 'ws' : /discover/.test(url.pathname) ? 'discover' : 'other',
    query_keys: [...new Set([...url.searchParams.keys()].map(key => ['role', 'local', 'tool', 'transport', 'discover'].includes(key) ? key : '[other]'))].slice(0, 8),
    role: take('role', ['host', 'viewer']), local: take('local', ['1']), tool: take('tool', ['remote-camera', 'share-text']),
    transport: take('transport', ['direct', 'relay']), allowed, same_room: sameRoom };
}

function companionManager() {
  return createLiveManager({ browserPath: async () => executablePath, launch: async settings => {
    const browser = await chromium.launch({ ...settings, headless: true });
    const createContext = browser.newContext.bind(browser);
    browser.newContext = async config => {
      const context = await createContext(config);
      await context.addInitScript(() => {
        // The production capture engine still owns lifecycle and track cleanup.
        // This test replaces only the device source with generated canvas video.
        navigator.mediaDevices.enumerateDevices = async () => [];
        navigator.mediaDevices.getUserMedia = async constraints => {
          if (!constraints?.video || constraints.audio) throw new Error('This interoperability test permits generated video only.');
          const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
          const drawing = canvas.getContext('2d'), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
          let frame = 0;
          const draw = () => { drawing.fillStyle = frame++ % 2 ? '#ff3020' : '#2080ff'; drawing.fillRect(0, 0, 160, 96); track.requestFrame(); };
          const timer = setInterval(draw, 100), stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); stop(); }; draw(); return stream;
        };
      });
      return context;
    };
    return browser;
  } });
}

async function websiteReader(t, tool, invitation, directory) {
  const url = new URL(invitation), code = url.hash.slice(1);
  assert.equal(url.origin, 'https://abox.tools'); assert.equal(url.pathname, `/${tool}/`);
  assert.match(code, /^[a-z0-9-]{1,64}$/);
  if (tool === 'share-text') assert.equal(url.searchParams.get('local'), '1');
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: tool === 'share-text', permissions: [] });
  const network = { allowedHttp: 0, blockedHttp: 0, allowedSockets: 0, blockedSockets: 0, socket_attempts: [], failed_assets: [], page_errors: [], socket_errors: [], sent_frames: 0, received_frames: 0 };
  const failedAsset = (raw, details) => {
    let asset; try { asset = new URL(raw); } catch { return; }
    if (asset.origin !== 'https://abox.tools') return;
    // Static first-party asset paths are useful; never include query strings,
    // fragments, external paths or even this test's ephemeral room name.
    boundedPush(network.failed_assets, { path: asset.pathname.replaceAll(code, '[room]').slice(0, 180), ...details });
  };
  context.on('requestfailed', request => failedAsset(request.url(), { error: safeFailure(request.failure()?.errorText) }));
  context.on('response', response => { if (response.status() >= 400) failedAsset(response.url(), { status: response.status() }); });
  await context.route('**/*', route => {
    let destination; try { destination = new URL(route.request().url()); } catch { network.blockedHttp++; return route.abort('blockedbyclient'); }
    if (destination.origin !== 'https://abox.tools' || destination.username || destination.password || route.request().method() !== 'GET') {
      network.blockedHttp++; return route.abort('blockedbyclient');
    }
    network.allowedHttp++; return route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    let destination; try { destination = new URL(socket.url()); } catch { network.blockedSockets++; return socket.close({ code: 1008 }); }
    // The current website explicitly names its direct transport. The pinned
    // companion source predates this optional query field; neither permits a
    // relay here. Normalize only that field in this website-only test guard.
    const transports = destination.searchParams.getAll('transport'), validation = new URL(destination);
    const direct = transports.length === 0 || transports.length === 1 && transports[0] === 'direct'; validation.searchParams.delete('transport');
    const sameRoom = destination.pathname === `/ws/${code}`, allowed = direct && allowedLiveSocket(validation.href, tool) && sameRoom && destination.searchParams.get('role') === 'viewer';
    boundedPush(network.socket_attempts, socketShape(destination, allowed, sameRoom));
    if (!allowed) {
      network.blockedSockets++; return socket.close({ code: 1008, reason: 'Only this synthetic test room is permitted.' });
    }
    network.allowedSockets++; socket.connectToServer();
  });
  await context.addInitScript(() => {
    window.interopFacts = { deviceRequests: 0, receivedVideoTracks: 0, configuredIceServers: false };
    const deny = async () => { window.interopFacts.deviceRequests++; throw new Error('Website counterpart device access is disabled for this test.'); };
    navigator.mediaDevices.getUserMedia = deny;
    navigator.mediaDevices.getDisplayMedia = deny;
    navigator.mediaDevices.enumerateDevices = async () => [];
    const Native = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = new Proxy(Native, { construct(Target, args, NewTarget) {
      const peer = Reflect.construct(Target, args, NewTarget);
      window.interopFacts.configuredIceServers ||= Boolean(peer.getConfiguration().iceServers?.length);
      peer.addEventListener('track', event => { if (event.track.kind === 'video') window.interopFacts.receivedVideoTracks++; });
      return peer;
    } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => boundedPush(network.page_errors, { name: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError'].includes(error.name) ? error.name : 'OtherError', error: safeFailure(error.message) }, 8));
  page.on('websocket', socket => {
    socket.on('socketerror', error => boundedPush(network.socket_errors, safeFailure(error), 8));
    socket.on('framesent', () => { network.sent_frames = Math.min(100000, network.sent_frames + 1); });
    socket.on('framereceived', () => { network.received_frames = Math.min(100000, network.received_frames + 1); });
  });
  context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
  const response = await page.goto(invitation, { waitUntil: 'load', timeout: 45000 });
  assert.equal(response?.status(), 200, 'The actual website tool must load successfully.');
  assert.equal(page.url().split('#')[0], invitation.split('#')[0]);
  assert.ok(network.allowedHttp > 0);
  return { page, network, downloadPath: name => path.join(directory, name) };
}

async function diagnosed(stage, website, manager, session_id, work) {
  try { return await work(); }
  catch {
    let ui = { unavailable: true }, companion = { unavailable: true };
    try { ui = await website.page.evaluate(() => {
      const shown = id => { const node = document.getElementById(id); return node ? !node.hidden && getComputedStyle(node).display !== 'none' : null; };
      const key = id => {
        const value = document.getElementById(id)?.textContent.trim();
        const match = [...document.querySelectorAll('#phrases [data-phrase]')].find(node => node.textContent.trim() === value)?.dataset.phrase;
        return match && /^(?:view|viewer|camera|connection|debug|error)\.[a-z0-9.-]{1,64}$/.test(match) ? match : value ? '[unmatched fixed status]' : null;
      };
      const version = document.getElementById('tool-version')?.textContent.trim();
      return { boot_warning: shown('boot-warning'), consent: shown('consent'), knock: shown('knockrow'), content: shown('panel'),
        viewer_connect: shown('viewer-connect'), viewer_connect_disabled: document.getElementById('viewer-connect')?.disabled ?? null,
        share_status_key: key('view-status'), camera_status_key: key('viewer-status'),
        video_tracks: document.getElementById('remote-video')?.srcObject?.getVideoTracks().length ?? 0,
        tool_version: version && /^[a-f0-9]{6,64}$/.test(version) ? version : null,
        facts: { device_requests: window.interopFacts?.deviceRequests ?? null, received_video_tracks: window.interopFacts?.receivedVideoTracks ?? null } };
    }); } catch {}
    try { const status = await manager.status({ session_id }); companion = { phase: status.phase, connected: status.connected, peer_count: status.peer_count, capture: status.capture }; } catch {}
    throw new Error(`Website interoperability failed at ${stage}: ${JSON.stringify({ network: website.network, ui, companion })}`);
  }
}

async function statusUntil(manager, session_id, predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const status = await manager.status({ session_id });
    if (predicate(status)) return status;
    if (status.phase === 'error') throw new Error('The synthetic companion session reached a connection error.');
    await pause(100);
  }
  throw new Error('The synthetic companion did not reach the expected state.');
}
async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'abox-live-website-')));
  assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('abox-live-website-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('companion private share interoperates with the actual abox.tools reader and exact native file download', options, async t => {
  const directory = await temporary(t), manager = companionManager(); t.after(() => manager.closeAll());
  const source = path.join(directory, 'synthetic website binary.bin'), bytes = Buffer.from(Array.from({ length: 70000 }, (_, at) => at % 256));
  await writeFile(source, bytes, { flag: 'wx' });
  const text = 'Synthetic website interoperability text.\n<b>Plain text</b> · 🦊';
  const host = await manager.start('share-text', { role: 'host', room_name: `website-${randomUUID()}`, input_paths: [source] });
  const hostPage = manager.testPage(host.session_id);
  await hostPage.locator('#share-text').fill(text); await hostPage.locator('#start').click();
  await hostPage.locator('#invitation-row').waitFor({ state: 'visible' });
  await statusUntil(manager, host.session_id, value => value.phase === 'waiting');
  const invitation = await hostPage.locator('#invitation').inputValue(), website = await websiteReader(t, 'share-text', invitation, directory), reader = website.page;
  await diagnosed('share-consent', website, manager, host.session_id, () => reader.locator('#consent').waitFor({ state: 'visible' }));
  assert.equal(await reader.locator('#received').textContent(), ''); assert.equal(await hostPage.locator('#requests button').count(), 0);
  await reader.locator('#connect').click();
  await diagnosed('share-private-request', website, manager, host.session_id, () => reader.locator('#knockrow').waitFor({ state: 'visible' }));
  assert.equal(await reader.locator('#received').textContent(), ''); assert.equal(await reader.locator('#filelist button[data-file-download]').count(), 0);
  await reader.locator('#knock').fill('Synthetic website reader'); await reader.locator('#send-knock').click();
  const approve = hostPage.getByRole('button', { name: 'Approve reader', exact: true });
  await diagnosed('share-owner-approval', website, manager, host.session_id, () => approve.waitFor({ timeout: 45000 }));
  assert.equal(await reader.locator('#received').textContent(), ''); assert.equal(await reader.locator('#filelist button[data-file-download]').count(), 0);
  await approve.click();
  await diagnosed('share-text', website, manager, host.session_id, () => reader.waitForFunction(expected => document.getElementById('received').textContent === expected, text, { timeout: 30000 }));
  assert.equal(await reader.locator('#received b').count(), 0, 'Shared text must remain plain text.');
  const fileButton = reader.locator('#filelist button[data-file-download]'); await fileButton.waitFor({ state: 'visible' });
  assert.equal(await reader.locator('#filelist .fname').textContent(), path.basename(source));
  const waitingDownload = reader.waitForEvent('download', { timeout: 45000 }); await fileButton.click();
  const download = await waitingDownload, received = website.downloadPath('website-received.bin');
  assert.equal(download.suggestedFilename(), path.basename(source)); await download.saveAs(received); assert.equal(await download.failure(), null);
  assert.deepEqual(await readFile(received), bytes); assert.deepEqual(await readFile(source), bytes);
  const updated = `${text}\nSynthetic live update.`; await hostPage.locator('#share-text').fill(updated); await hostPage.locator('#update-text').click();
  await reader.waitForFunction(expected => document.getElementById('received').textContent === expected, updated, { timeout: 15000 });
  const facts = await reader.evaluate(() => window.interopFacts); assert.equal(facts.deviceRequests, 0); assert.equal(facts.configuredIceServers, false);
  assert.ok(website.network.allowedSockets >= 1);
  await hostPage.locator('#stop').click(); await statusUntil(manager, host.session_id, value => value.phase === 'stopped');
  await reader.waitForFunction(() => document.getElementById('received').textContent === '', null, { timeout: 15000 });
});

test('companion generated camera interoperates with the actual website viewer only after explicit approval', options, async t => {
  const directory = await temporary(t), manager = companionManager(); t.after(() => manager.closeAll());
  const host = await manager.start('remote-camera', { role: 'host' }), hostPage = manager.testPage(host.session_id);
  await hostPage.locator('#start').click(); await hostPage.locator('#invitation-output').waitFor({ state: 'visible', timeout: 30000 });
  await hostPage.waitForFunction(() => { const video = document.getElementById('camera'); return video.videoWidth === 160 && video.videoHeight === 96 && video.currentTime > 0; }, null, { timeout: 15000 });
  const invitation = await hostPage.locator('#share-link').inputValue(), website = await websiteReader(t, 'remote-camera', invitation, directory), viewer = website.page;
  await viewer.locator('#viewer-connect').waitFor({ state: 'visible' });
  assert.equal(await viewer.locator('#remote-video').evaluate(video => video.srcObject?.getVideoTracks().length ?? 0), 0);
  await viewer.locator('#viewer-name').fill('Synthetic website viewer'); await viewer.locator('#viewer-connect').click();
  const approve = hostPage.getByRole('button', { name: 'Approve viewer', exact: true });
  await diagnosed('camera-owner-approval', website, manager, host.session_id, () => approve.waitFor({ timeout: 45000 }));
  assert.equal(await viewer.locator('#remote-video').evaluate(video => video.srcObject?.getVideoTracks().length ?? 0), 0);
  const before = await viewer.evaluate(() => window.interopFacts); assert.equal(before.receivedVideoTracks, 0); assert.equal(before.deviceRequests, 0);
  await approve.click();
  await diagnosed('camera-video', website, manager, host.session_id, () => viewer.waitForFunction(() => { const video = document.getElementById('remote-video'); return video.videoWidth === 160 && video.videoHeight === 96 && video.currentTime > 0 && video.srcObject?.getVideoTracks().some(track => track.readyState === 'live'); }, null, { timeout: 30000 }));
  const initial = await viewer.locator('#remote-video').evaluate(video => ({ time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames }));
  await viewer.waitForFunction(previous => { const video = document.getElementById('remote-video'); return video.currentTime > previous.time + 0.2 && video.getVideoPlaybackQuality().totalVideoFrames > previous.frames; }, initial, { timeout: 10000 });
  const facts = await viewer.evaluate(() => window.interopFacts); assert.ok(facts.receivedVideoTracks >= 1); assert.equal(facts.deviceRequests, 0); assert.equal(facts.configuredIceServers, false);
  assert.ok(website.network.allowedSockets >= 1);
  await statusUntil(manager, host.session_id, value => value.connected && value.capture === 'camera');
  await hostPage.locator('#stop').click(); await statusUntil(manager, host.session_id, value => value.phase === 'stopped' && value.capture === 'none');
  assert.equal(await hostPage.locator('#camera').evaluate(video => video.srcObject), null);
});
