import { CODE_PATTERN } from '../../vendor/abox/tools/share-text/src/names.js';
import { rtcConfig, localDescription, allowedCandidate, makeShareUrl } from '../../vendor/abox/tools/share-text/src/network.js';
import { cleanFileList, beginFile, appendFileChunk, finishFile } from '../../vendor/abox/tools/share-text/src/receive-file.js';
import { fileSender, FILE_CHANNEL, validRequest } from '../../vendor/abox/tools/share-text/src/send-file.js';
import { PairingSocket } from '../../vendor/abox/shared/js/peer-pairing.js';

export const SHARE_LIMITS = Object.freeze({ file_bytes: 128 * 2 ** 20, total_bytes: 256 * 2 ** 20, file_count: 16, text_chars: 50000, text_bytes: 200000 });
const CHUNK = 65536, MAX_PEERS = 16, MAX_SIGNAL = 65536, MAX_CONTROL_QUEUED = 2 ** 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

export function shareLimits(value = {}) {
  return Object.fromEntries(Object.entries(SHARE_LIMITS).map(([key, ceiling]) => [key,
    Number.isSafeInteger(value[key]) && value[key] > 0 ? Math.min(value[key], ceiling) : ceiling]));
}
export function roomName(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('Enter a share code or a local-network abox.tools share link.');
  let code = value.trim();
  if (code.includes('://')) {
    let url; try { url = new URL(code); } catch { fail('Use a valid local-network abox.tools share link.'); }
    if (url.origin !== 'https://abox.tools' || url.pathname !== '/share-text/' || url.searchParams.getAll('local').length !== 1 || url.searchParams.get('local') !== '1') {
      fail('Use a share started in Local network mode. This companion never changes to an internet relay.');
    }
    code = url.hash.slice(1);
  }
  if (!CODE_PATTERN.test(code)) fail('Use a share code of 1–64 lowercase letters, digits and hyphens, starting with a letter or digit.');
  return code;
}
export const shareInvitation = code => makeShareUrl('https://abox.tools/share-text/', roomName(code), true);
export function checkedText(text, limits = SHARE_LIMITS) {
  if (typeof text !== 'string' || text.length > limits.text_chars || new TextEncoder().encode(text).length > limits.text_bytes) fail('Text exceeds the local sharing limit.');
  return text;
}
export function checkedFiles(files, limits = SHARE_LIMITS) {
  const selected = Array.from(files ?? []); let total = 0;
  if (selected.length > limits.file_count) fail('Choose no more than 16 files.');
  for (const file of selected) {
    if (!file || typeof file.slice !== 'function' || typeof file.name !== 'string' || file.name.length > 255 || typeof file.type !== 'string' || file.type.length > 255
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.file_bytes || (total += file.size) > limits.total_bytes) fail('Files exceed the local size, name or count limits.');
  }
  return selected;
}
export async function readTextFile(file, limits = SHARE_LIMITS) {
  if (!file || !Number.isSafeInteger(file.size) || file.size > limits.text_bytes) fail('Choose a UTF-8 text file within the local text limit.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { fail('The text file must contain valid UTF-8.'); }
  return checkedText(text, limits);
}
export async function startPreparedShare({ prepare, create, current }) {
  const settings = await prepare();
  if (!current()) return null;
  const owner = create(settings);
  if (!current()) { owner.stop(); return null; }
  owner.start(); return owner;
}
const base64 = bytes => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };

// A received payload only enters this bridge after a person's Save action.
// The backend owns random filenames, exact offsets, exclusive writes and quotas.
export async function saveReceivedParts(bridge, parts, { size, type, current = () => true, name = '' }) {
  if (!Number.isSafeInteger(size) || size < 0 || size > SHARE_LIMITS.file_bytes || type === 'text' && size > SHARE_LIMITS.text_bytes || !['file', 'text'].includes(type)
      || !Array.isArray(parts) || parts.length > 16384 || !current()) fail('This received item is no longer available to save.');
  if (parts.some(part => !(part instanceof ArrayBuffer)) || parts.reduce((sum, part) => sum + part.byteLength, 0) !== size) fail('The received byte count is incomplete.');
  let id, completed = false;
  try {
    const begun = await bridge({ kind: 'save-begin', name, size, type }); id = begun?.id;
    if (typeof id !== 'string' || !id || id.length > 128 || !current()) fail('The local save could not begin.');
    let offset = 0;
    for (const part of parts) for (let at = 0; at < part.byteLength; at += CHUNK) {
      if (!current()) fail('Saving was stopped.');
      const bytes = new Uint8Array(part, at, Math.min(CHUNK, part.byteLength - at));
      const written = await bridge({ kind: 'save-chunk', id, offset, base64: base64(bytes) });
      if (written?.written !== bytes.length) fail('The local save did not retain the complete byte sequence.'); offset += bytes.length;
    }
    if (!current() || offset !== size) fail('Saving was stopped before completion.');
    const ended = await bridge({ kind: 'save-end', id }); if (ended?.saved !== true) fail('The local save could not finish.');
    completed = true; return ended;
  } finally {
    if (id && !completed) try { await bridge({ kind: 'save-cancel', id }); } catch { /* Session teardown also removes unfinished outputs. */ }
  }
}

export class ShareSession {
  constructor({ role, room, text = '', files = [], limits = SHARE_LIMITS, onState = () => {}, onRequest = () => {}, onText = () => {}, onFiles = () => {},
    onProgress = () => {}, onReceived = async () => {}, WebSocketClass = globalThis.WebSocket, PeerClass = globalThis.RTCPeerConnection,
    uuid = () => globalThis.crypto.randomUUID() }) {
    if (!['host', 'reader'].includes(role)) fail('Choose host or reader.');
    this.role = role; this.room = roomName(room); this.limits = shareLimits(limits); this.text = checkedText(text, this.limits);
    this.uuid = uuid; this.files = new Map(checkedFiles(files, this.limits).map(file => [uuid(), file]));
    Object.assign(this, { onState, onRequest, onText, onFiles, onProgress, onReceived, WebSocketClass, PeerClass });
    this.peers = new Map(); this.offered = new Map(); this.active = false; this.generation = 0; this.rx = null; this.delivering = false; this.receivedCount = 0; this.receivedBytes = 0;
    this.phase = 'ready'; this.connected = false; this.readerAdmitted = false; this.sentKnock = false; this.pendingSignals = 0;
  }
  state(phase) {
    this.phase = phase;
    const connected = [...this.peers.values()].some(peer => peer.admitted && peer.dc?.readyState === 'open');
    this.connected = connected;
    this.onState({ phase, connected, peer_count: this.role === 'host' ? [...this.peers.values()].filter(peer => peer.admitted).length : connected ? 1 : 0, capture: false });
  }
  start() {
    if (this.active) return; if (typeof this.WebSocketClass !== 'function' || typeof this.PeerClass !== 'function') fail('This browser does not support local peer sharing.');
    this.active = true; const generation = ++this.generation; this.state('connecting');
    let socket;
    try { socket = new this.WebSocketClass(`wss://rendezvous.abox.tools/ws/${this.room}?role=${this.role === 'host' ? 'host' : 'viewer'}&local=1`); }
    catch { this.stop('error'); return; }
    const pairing = new PairingSocket(socket, { current: () => this.active && this.generation === generation, maxBuffered: 256 * 1024 }); this.pairing = pairing;
    pairing.after('opening', 20000, () => this.stop('connection-failed'));
    pairing.listen({
      open: () => { pairing.clear('opening'); pairing.every('heartbeat', 30000, () => pairing.send('ping')); this.state(this.role === 'host' ? 'hosting' : 'connecting');
        if (this.role === 'reader') pairing.after('room', 20000, () => this.stop('connection-failed')); },
      message: event => { if (event.data === 'pong') return; if (typeof event.data !== 'string' || event.data.length > MAX_SIGNAL) { this.stop('protocol-error'); return; }
        let message; try { message = JSON.parse(event.data); } catch { this.stop('protocol-error'); return; }
        if (!object(message)) { this.stop('protocol-error'); return; }
        if (this.role === 'reader' && message.type === 'ready') { pairing.clear('room'); if (!this.peers.size) void this.dial().catch(() => this.stop('connection-failed')); }
        if (message.type === 'signal') void this.signal(message).catch(() => this.stop('connection-failed'));
        if (this.role === 'host' && message.type === 'leave' && !this.peers.get(message.id)?.admitted) this.drop(message.id);
      },
      close: event => this.stop(event.code === 4409 ? 'name-taken' : event.code === 4404 ? 'not-found' : 'disconnected'),
      error: () => this.stop('connection-failed'),
    });
  }
  makePeer(id) {
    if (this.peers.size >= MAX_PEERS) return null;
    const pc = new this.PeerClass(rtcConfig(true)), peer = { id, pc, dc: null, admitted: false, pending: false, candidates: [], pendingSignals: 0, chain: Promise.resolve(), timer: null };
    this.peers.set(id, peer); const current = () => this.active && this.peers.get(id) === peer;
    peer.timer = setTimeout(() => { if (current() && peer.dc?.readyState !== 'open') this.drop(id); }, 20000);
    pc.onicecandidate = event => { if (current() && event.candidate && allowedCandidate(event.candidate, true)) this.pairing?.send({ ...(this.role === 'host' ? { to: id } : {}), data: { candidate: event.candidate, local: true } }); };
    pc.onconnectionstatechange = () => { if (current() && ['closed', 'failed', 'disconnected'].includes(pc.connectionState)) this.drop(id); };
    pc.ondatachannel = event => {
      if (!current()) { event.channel.close(); return; }
      if (this.role === 'host') {
        if (event.channel.label !== 'share' || peer.dc) { event.channel.close(); return; } this.control(peer, event.channel);
      } else this.fileLane(peer, event.channel);
    };
    return peer;
  }
  async dial() {
    if (!this.active || this.peers.size) return;
    const peer = this.makePeer('host'); if (!peer) return;
    this.control(peer, peer.pc.createDataChannel('share'));
    const offer = await peer.pc.createOffer(); if (!this.active || this.peers.get(peer.id) !== peer) return;
    await peer.pc.setLocalDescription(offer);
    if (this.active && this.peers.get(peer.id) === peer && !this.pairing.send({ data: { sdp: localDescription(peer.pc.localDescription), local: true } })) this.stop('connection-failed');
  }
  async signal(message) {
    if (!this.active) return;
    const data = message.data; if (!object(data)) return;
    if (data.networkMode && data.networkMode !== 'local' || data.sdp && data.local !== true) {
      if (this.role === 'host' && typeof message.from === 'string' && message.from.length <= 128) this.pairing?.send({ to: message.from, data: { networkMode: 'local' } });
      else this.stop('mode-mismatch'); return;
    }
    if (data.local !== true) return;
    if (!data.sdp && !data.candidate) return;
    const id = this.role === 'host' ? message.from : 'host';
    if (typeof id !== 'string' || !id || id.length > 128) return;
    if (data.candidate && (!allowedCandidate(data.candidate, true) || typeof data.candidate.candidate !== 'string' || data.candidate.candidate.length > 4096)) return;
    let peer = this.peers.get(id); if (!peer && this.role === 'host') peer = this.makePeer(id); if (!peer) return;
    if (this.pendingSignals >= 128) { this.stop('protocol-error'); return; }
    if (peer.pendingSignals >= 32) { this.drop(id); return; }
    peer.pendingSignals++; this.pendingSignals++;
    const generation = this.generation, current = () => this.active && this.generation === generation && this.peers.get(id) === peer;
    peer.chain = peer.chain.then(async () => {
      if (!current()) return;
      if (data.sdp) {
        if (!object(data.sdp) || data.sdp.type !== (this.role === 'host' ? 'offer' : 'answer') || typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > MAX_SIGNAL) { this.drop(id); return; }
        await peer.pc.setRemoteDescription(localDescription(data.sdp));
        if (!current()) return;
        for (const candidate of peer.candidates.splice(0)) { await peer.pc.addIceCandidate(candidate); if (!current()) return; }
        if (this.role === 'host') { const answer = await peer.pc.createAnswer(); if (!current()) return;
          await peer.pc.setLocalDescription(answer);
          if (current()) this.pairing.send({ to: id, data: { sdp: localDescription(peer.pc.localDescription), local: true } }); }
      } else if (data.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
        else if (peer.candidates.length < 64) peer.candidates.push(data.candidate); else this.drop(id);
      }
    }).catch(() => { if (current()) this.drop(id); }).finally(() => { peer.pendingSignals--; this.pendingSignals--; });
    await peer.chain;
  }
  sendEncoded(peer, data) {
    if (!this.active || this.peers.get(peer.id) !== peer || peer.dc?.readyState !== 'open' || typeof data !== 'string') return false;
    const bytes = new TextEncoder().encode(data).byteLength, queued = peer.dc.bufferedAmount;
    if (bytes > this.limits.text_chars * 6 + 16384 || !Number.isFinite(queued) || queued < 0 || bytes + queued > MAX_CONTROL_QUEUED) return false;
    try { peer.dc.send(data); return true; } catch { return false; }
  }
  send(peer, message) { return this.sendEncoded(peer, JSON.stringify(message)); }
  introduce(peer) {
    if (this.role !== 'host') return;
    if (peer.admitted) { if (!this.send(peer, { type: 'text', body: this.text, md: false })
        || !this.send(peer, { type: 'files', fileChannels: true, list: [...this.files].map(([id, file]) => ({ id, name: file.name, size: file.size })) })) this.drop(peer.id); }
    else if (!this.send(peer, { type: peer.pending ? 'asked' : 'private' })) this.drop(peer.id);
  }
  control(peer, dc) {
    peer.dc = dc; dc.binaryType = 'arraybuffer';
    if (this.role === 'host') peer.sender = fileSender({ peer: peer.pc, control: { send: data => {
      if (!this.sendEncoded(peer, data)) { this.drop(peer.id); throw new Error('Control channel is unavailable.'); }
    } }, files: this.files, admitted: () => this.active && this.peers.get(peer.id) === peer && peer.admitted });
    let openedOnce = false;
    const opened = () => { if (openedOnce || !this.active || this.peers.get(peer.id) !== peer) return; openedOnce = true; clearTimeout(peer.timer); peer.timer = null;
      if (this.role === 'host') this.introduce(peer); else { this.send(peer, { type: 'hello' }); this.state('waiting-content');
        peer.timer = setTimeout(() => { if (!this.readerAdmitted && this.phase !== 'waiting-approval') this.stop('connection-failed'); }, 20000); } };
    dc.onopen = opened;
    dc.onmessage = event => {
      if (!this.active || this.peers.get(peer.id) !== peer || typeof event.data !== 'string') return;
      if (event.data.length > this.limits.text_chars * 6 + 16384 || new TextEncoder().encode(event.data).byteLength > this.limits.text_chars * 6 + 16384) { this.drop(peer.id); return; }
      let message; try { message = JSON.parse(event.data); } catch { this.drop(peer.id); return; }
      if (!object(message)) return;
      if (this.role === 'host') {
        if (message.type === 'hello') this.introduce(peer);
        else if (message.type === 'knock' && !peer.admitted && !peer.pending) { peer.pending = true;
          if (!this.send(peer, { type: 'asked' })) { this.drop(peer.id); return; }
          this.onRequest({ id: peer.id, note: typeof message.note === 'string' ? message.note.slice(0, 200) : '' }); }
        else if (message.type === 'get' && peer.admitted && validRequest(message.request)) peer.sender.request(message);
        else if (message.type === 'cancel-file') peer.sender.cancel(message.request);
      } else this.readerMessage(peer, message);
    };
    dc.onclose = () => this.drop(peer.id); dc.onerror = () => this.drop(peer.id);
    if (dc.readyState === 'open') opened();
  }
  approve(id) { const peer = this.peers.get(id); if (!this.active || this.role !== 'host' || !peer?.pending) return;
    peer.pending = false; peer.admitted = true; this.introduce(peer); this.onRequest({ id, removed: true }); this.state('sharing'); }
  deny(id) { const peer = this.peers.get(id); if (!peer?.pending) return; this.send(peer, { type: 'denied' }); this.drop(id); }
  updateText(value) { this.text = checkedText(value, this.limits); if (this.role === 'host' && this.active) for (const peer of this.peers.values()) if (peer.admitted && !this.send(peer, { type: 'text', body: this.text, md: false })) this.drop(peer.id); }
  knock(note = '') { const peer = this.peers.get('host'); if (!this.active || this.role !== 'reader' || this.readerAdmitted || this.sentKnock || !peer?.dc || typeof note !== 'string' || note.length > 200) return false;
    this.sentKnock = this.send(peer, { type: 'knock', note }); if (this.sentKnock) this.state('waiting-approval'); return this.sentKnock; }
  readerMessage(peer, message) {
    if (message.type === 'ended' || message.type === 'denied') { this.stop(message.type === 'ended' ? 'ended' : 'denied'); return; }
    if (message.type === 'private' || message.type === 'asked') { clearTimeout(peer.timer); peer.timer = null; if (!this.readerAdmitted) this.state(message.type === 'asked' ? 'waiting-approval' : 'private'); return; }
    if (message.type === 'text') {
      let text; try { text = checkedText(message.body, this.limits); } catch { this.stop('protocol-error'); return; }
      clearTimeout(peer.timer); peer.timer = null; this.readerAdmitted = peer.admitted = true; this.onText(text); this.state('receiving'); return;
    }
    if (message.type === 'files' && this.readerAdmitted) {
      const files = cleanFileList(message.list, this.limits.file_bytes).slice(0, this.limits.file_count);
      this.modernFiles = message.fileChannels === true; this.offered = new Map(files.map(file => [file.id, file]));
      if (this.rx) { const file = this.offered.get(this.rx.id); if (!file || file.name !== this.rx.name || file.size !== this.rx.size) this.cancelFile(); }
      this.onFiles(this.modernFiles ? files : []); return;
    }
    if (['file-gone', 'file-failed'].includes(message.type) && this.rx?.id === message.id && this.rx.request === message.request) this.cancelFile();
  }
  receive(id) {
    const peer = this.peers.get('host'), file = this.offered.get(id);
    if (!this.active || !this.readerAdmitted || !this.modernFiles || !peer || !file || this.rx || this.delivering || this.receivedCount >= this.limits.file_count || this.receivedBytes + file.size > this.limits.total_bytes) return false;
    const request = this.uuid(), rx = { ...file, request, parts: [], got: 0, begun: false, channel: null, timer: null }; this.rx = rx; this.fileTimeout(rx);
    if (!this.send(peer, { type: 'get', id, request })) { this.cancelFile(); return false; } this.onProgress({ receiving: true, bytes: 0, total: file.size }); return true;
  }
  fileTimeout(rx) { clearTimeout(rx.timer); rx.timer = setTimeout(() => { if (this.rx === rx) this.cancelFile(); }, 30000); }
  fileLane(peer, channel) {
    const rx = this.rx;
    if (!rx || peer.id !== 'host' || channel.label !== FILE_CHANNEL + rx.request || rx.channel) { channel.close(); return; }
    rx.channel = channel; channel.binaryType = 'arraybuffer';
    channel.onmessage = event => {
      if (!this.active || this.rx !== rx) return;
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength > CHUNK || !appendFileChunk(rx, event.data, this.limits.file_bytes)) { this.cancelFile(); return; }
        this.fileTimeout(rx); this.onProgress({ receiving: true, bytes: rx.got, total: rx.size }); return;
      }
      if (typeof event.data !== 'string' || event.data.length > 2048) { this.cancelFile(); return; }
      let message; try { message = JSON.parse(event.data); } catch { this.cancelFile(); return; }
      if (!object(message)) { this.cancelFile(); return; }
      if (message.type === 'file-begin') { if (!beginFile(rx, message, this.limits.file_bytes)) this.cancelFile(); else this.fileTimeout(rx); }
      else if (message.type === 'file-end') {
        if (!finishFile(rx, message)) { this.cancelFile(); return; }
        clearTimeout(rx.timer); this.rx = null; this.delivering = true; this.receivedCount++; this.receivedBytes += rx.size; channel.close(); this.onProgress({ receiving: false, bytes: rx.got, total: rx.size });
        const generation = this.generation;
        void Promise.resolve().then(() => this.onReceived({ name: rx.name, size: rx.size, parts: rx.parts, current: () => this.active && this.generation === generation }))
          .catch(() => { if (this.active && this.generation === generation) this.state('save-failed'); })
          .finally(() => { rx.parts.length = 0; if (this.generation === generation) { this.delivering = false; this.onProgress({ receiving: false, completed: true, bytes: rx.size, total: rx.size }); } });
      } else this.cancelFile();
    };
    channel.onclose = () => { if (this.rx === rx) this.cancelFile(); }; channel.onerror = () => { if (this.rx === rx) this.cancelFile(); };
  }
  cancelFile() {
    const rx = this.rx; if (!rx) return; this.rx = null; clearTimeout(rx.timer); rx.parts.length = 0;
    rx.channel?.close(); const peer = this.peers.get('host'); if (peer) this.send(peer, { type: 'cancel-file', request: rx.request });
    this.onProgress({ receiving: false, cancelled: true, bytes: 0, total: 0 });
  }
  drop(id) {
    const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); clearTimeout(peer.timer); peer.sender?.close(); peer.candidates.length = 0;
    peer.dc?.close(); peer.pc.close(); this.onRequest({ id, removed: true });
    if (this.role === 'reader') { this.cancelFile(); this.readerAdmitted = false; this.onText(''); this.offered.clear(); this.onFiles([]); this.state('disconnected'); }
    else this.state(this.active ? 'hosting' : 'stopped');
  }
  stop(phase = 'stopped') {
    this.active = false; this.generation++; this.cancelFile(); this.pairing?.close(); this.pairing = null;
    for (const [id, peer] of this.peers) { if (this.role === 'host' && peer.dc?.readyState === 'open') try { peer.dc.send(JSON.stringify({ type: 'ended' })); } catch {} this.drop(id); }
    this.delivering = false; this.offered.clear(); this.readerAdmitted = false; this.sentKnock = false; this.onFiles([]);
    if (this.role === 'reader') this.onText(''); this.state(phase);
  }
}
