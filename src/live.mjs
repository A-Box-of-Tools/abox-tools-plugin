import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath, stat, mkdir, open, unlink, link, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './browser.mjs';
import { localPath, newOutput } from './files.mjs';
import { AdapterError } from './errors.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LIVE_ORIGIN = 'http://127.0.0.1:48372';
export const LIVE_LIMITS = Object.freeze({ file_bytes: 128 * 1024 * 1024, total_bytes: 256 * 1024 * 1024, file_count: 16, text_chars: 50000, text_bytes: 200000, chunk_bytes: 65536, sessions: 4 });
const PHASES = new Set(['idle', 'starting', 'waiting', 'connected', 'reconnecting', 'stopped', 'error']);
const CAPTURE = new Set(['none', 'camera', 'microphone']);
const ROLES = { 'share-text': ['host', 'reader'], 'remote-camera': ['host', 'viewer'], 'walkie-talkie': ['host', 'listener'], 'voice-oncall': ['host', 'sender'] };

function fail(code = 'LIVE_REQUEST', message = 'The live-session request is invalid.') { throw new AdapterError(code, message); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(); return value; }

export function allowedLiveSocket(raw, tool) {
  try {
    const url = new URL(raw);
    if (url.origin !== 'wss://rendezvous.abox.tools' || url.username || url.password || url.hash) return false;
    if (tool === 'walkie-talkie' || tool === 'voice-oncall') return !url.search && new RegExp(`^/${tool === 'walkie-talkie' ? 'broadcast' : 'inbox'}/[a-f0-9]{64}$`).test(url.pathname);
    if (!/^\/ws\/[a-z0-9-]{1,64}$/.test(url.pathname)) return false;
    const entries = [...url.searchParams];
    if (new Set(entries.map(([key]) => key)).size !== entries.length || entries.some(([key]) => !['role', 'local', 'tool'].includes(key))) return false;
    if (!['host', 'viewer'].includes(url.searchParams.get('role'))) return false;
    if (url.searchParams.has('local') && url.searchParams.get('local') !== '1') return false;
    return tool === 'remote-camera' ? url.searchParams.get('tool') === tool && url.searchParams.get('local') === '1' : tool === 'share-text' && !url.searchParams.has('tool');
  } catch { return false; }
}

async function vetInputs(args, tool) {
  const inputs = [];
  let bytes = 0;
  for (const value of args.input_paths ?? []) {
    const filename = localPath(await realpath(localPath(value)));
    const info = await stat(filename);
    if (!info.isFile() || info.size > LIVE_LIMITS.file_bytes) fail('INPUT_SIZE', 'Live attachments must be regular local files no larger than 128 MiB.');
    bytes += info.size;
    if (bytes > LIVE_LIMITS.total_bytes) fail('INPUT_SIZE', 'Live attachments exceed the 256 MiB combined limit.');
    inputs.push(filename);
  }
  let text;
  if (args.text_path) {
    text = localPath(await realpath(localPath(args.text_path)));
    const info = await stat(text);
    if (!info.isFile() || info.size > LIVE_LIMITS.text_bytes) fail('INPUT_SIZE', 'The shared UTF-8 text file exceeds 200,000 bytes.');
  }
  if (tool !== 'share-text' && (inputs.length || text || args.output_dir)) fail();
  if (args.role !== 'host' && (inputs.length || text)) fail();
  if (inputs.length > LIVE_LIMITS.file_count) fail();
  return { inputs, text };
}

// A separate visible context keeps the ordinary offline browser helper intact.
// Its loopback URL is intercepted, not listened on: no HTTP file server exists.
export function createLiveManager({ launch, browserPath = findBrowser, root = ROOT, clock = Date.now, connectSocket = socket => socket.connectToServer() } = {}) {
  const sessions = new Map();
  const active = new Set();
  let shuttingDown = false;
  let opening = 0;
  const snapshot = state => ({ session_id: state.id, tool: state.tool, role: state.role, phase: state.phase, connected: state.connected,
    peer_count: state.peer_count, capture: state.capture, saved_files: state.saved, saved_bytes: state.savedBytes,
    ...(state.output ? { output_dir: state.output } : {}), expires_at: new Date(state.expires).toISOString() });

  async function cancelSave(state, transfer) {
    state.transfers.delete(transfer.id);
    await transfer.handle.close().catch(() => {});
    await unlink(transfer.partial).catch(() => {});
  }
  async function close(state) {
    if (state.closing) return state.closing;
    state.stopped = true;
    state.readyResolve?.(false);
    state.phase = 'stopped'; state.capture = 'none'; state.connected = false; state.peer_count = 0;
    clearTimeout(state.timer);
    state.closing = (async () => {
      await state.tail.catch(() => {});
      for (const transfer of [...state.transfers.values()]) await cancelSave(state, transfer);
      await state.browser?.close().catch(() => {});
      sessions.delete(state.id);
      active.delete(state);
    })();
    return state.closing;
  }

  async function save(state, request) {
    if (!state.output || state.tool !== 'share-text') fail('LIVE_OUTPUT_REQUIRED', 'Open a receiving session with a new local output directory to save content.');
    if (request.kind === 'save-begin') {
      object(request, ['kind', 'name', 'size', 'type']);
      if (!['text', 'file'].includes(request.type) || !Number.isSafeInteger(request.size) || request.size < 0 || request.size > (request.type === 'text' ? LIVE_LIMITS.text_bytes : LIVE_LIMITS.file_bytes)
          || (request.name !== undefined && (typeof request.name !== 'string' || request.name.length > 512)) || state.transfers.size >= 2 || state.saved + state.transfers.size >= 32) fail();
      const reserved = [...state.transfers.values()].reduce((sum, transfer) => sum + transfer.size, 0);
      if (state.savedBytes + reserved + request.size > LIVE_LIMITS.total_bytes) fail('LIVE_OUTPUT_LIMIT', 'The session has reached its 256 MiB receive limit.');
      const key = randomUUID();
      const partial = path.join(state.output, `.partial-${key}`);
      const final = path.join(state.output, `${request.type === 'text' ? 'text' : 'received'}-${key}.${request.type === 'text' ? 'txt' : 'bin'}`);
      const handle = await open(partial, 'wx', 0o600);
      state.transfers.set(key, { id: key, partial, final, handle, size: request.size, offset: 0, hash: createHash('sha256') });
      return { id: key };
    }
    const transfer = state.transfers.get(id(request.id));
    if (!transfer) fail();
    if (request.kind === 'save-cancel') { object(request, ['kind', 'id']); await cancelSave(state, transfer); return { cancelled: true }; }
    if (request.kind === 'save-chunk') {
      object(request, ['kind', 'id', 'offset', 'base64']);
      if (request.offset !== transfer.offset || typeof request.base64 !== 'string' || request.base64.length > 4 * Math.ceil(LIVE_LIMITS.chunk_bytes / 3)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.base64)) fail();
      const data = Buffer.from(request.base64, 'base64');
      if (!data.length || data.length > LIVE_LIMITS.chunk_bytes || transfer.offset + data.length > transfer.size || data.toString('base64') !== request.base64) fail();
      await transfer.handle.writeFile(data);
      transfer.offset += data.length; transfer.hash.update(data);
      return { written: data.length };
    }
    object(request, ['kind', 'id']);
    if (request.kind !== 'save-end' || transfer.offset !== transfer.size) fail();
    await transfer.handle.sync();
    await transfer.handle.close();
    if (state.stopped) fail('LIVE_SESSION_CLOSED', 'The live session has stopped.');
    // link() publishes without the overwrite behavior of rename().
    await link(transfer.partial, transfer.final);
    if (state.stopped) { await unlink(transfer.final); fail('LIVE_SESSION_CLOSED', 'The live session has stopped.'); }
    await unlink(transfer.partial);
    if (state.stopped) { await unlink(transfer.final); fail('LIVE_SESSION_CLOSED', 'The live session has stopped.'); }
    state.transfers.delete(transfer.id); state.saved++; state.savedBytes += transfer.size;
    return { saved: true, filename: path.basename(transfer.final), sha256: transfer.hash.digest('hex') };
  }

  async function binding(state, source, request) {
    try {
      if (state.stopped || source.page !== state.page || source.frame !== state.page.mainFrame() || source.frame.url() !== state.entry) fail();
      object(request, ['kind', 'phase', 'connected', 'peer_count', 'capture', 'id', 'name', 'size', 'type', 'offset', 'base64']);
      if (request.kind === 'config') {
        object(request, ['kind']);
        return { tool: state.tool, role: state.role, ...(state.room_name ? { room_name: state.room_name } : {}), has_output_dir: Boolean(state.output), limits: LIVE_LIMITS };
      }
      if (request.kind === 'status') {
        object(request, ['kind', 'phase', 'connected', 'peer_count', 'capture']);
        if (!PHASES.has(request.phase) || typeof request.connected !== 'boolean' || !Number.isInteger(request.peer_count) || request.peer_count < 0 || request.peer_count > 32 || !CAPTURE.has(request.capture)) fail();
        state.phase = request.phase; state.connected = request.connected; state.peer_count = request.peer_count; state.capture = request.capture;
        state.readyResolve?.(true);
        return { ok: true };
      }
      if (request.kind === 'stop') { object(request, ['kind']); setTimeout(() => { void close(state); }, 0); return { stopped: true }; }
      if (!['save-begin', 'save-chunk', 'save-end', 'save-cancel'].includes(request.kind) || state.pending >= 8) fail();
      state.pending++;
      const next = state.tail.then(() => { if (state.stopped) fail(); return save(state, request); });
      state.tail = next.catch(() => {});
      try { return await next; } finally { state.pending--; }
    } catch (error) { throw new Error(error instanceof AdapterError ? error.code : 'LIVE_LOCAL_IO_FAILED'); }
  }

  async function start(tool, args, { signal } = {}) {
    object(args, ['role', 'room_name', 'ttl_minutes', 'text_path', 'input_paths', 'output_dir']);
    if (!ROLES[tool]?.includes(args.role) || (args.room_name !== undefined && (typeof args.room_name !== 'string' || args.room_name.length > 80 || /[\u0000-\u001f\u007f]/.test(args.room_name)))
        || (args.input_paths !== undefined && (!Array.isArray(args.input_paths) || args.input_paths.length > LIVE_LIMITS.file_count))) fail();
    const minutes = args.ttl_minutes ?? 30;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail();
    if (shuttingDown) fail('LIVE_SESSION_CLOSED', 'The adapter is closing its live sessions.');
    if (sessions.size + opening >= LIVE_LIMITS.sessions) fail('LIVE_SESSION_LIMIT', 'Close a live window before opening another; at most four can run together.');
    opening++;
    let state, abort;
    try {
      signal?.throwIfAborted();
      const vetted = await vetInputs(args, tool);
      const executablePath = await browserPath();
      if (!executablePath) fail('BROWSER_NOT_FOUND', 'Install Edge, Chrome or Chromium to use the live companion.');
      const provenance = JSON.parse(await readFile(path.join(root, 'vendor/abox/provenance.json'), 'utf8'));
      const vendor = new Set(provenance.files.filter(file => file.path.endsWith('.js')).map(file => `/vendor/abox/${file.path}`));
      const ui = new Set(['share.html', 'share.mjs', 'share.css', 'share-controller.mjs', 'media.html', 'media.mjs', 'media.css', 'media-controller.mjs']);
      let output;
      if (args.output_dir) { output = await newOutput(args.output_dir); await mkdir(output, { mode: 0o700 }); }
      state = { id: randomUUID(), tool, role: args.role, room_name: args.room_name, output, phase: 'idle', connected: false, peer_count: 0, capture: 'none',
        saved: 0, savedBytes: 0, transfers: new Map(), tail: Promise.resolve(), pending: 0, expires: clock() + minutes * 60000, stopped: false };
      active.add(state);
      state.ready = new Promise(resolve => { state.readyResolve = resolve; });
      abort = () => { void close(state); };
      signal?.addEventListener('abort', abort, { once: true });
      signal?.throwIfAborted();
      if (shuttingDown) fail('LIVE_SESSION_CLOSED', 'The adapter is closing its live sessions.');
      const launcher = launch ?? (await import('playwright-core')).chromium.launch.bind((await import('playwright-core')).chromium);
      state.browser = await launcher({ executablePath, headless: false, chromiumSandbox: true, timeout: 30000,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
      if (state.stopped || shuttingDown) fail('LIVE_SESSION_CLOSED', 'The adapter is closing its live sessions.');
      const context = await state.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', async route => {
        const request = route.request();
        let url;
        try { url = new URL(request.url()); } catch { return route.abort(); }
        if (url.origin !== LIVE_ORIGIN || url.username || url.password || url.search || url.hash || request.method() !== 'GET') return route.abort('blockedbyclient');
        const relative = url.pathname.startsWith('/live/') ? url.pathname.slice(6) : null;
        let filename;
        if (relative && ui.has(relative)) filename = path.join(root, 'src/live-ui', relative);
        else if (vendor.has(url.pathname)) filename = path.join(root, url.pathname.slice(1));
        else return route.abort('blockedbyclient');
        if (request.isNavigationRequest() && (url.href !== state.entry || request.frame() !== state.page?.mainFrame())) return route.abort('blockedbyclient');
        const contentType = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript';
        try { return await route.fulfill({ contentType, body: await readFile(filename), headers: {
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src wss://rendezvous.abox.tools; media-src blob:; img-src blob: data:; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'permissions-policy': 'camera=(self), microphone=(self), geolocation=(), display-capture=()',
          'cache-control': 'no-store',
        } }); } catch { return route.abort(); }
      });
      await context.routeWebSocket('**/*', socket => {
        if (!allowedLiveSocket(socket.url(), tool)) return socket.close({ code: 1008, reason: 'Pairing endpoint refused' });
        connectSocket(socket, tool);
      });
      const page = state.page = await context.newPage();
      state.entry = `${LIVE_ORIGIN}/live/${tool === 'share-text' ? 'share' : 'media'}.html`;
      context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
      await page.exposeBinding('aboxLive', (source, request) => binding(state, source, request));
      page.on('close', () => { void close(state); });
      state.browser.on('disconnected', () => { void close(state); });
      await page.goto(state.entry, { waitUntil: 'load', timeout: 30000 });
      let readyTimeout;
      try {
        const ready = await Promise.race([state.ready, new Promise(resolve => { readyTimeout = setTimeout(() => resolve(false), 10000); })]);
        if (!ready) fail('LIVE_UI_FAILED', 'The live companion did not finish loading its local controls.');
      } finally { clearTimeout(readyTimeout); }
      if (vetted.inputs.length) await page.locator('#attachments').setInputFiles(vetted.inputs);
      if (vetted.text) await page.locator('#text-input').setInputFiles(vetted.text);
      signal?.throwIfAborted();
      if (state.stopped) fail('LIVE_WINDOW_CLOSED', 'The live companion closed before it was ready.');
      sessions.set(state.id, state);
      state.timer = setTimeout(() => { void close(state); }, Math.max(0, state.expires - clock()));
      return { ok: true, ...snapshot(state), browser_opened: true, action_required: 'Use Start or Connect in the visible window. Camera and microphone permissions, pairing links and peer approvals stay there.',
        privacy: { pairing_service: 'wss://rendezvous.abox.tools', service_sees: 'IP addresses, timing, room codes/labels, authentication/access data and WebRTC negotiation metadata. Cloudflare keeps seven-day service metadata logs.', content_transport: 'direct-host-candidate-webrtc', relay: false, discovery: false, returns_content: false } };
    } catch (error) {
      if (state) { await close(state); await state.browser?.close().catch(() => {}); if (state.output) await rmdir(state.output).catch(() => {}); }
      if (error instanceof AdapterError || error?.name === 'AbortError') throw error;
      fail('LIVE_LAUNCH_FAILED', 'The visible companion could not start. Check the installed browser and graphical desktop, then retry.');
    } finally { if (abort) signal?.removeEventListener('abort', abort); opening--; }
  }
  async function status({ session_id } = {}) {
    if (session_id !== undefined) { const state = sessions.get(id(session_id)); if (!state) fail('LIVE_SESSION_UNKNOWN', 'This session has closed or belongs to another adapter process.'); return { ok: true, ...snapshot(state) }; }
    return { ok: true, sessions: [...sessions.values()].map(snapshot) };
  }
  async function stop({ session_id }) {
    const state = sessions.get(id(session_id));
    if (!state) return { ok: true, stopped: true, already_closed: true };
    await close(state);
    return { ok: true, ...snapshot(state), stopped: true };
  }
  return { start, status, stop, closeAll: () => { shuttingDown = true; return Promise.all([...active].map(close)); },
    // Injectable launcher and these handles are for permanent isolated tests only.
    testPage: session_id => sessions.get(session_id)?.page };
}

const manager = createLiveManager();
export const openShareSession = (args, options) => manager.start('share-text', args, options);
export const openCameraSession = (args, options) => manager.start('remote-camera', args, options);
export const openWalkieSession = (args, options) => manager.start('walkie-talkie', args, options);
export const openVoiceOncallSession = (args, options) => manager.start('voice-oncall', args, options);
export const liveStatus = args => manager.status(args);
export const stopLiveSession = args => manager.stop(args);
export const closeLiveSessions = () => manager.closeAll();
