import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { allowedLiveSocket, createLiveManager, LIVE_LIMITS, LIVE_ORIGIN } from '../src/live.mjs';

const code = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// These interfaces record browser calls without launching a browser, opening a
// socket or requesting any device. Real UI behavior has separate browser tests.
function fakeBrowser({ beforeLaunch, beforeGoto } = {}) {
  const instances = [], options = [];
  const launch = async settings => {
    options.push(settings);
    const events = new EventEmitter(), contextEvents = new EventEmitter(), pageEvents = new EventEmitter();
    let currentUrl = 'about:blank';
    const frame = { url: () => currentUrl };
    const page = {
      bindings: new Map(), inputs: [], navigations: [], mainFrame: () => frame,
      on: (...args) => pageEvents.on(...args),
      exposeBinding: async (name, callback) => { page.bindings.set(name, callback); },
      goto: async url => {
        page.navigations.push(url); currentUrl = url; await beforeGoto?.(page);
        await page.invoke({ kind: 'config' });
        await page.invoke({ kind: 'status', phase: 'idle', connected: false, peer_count: 0, capture: 'none' });
      },
      locator: selector => ({ setInputFiles: async files => { page.inputs.push({ selector, files }); } }),
      close: async () => { pageEvents.emit('close'); },
      invoke: (request, source = { page, frame }) => page.bindings.get('aboxLive')(source, request),
      setUrl: url => { currentUrl = url; },
    };
    const context = {
      options: null, http: null, websocket: null,
      route: async (_pattern, callback) => { context.http = callback; },
      routeWebSocket: async (_pattern, callback) => { context.websocket = callback; },
      newPage: async () => page,
      on: (...args) => contextEvents.on(...args),
      popup: extra => contextEvents.emit('page', extra),
    };
    const browser = {
      page, context, closed: false, closeCalls: 0,
      on: (...args) => events.on(...args),
      newContext: async value => { context.options = value; return context; },
      close: async () => { browser.closeCalls++; if (!browser.closed) { browser.closed = true; events.emit('disconnected'); } },
    };
    instances.push(browser); await beforeLaunch?.(browser); return browser;
  };
  return { launch, instances, options };
}

async function fixture(t, behavior, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-live-'))), fake = fakeBrowser(behavior);
  const manager = createLiveManager({ launch: fake.launch, browserPath: async () => process.execPath, ...options });
  t.after(async () => { await manager.closeAll(); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, fake };
}

function httpRoute(url, { method = 'GET', frame, navigation = false } = {}) {
  const result = { aborted: false, fulfilled: null };
  return { result, request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation, frame: () => frame }),
    abort: async () => { result.aborted = true; }, fulfill: async response => { result.fulfilled = response; } };
}

test('live sockets admit only each tool’s exact rendezvous protocol and reject URL/query confusion', () => {
  const good = [
    [`wss://rendezvous.abox.tools/ws/room?role=host&local=1`, 'share-text'],
    [`wss://rendezvous.abox.tools/ws/room?role=viewer&local=1&tool=remote-camera`, 'remote-camera'],
    [`wss://rendezvous.abox.tools/broadcast/${code}`, 'walkie-talkie'],
    [`wss://rendezvous.abox.tools/inbox/${code}`, 'voice-oncall'],
  ];
  for (const [url, tool] of good) assert.equal(allowedLiveSocket(url, tool), true);
  const bad = [
    ['https://rendezvous.abox.tools/ws/room?role=host&local=1', 'share-text'],
    ['wss://rendezvous.abox.tools.evil.invalid/ws/room?role=host&local=1', 'share-text'],
    ['wss://user:secret@rendezvous.abox.tools/ws/room?role=host&local=1', 'share-text'],
    ['wss://rendezvous.abox.tools:8443/ws/room?role=host&local=1', 'share-text'],
    ['wss://rendezvous.abox.tools/ws/room?role=host&role=viewer&local=1', 'share-text'],
    ['wss://rendezvous.abox.tools/ws/room?role=host&local=0', 'share-text'],
    ['wss://rendezvous.abox.tools/ws/room?role=host&local=1&relay=1', 'share-text'],
    ['wss://rendezvous.abox.tools/ws/room?role=host&tool=remote-camera', 'remote-camera'],
    ['wss://rendezvous.abox.tools/ws/%2e%2e?role=host&local=1', 'share-text'],
    [`wss://rendezvous.abox.tools/broadcast/${code}?role=host`, 'walkie-talkie'],
    [`wss://rendezvous.abox.tools/inbox/${code}#private`, 'voice-oncall'],
    [`wss://rendezvous.abox.tools/inbox/${code}`, 'walkie-talkie'],
  ];
  for (const [url, tool] of bad) assert.equal(allowedLiveSocket(url, tool), false, url);
});

test('opening a companion isolates the visible context and keeps private configuration out of status', async t => {
  const { manager, fake } = await fixture(t), secret = 'PRIVATE ROOM LABEL';
  const result = await manager.start('voice-oncall', { role: 'host', room_name: secret });
  assert.equal(fake.options[0].headless, false); assert.equal(fake.options[0].chromiumSandbox, true);
  assert.equal(fake.options[0].args.some(value => /fake-device|fake-ui|no-sandbox|use-file-for-fake/.test(value)), false);
  assert.deepEqual(fake.instances[0].context.options, { serviceWorkers: 'block', acceptDownloads: false });
  assert.equal(result.browser_opened, true); assert.equal(result.phase, 'idle'); assert.equal(result.capture, 'none');
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(await manager.status()).includes(secret), false);
  const config = await fake.instances[0].page.invoke({ kind: 'config' }); assert.equal(config.room_name, secret);
  assert.equal(config.tool, 'voice-oncall'); assert.equal(config.role, 'host');
  await fake.instances[0].page.invoke({ kind: 'status', phase: 'connected', connected: true, peer_count: 2, capture: 'microphone' });
  const status = await manager.status({ session_id: result.session_id }); assert.equal(status.peer_count, 2); assert.equal(status.capture, 'microphone');
  await assert.rejects(fake.instances[0].page.invoke({ kind: 'status', phase: secret, connected: true, peer_count: 2, capture: 'none' }), { message: 'LIVE_REQUEST' });
});

test('binding authorization rejects other pages, child frames, navigation and unknown fields', async t => {
  const { manager, fake } = await fixture(t), result = await manager.start('remote-camera', { role: 'viewer' }), page = fake.instances[0].page;
  for (const source of [{ page: {}, frame: page.mainFrame() }, { page, frame: { url: () => `${LIVE_ORIGIN}/live/media.html` } }]) {
    await assert.rejects(page.invoke({ kind: 'config' }, source), { message: 'LIVE_REQUEST' });
  }
  page.setUrl(`${LIVE_ORIGIN}/live/share.html`); await assert.rejects(page.invoke({ kind: 'config' }), { message: 'LIVE_REQUEST' });
  page.setUrl(`${LIVE_ORIGIN}/live/media.html`);
  await assert.rejects(page.invoke({ kind: 'config', filename: '/private' }), { message: 'LIVE_REQUEST' });
  await assert.rejects(page.invoke({ kind: 'read-file', name: '/private' }), { message: 'LIVE_REQUEST' });
  await assert.rejects(page.invoke({ kind: 'status', phase: 'connected', connected: true, peer_count: 33, capture: 'none' }), { message: 'LIVE_REQUEST' });
  await manager.stop({ session_id: result.session_id }); await assert.rejects(page.invoke({ kind: 'config' }), { message: 'LIVE_REQUEST' });
});

test('synthetic asset routes deny external requests, query strings, traversal and child navigation', async t => {
  const { manager, fake } = await fixture(t); await manager.start('remote-camera', { role: 'viewer' });
  const { page, context } = fake.instances[0], entry = `${LIVE_ORIGIN}/live/media.html`;
  const good = httpRoute(entry, { navigation: true, frame: page.mainFrame() }); await context.http(good);
  assert.equal(good.result.aborted, false); assert.equal(good.result.fulfilled.contentType, 'text/html');
  assert.ok(good.result.fulfilled.headers['content-security-policy'].includes("frame-src 'none'"));
  assert.equal(good.result.fulfilled.headers['cache-control'], 'no-store');
  const bad = [
    httpRoute('https://example.invalid/file'), httpRoute(`${entry}?secret=value`), httpRoute(entry, { method: 'POST' }),
    httpRoute(`${LIVE_ORIGIN}/live/%2e%2e/private`), httpRoute(`${LIVE_ORIGIN}/vendor/abox/../../package.json`),
    httpRoute(entry, { navigation: true, frame: {} }), httpRoute(`${LIVE_ORIGIN}/live/share.html`, { navigation: true, frame: page.mainFrame() }),
  ];
  for (const route of bad) { await context.http(route); assert.equal(route.result.aborted, true); assert.equal(route.result.fulfilled, null); }
  let popupClosed = false; context.popup({ close: async () => { popupClosed = true; } }); assert.equal(popupClosed, true);
  let connected = 0, refused = 0;
  context.websocket({ url: () => `wss://rendezvous.abox.tools/ws/room?role=viewer&local=1&tool=remote-camera`, connectToServer: () => { connected++; }, close: () => { refused++; } });
  context.websocket({ url: () => 'wss://example.invalid/private', connectToServer: () => { connected++; }, close: () => { refused++; } });
  assert.equal(connected, 1); assert.equal(refused, 1);
});

test('bounded saves preserve exact bytes under generated names without revealing content through status', async t => {
  const { directory, manager, fake } = await fixture(t), output = path.join(directory, 'received');
  const result = await manager.start('share-text', { role: 'reader', output_dir: output }), page = fake.instances[0].page;
  const bytes = Buffer.from('PRIVATE LOCAL PAYLOAD\r\n\0tail', 'utf8');
  const transfer = await page.invoke({ kind: 'save-begin', name: '../../chosen-name.txt', type: 'file', size: bytes.length });
  await page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: bytes.subarray(0, 7).toString('base64') });
  await page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 7, base64: bytes.subarray(7).toString('base64') });
  const saved = await page.invoke({ kind: 'save-end', id: transfer.id }); assert.match(saved.filename, /^received-[a-f0-9-]{36}\.bin$/);
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex')); assert.deepEqual(await readFile(path.join(output, saved.filename)), bytes);
  assert.deepEqual(await readdir(directory), ['received']); assert.deepEqual(await readdir(output), [saved.filename]);
  const status = await manager.status({ session_id: result.session_id }); assert.equal(status.saved_files, 1); assert.equal(status.saved_bytes, bytes.length);
  assert.equal(JSON.stringify(status).includes('PRIVATE LOCAL PAYLOAD'), false); assert.equal(JSON.stringify(status).includes(saved.sha256), false);
  assert.equal(JSON.stringify(status).includes('chosen-name'), false);
  const empty = await page.invoke({ kind: 'save-begin', type: 'text', size: 0 });
  const emptySaved = await page.invoke({ kind: 'save-end', id: empty.id }); assert.equal((await readFile(path.join(output, emptySaved.filename))).length, 0);
});

test('save admission rejects oversized, replayed, noncanonical and incomplete transfers', async t => {
  const { directory, manager, fake } = await fixture(t), output = path.join(directory, 'received');
  await manager.start('share-text', { role: 'reader', output_dir: output }); const page = fake.instances[0].page;
  await assert.rejects(page.invoke({ kind: 'save-begin', type: 'file', size: LIVE_LIMITS.file_bytes + 1 }), { message: 'LIVE_REQUEST' });
  const transfer = await page.invoke({ kind: 'save-begin', type: 'file', size: 2 });
  await assert.rejects(page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: 'AB==' }), { message: 'LIVE_REQUEST' });
  await assert.rejects(page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: 'A'.repeat(4 * Math.ceil(LIVE_LIMITS.chunk_bytes / 3) + 4) }), { message: 'LIVE_REQUEST' });
  await page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: 'AQ==' });
  await assert.rejects(page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: 'AQ==' }), { message: 'LIVE_REQUEST' });
  await assert.rejects(page.invoke({ kind: 'save-end', id: transfer.id }), { message: 'LIVE_REQUEST' });
  assert.equal((await readdir(output)).some(name => !name.startsWith('.partial-')), false);
  await page.invoke({ kind: 'save-cancel', id: transfer.id }); assert.deepEqual(await readdir(output), []);
  await assert.rejects(page.invoke({ kind: 'save-end', id: transfer.id }), { message: 'LIVE_REQUEST' });
});

test('simultaneous receive reservations are bounded and stopping removes unfinished files', async t => {
  const { directory, manager, fake } = await fixture(t), output = path.join(directory, 'received');
  const result = await manager.start('share-text', { role: 'reader', output_dir: output }), page = fake.instances[0].page;
  await page.invoke({ kind: 'save-begin', type: 'file', size: LIVE_LIMITS.file_bytes });
  await page.invoke({ kind: 'save-begin', type: 'file', size: LIVE_LIMITS.file_bytes });
  await assert.rejects(page.invoke({ kind: 'save-begin', type: 'file', size: 1 }), { message: 'LIVE_REQUEST' });
  assert.equal((await readdir(output)).length, 2);
  const stopped = await manager.stop({ session_id: result.session_id }); assert.equal(stopped.stopped, true); assert.equal(fake.instances[0].closed, true);
  assert.deepEqual(await readdir(output), []);
  await assert.rejects(manager.status({ session_id: result.session_id }), { code: 'LIVE_SESSION_UNKNOWN' });
  assert.equal((await manager.stop({ session_id: result.session_id })).already_closed, true);
});

test('Stop while save-end awaits disk publication cancels the new output', async t => {
  const { directory, manager, fake } = await fixture(t), output = path.join(directory, 'received');
  const result = await manager.start('share-text', { role: 'reader', output_dir: output }), page = fake.instances[0].page;
  const transfer = await page.invoke({ kind: 'save-begin', type: 'file', size: 1 });
  await page.invoke({ kind: 'save-chunk', id: transfer.id, offset: 0, base64: 'AQ==' });
  const ending = page.invoke({ kind: 'save-end', id: transfer.id });
  const refused = assert.rejects(ending, error => /^LIVE_/.test(error.message));
  // The queued save has started and is awaiting fsync; disk completion cannot
  // run before this microtask. Stop must prevent its later publish step.
  await Promise.resolve(); const stopping = manager.stop({ session_id: result.session_id });
  await Promise.all([refused, stopping]); assert.deepEqual(await readdir(output), []);
});

test('an existing output directory and non-share save requests never modify local files', async t => {
  const { directory, manager, fake } = await fixture(t), existing = path.join(directory, 'keep.txt'); await writeFile(existing, 'KEEP');
  await assert.rejects(manager.start('share-text', { role: 'reader', output_dir: directory }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(existing, 'utf8'), 'KEEP'); assert.equal(fake.instances.length, 0);
  await manager.start('remote-camera', { role: 'viewer' });
  await assert.rejects(fake.instances[0].page.invoke({ kind: 'save-begin', type: 'file', size: 1 }), { message: 'LIVE_OUTPUT_REQUIRED' });
  assert.deepEqual(await readdir(directory), ['keep.txt']);
});

test('the four-session limit covers pending opens and closing releases a slot', async t => {
  const gate = deferred(), { manager, fake } = await fixture(t, { beforeLaunch: () => gate.promise });
  const pending = Array.from({ length: LIVE_LIMITS.sessions }, () => manager.start('remote-camera', { role: 'viewer' }));
  await assert.rejects(manager.start('remote-camera', { role: 'viewer' }), { code: 'LIVE_SESSION_LIMIT' });
  gate.resolve(); const opened = await Promise.all(pending); assert.equal(fake.instances.length, 4);
  await manager.stop({ session_id: opened[0].session_id }); const replacement = await manager.start('remote-camera', { role: 'viewer' });
  assert.ok(replacement.session_id); assert.equal((await manager.status()).sessions.length, 4);
});

test('shutdown during a pending launch closes the late browser and refuses further sessions', async t => {
  const gate = deferred(), reached = deferred(), { manager, fake } = await fixture(t, { beforeLaunch: () => { reached.resolve(); return gate.promise; } });
  const pending = manager.start('remote-camera', { role: 'viewer' }); await reached.promise;
  await manager.closeAll(); gate.resolve(); await assert.rejects(pending, { code: 'LIVE_SESSION_CLOSED' });
  assert.equal(fake.instances[0].closed, true); assert.deepEqual((await manager.status()).sessions, []);
  await assert.rejects(manager.start('remote-camera', { role: 'viewer' }), { code: 'LIVE_SESSION_CLOSED' });
});

test('cancelling a pending browser launch never loads a later live window', async t => {
  const gate = deferred(), reached = deferred(), { manager, fake } = await fixture(t, { beforeLaunch: () => { reached.resolve(); return gate.promise; } });
  const controller = new AbortController();
  const pending = manager.start('remote-camera', { role: 'viewer' }, { signal: controller.signal }); await reached.promise;
  controller.abort(); gate.resolve();
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'LIVE_SESSION_CLOSED');
  assert.equal(fake.instances[0].closed, true); assert.deepEqual(fake.instances[0].page.navigations, []);
  assert.deepEqual(fake.instances[0].page.inputs, []); assert.deepEqual((await manager.status()).sessions, []);
});

test('startup time counts toward the session expiry rather than granting a fresh lifetime afterward', async t => {
  let now = Date.now();
  const { manager, fake } = await fixture(t, { beforeGoto: () => { now += 61000; } }, { clock: () => now });
  await manager.start('remote-camera', { role: 'viewer', ttl_minutes: 1 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.instances[0].closed, true); assert.deepEqual((await manager.status()).sessions, []);
});

test('closing the window cleans the session and pre-aborted startup launches nothing', async t => {
  const { manager, fake } = await fixture(t);
  await assert.rejects(manager.start('remote-camera', { role: 'viewer' }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fake.instances.length, 0);
  const result = await manager.start('remote-camera', { role: 'viewer' }); await fake.instances[0].page.close();
  await manager.stop({ session_id: result.session_id }); assert.equal(fake.instances[0].closed, true);
  assert.deepEqual((await manager.status()).sessions, []);
});
