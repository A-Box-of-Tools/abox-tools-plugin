import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { ShareSession, SHARE_LIMITS, shareLimits, roomName, shareInvitation, checkedText, checkedFiles, readTextFile, saveReceivedParts, startPreparedShare } from '../src/live-ui/share-controller.mjs';

const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const hostCandidate = 'candidate:1 1 UDP 2122260223 192.168.1.2 12345 typ host';
const relayCandidate = 'candidate:2 1 UDP 2122260223 203.0.113.2 23456 typ relay raddr 192.168.1.2 rport 12345';
const sdp = `v=0\r\na=${hostCandidate}\r\na=${relayCandidate}\r\n`;
class Channel extends EventTarget {
  constructor(label) { super(); this.label = label; this.readyState = 'connecting'; this.sent = []; this.bufferedAmount = 0; }
  open() { this.readyState = 'open'; this.onopen?.({}); this.dispatchEvent(new Event('open')); }
  send(data) { if (this.readyState !== 'open') throw new Error('closed'); this.sent.push(data); }
  message(value) { this.onmessage?.({ data: typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value) }); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.({}); this.dispatchEvent(new Event('close')); }
  json() { return this.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value)); }
}
function harness(t, settings = {}) {
  const sockets = [], peers = [], states = [], requests = [], texts = [], fileLists = [], completed = []; let next = 0;
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(value) { this.sent.push(value); }
    message(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  class Peer {
    constructor(config) { this.config = config; this.channels = []; this.candidates = []; peers.push(this); }
    createDataChannel(label) { const channel = new Channel(label); this.channels.push(channel); return channel; }
    async createOffer() { return { type: 'offer', sdp }; }
    async createAnswer() { return { type: 'answer', sdp }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate(value) { this.candidates.push(value); }
    incoming(label) { const channel = new Channel(label); channel.open(); this.ondatachannel?.({ channel }); return channel; }
    close() { this.connectionState = 'closed'; }
  }
  const session = new ShareSession({ role: 'host', room: 'local-test-code', text: 'PRIVATE CONTENT', ...settings,
    WebSocketClass: Socket, PeerClass: Peer, uuid: () => uuid(++next), onState: value => states.push(value), onRequest: value => requests.push(value),
    onText: value => texts.push(value), onFiles: value => fileLists.push(value), onReceived: async value => completed.push({ ...value, parts: value.parts.map(part => part.slice(0)) }) });
  t.after(() => session.stop()); return { session, sockets, peers, states, requests, texts, fileLists, completed };
}
async function hostPeer(h) {
  h.session.start(); h.sockets[0].open();
  await h.session.signal({ from: 'peer-private-id', data: { local: true, sdp: { type: 'offer', sdp } } });
  const dc = h.peers[0].incoming('share'); return dc;
}
async function readerPeer(h) {
  h.session.start(); h.sockets[0].open(); h.sockets[0].message({ type: 'ready' }); await turn();
  const dc = h.peers[0].channels[0]; dc.open(); dc.message({ type: 'private' }); return dc;
}

test('sharing validates local-mode room links and bounded UTF-8 text/files without opening a connection', async t => {
  const h = harness(t); assert.equal(h.sockets.length, 0); assert.equal(h.peers.length, 0);
  assert.equal(roomName('local-code'), 'local-code'); assert.equal(roomName('https://abox.tools/share-text/?local=1#local-code'), 'local-code');
  assert.equal(shareInvitation('local-code'), 'https://abox.tools/share-text/?local=1#local-code');
  for (const value of ['../private', 'https://evil.invalid/share-text/?local=1#x', 'https://abox.tools/share-text/#x', 'https://abox.tools/share-text/?local=1&local=1#x', 'x'.repeat(2049)]) assert.throws(() => roomName(value));
  assert.equal(checkedText('🦊'.repeat(25000)).length, 50000); assert.throws(() => checkedText('a'.repeat(50001)));
  assert.throws(() => checkedText('🦊', { text_chars: 10, text_bytes: 3 }));
  assert.equal(await readTextFile(new File([Buffer.from([239, 187, 191]), 'private text'], 'note.txt')), 'private text');
  await assert.rejects(readTextFile(new File([Buffer.from([255])], 'bad.txt')));
  const mock = size => ({ size, name: 'private-name.bin', type: '', slice() {} });
  assert.equal(checkedFiles([mock(0), mock(128 * 2 ** 20)]).length, 2);
  assert.throws(() => checkedFiles([mock(128 * 2 ** 20 + 1)])); assert.throws(() => checkedFiles(Array(17).fill(mock(1))));
  assert.throws(() => checkedFiles(Array(3).fill(mock(128 * 2 ** 20))));
  assert.deepEqual(shareLimits({ file_bytes: Number.MAX_SAFE_INTEGER, file_count: 2 }), { ...SHARE_LIMITS, file_count: 2 });
});

test('private hosting exposes neither text nor attachments until a browser approval and never signals content', async t => {
  const file = new File(['PRIVATE FILE CONTENT'], 'PRIVATE NAME.txt'), h = harness(t, { files: [file] }), dc = await hostPeer(h);
  assert.deepEqual(h.peers[0].config, { iceServers: [] }); assert.deepEqual(dc.json(), [{ type: 'private' }]);
  dc.message({ type: 'hello' }); dc.message({ type: 'get', id: [...h.session.files.keys()][0], request: uuid(99) }); assert.equal(h.peers[0].channels.length, 0);
  dc.message({ type: 'knock', note: 'PRIVATE INTRODUCTION' }); assert.equal(h.requests.at(-1).note, 'PRIVATE INTRODUCTION');
  assert.ok(dc.json().every(value => !['text', 'files'].includes(value.type)));
  h.session.approve('peer-private-id'); assert.equal(dc.json().find(value => value.type === 'text').body, 'PRIVATE CONTENT');
  assert.equal(dc.json().find(value => value.type === 'files').list[0].name, 'PRIVATE NAME.txt');
  h.session.updateText('PRIVATE UPDATED CONTENT'); assert.equal(dc.json().at(-1).body, 'PRIVATE UPDATED CONTENT');
  const signal = h.sockets[0].sent.join(''); for (const value of ['PRIVATE CONTENT', 'PRIVATE NAME', 'PRIVATE INTRODUCTION', 'PRIVATE UPDATED']) assert.ok(!signal.includes(value));
  for (const value of h.states) { assert.deepEqual(Object.keys(value).sort(), ['capture', 'connected', 'peer_count', 'phase']); assert.equal(value.capture, false); assert.ok(!JSON.stringify(value).includes('PRIVATE')); }
});

test('host-only ICE filtering applies to SDP and candidates; a wrong-mode reader cannot stop a host', async t => {
  const h = harness(t), dc = await hostPeer(h);
  assert.ok(!h.peers[0].remoteDescription.sdp.includes('typ relay')); assert.ok(h.peers[0].remoteDescription.sdp.includes('typ host'));
  assert.ok(!h.sockets[0].sent.join('').includes('typ relay'));
  await h.session.signal({ from: 'peer-private-id', data: { local: true, candidate: { candidate: relayCandidate, type: 'host' } } }); assert.equal(h.peers[0].candidates.length, 0);
  h.peers[0].onicecandidate({ candidate: { candidate: relayCandidate } }); assert.ok(!h.sockets[0].sent.join('').includes('typ relay'));
  await h.session.signal({ from: 'wrong-mode', data: { local: false, sdp: { type: 'offer', sdp } } });
  assert.equal(h.session.active, true); assert.equal(h.peers.length, 1); assert.equal(JSON.parse(h.sockets[0].sent.at(-1)).data.networkMode, 'local');
  dc.message({ type: 'knock' }); h.session.deny('peer-private-id'); assert.ok(dc.json().some(value => value.type === 'denied'));
  assert.ok(dc.json().every(value => value.type !== 'text')); assert.equal(h.session.peers.size, 0);
});

test('a reader asks for approval explicitly and only delivers a fully verified requested file on its dedicated lane', async t => {
  const h = harness(t, { role: 'reader', text: '' }), dc = await readerPeer(h);
  assert.deepEqual(dc.json(), [{ type: 'hello' }]); assert.equal(h.session.knock('PRIVATE INTRO'), true); assert.equal(h.session.knock('again'), false);
  dc.message({ type: 'asked' }); dc.message({ type: 'text', body: '<script>PRIVATE TEXT</script>', md: true });
  assert.equal(h.texts.at(-1), '<script>PRIVATE TEXT</script>');
  dc.message({ type: 'files', fileChannels: true, list: [{ id: 'file-id', name: '../PRIVATE NAME', size: 3 }] });
  assert.equal(h.session.receive('file-id'), true); assert.equal(h.session.receive('file-id'), false);
  const request = h.session.rx.request, lane = h.peers[0].incoming(`share-file:${request}`);
  lane.message({ type: 'file-begin', id: 'file-id', size: 3, mime: 'application/octet-stream' }); lane.message(Uint8Array.of(0, 255, 17).buffer);
  assert.equal(h.completed.length, 0); lane.message({ type: 'file-end', id: 'file-id' }); await turn();
  assert.equal(h.completed.length, 1); assert.deepEqual(new Uint8Array(h.completed[0].parts[0]), Uint8Array.of(0, 255, 17));
  assert.equal(lane.readyState, 'closed'); assert.equal(h.session.rx, null); assert.equal(h.session.receivedBytes, 3);
  assert.ok(!h.sockets[0].sent.join('').includes('PRIVATE'));
});

test('file size/marker mismatches and cancellation clear parts; retired lanes cannot corrupt a retry', async t => {
  const h = harness(t, { role: 'reader', text: '' }), dc = await readerPeer(h); dc.message({ type: 'text', body: '' });
  dc.message({ type: 'files', fileChannels: true, list: [{ id: 'f', name: 'private', size: 3 }] });
  h.session.receive('f'); const first = h.session.rx, stale = h.peers[0].incoming(`share-file:${first.request}`);
  stale.message({ type: 'file-begin', id: 'f', size: 3, mime: '' }); stale.message(Uint8Array.of(1).buffer); assert.equal(first.parts.length, 1);
  h.session.cancelFile(); assert.equal(first.parts.length, 0); assert.ok(dc.json().some(value => value.type === 'cancel-file' && value.request === first.request));
  h.session.receive('f'); const second = h.session.rx; assert.notEqual(second.request, first.request);
  stale.message(Uint8Array.of(2, 3).buffer); assert.equal(second.got, 0);
  const lane = h.peers[0].incoming(`share-file:${second.request}`); lane.message({ type: 'file-begin', id: 'f', size: 4, mime: '' });
  assert.equal(h.session.rx, null); assert.equal(h.completed.length, 0);
  h.session.receive('f'); const third = h.session.rx, incomplete = h.peers[0].incoming(`share-file:${third.request}`);
  incomplete.message({ type: 'file-begin', id: 'f', size: 3, mime: '' }); incomplete.message(Uint8Array.of(1).buffer); incomplete.message({ type: 'file-end', id: 'f' });
  assert.equal(h.session.rx, null); assert.equal(h.completed.length, 0); assert.equal(third.parts.length, 0);
  h.session.stop(); dc.message({ type: 'text', body: 'PRIVATE LATE' }); assert.equal(h.texts.at(-1), ''); assert.equal(h.session.peers.size, 0); assert.equal(h.sockets[0].readyState, 3);
});

test('local saves preserve every binary byte in bounded ordered chunks and cancel incomplete writes', async () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, at) => at % 256), calls = [], written = [];
  const bridge = async request => { calls.push(request); if (request.kind === 'save-begin') return { id: 'local-only' };
    if (request.kind === 'save-chunk') { const chunk = Buffer.from(request.base64, 'base64'); written.push(chunk); return { written: chunk.length }; }
    return { saved: true }; };
  await saveReceivedParts(bridge, [bytes.buffer], { size: bytes.length, type: 'file', name: '../../untrusted' });
  assert.deepEqual(calls.map(value => value.kind), ['save-begin', 'save-chunk', 'save-chunk', 'save-end']);
  assert.deepEqual(calls.filter(value => value.kind === 'save-chunk').map(value => [value.offset, Buffer.from(value.base64, 'base64').length]), [[0, 65536], [65536, 4464]]);
  assert.deepEqual(Buffer.concat(written), Buffer.from(bytes));
  const stopped = []; let current = true;
  await assert.rejects(saveReceivedParts(async request => { stopped.push(request.kind); if (request.kind === 'save-begin') { current = false; return { id: 'cancel-me' }; } return {}; },
    [bytes.buffer], { size: bytes.length, type: 'file', current: () => current }));
  assert.deepEqual(stopped, ['save-begin', 'save-cancel']);
  const failed = [];
  await assert.rejects(saveReceivedParts(async request => { failed.push(request.kind); return request.kind === 'save-begin' ? { id: 'incomplete' } : { written: 0 }; }, [bytes.buffer], { size: bytes.length, type: 'file' }));
  assert.deepEqual(failed, ['save-begin', 'save-chunk', 'save-cancel']);
  const empty = []; await saveReceivedParts(async request => { empty.push(request.kind); return request.kind === 'save-begin' ? { id: 'empty' } : { saved: true }; }, [], { size: 0, type: 'text' });
  assert.deepEqual(empty, ['save-begin', 'save-end']);
  await assert.rejects(saveReceivedParts(bridge, [bytes.buffer], { size: 1, type: 'file' }));
});

test('Stop during deferred local preparation cannot start a late socket or replace a newer preparation', async t => {
  const h = harness(t); let finish, epoch = 1, created = 0;
  const first = epoch, pending = startPreparedShare({ prepare: () => new Promise(resolve => { finish = resolve; }), current: () => epoch === first,
    create: () => { created++; return h.session; } });
  epoch++; finish({}); assert.equal(await pending, null); assert.equal(created, 0); assert.equal(h.sockets.length, 0);
  const second = epoch;
  await startPreparedShare({ prepare: async () => ({}), current: () => epoch === second, create: () => { created++; return h.session; } });
  assert.equal(created, 1); assert.equal(h.sockets.length, 1); assert.equal(h.peers.length, 0);
});

test('signaling floods are bounded before native awaits and old completions cannot affect a replacement peer', async t => {
  const h = harness(t); h.session.start(); h.sockets[0].open();
  const old = h.session.makePeer('old-peer'); let release, answers = 0;
  old.pc.setRemoteDescription = () => new Promise(resolve => { release = resolve; }); old.pc.createAnswer = async () => { answers++; return { type: 'answer', sdp }; };
  const first = h.session.signal({ from: 'old-peer', data: { local: true, sdp: { type: 'offer', sdp } } }); await turn();
  const pending = [first];
  for (let index = 0; index < 500; index++) pending.push(h.session.signal({ from: 'old-peer', data: { local: true, candidate: { candidate: hostCandidate } } }));
  assert.ok(old.pendingSignals <= 32); assert.ok(h.session.pendingSignals <= 128);
  release(); await Promise.all(pending); assert.equal(h.session.pendingSignals, 0); assert.equal(answers, 0);

  h.session.stop(); h.session.start(); h.sockets.at(-1).open();
  const replaced = h.session.makePeer('same-id'); let reject;
  replaced.pc.setRemoteDescription = () => new Promise((resolve, failed) => { reject = failed; });
  const stale = h.session.signal({ from: 'same-id', data: { local: true, sdp: { type: 'offer', sdp } } }); await turn();
  h.session.drop('same-id'); const replacement = h.session.makePeer('same-id'); reject(new Error('Private native failure.')); await stale;
  assert.equal(h.session.peers.get('same-id'), replacement); assert.equal(h.session.pendingSignals, 0);
});

test('an already-open control channel is introduced once and keeps no stale approval deadline', async t => {
  const h = harness(t, { role: 'reader', text: '' }); h.session.start(); h.sockets[0].open();
  const peer = h.session.makePeer('host'), dc = new Channel('share'); dc.open(); h.session.control(peer, dc);
  const timer = peer.timer; dc.onopen(); assert.equal(peer.timer, timer); assert.equal(dc.json().filter(value => value.type === 'hello').length, 1);
  dc.message({ type: 'private' }); assert.equal(peer.timer, null); dc.onopen(); assert.equal(peer.timer, null);
});

test('stalled control channels cannot accumulate repeated introductions or file-error replies', async t => {
  const h = harness(t), dc = await hostPeer(h); dc.message({ type: 'knock' }); h.session.approve('peer-private-id');
  const before = dc.sent.length; dc.bufferedAmount = 2 ** 20; dc.message({ type: 'hello' });
  assert.equal(dc.sent.length, before); assert.equal(h.session.peers.size, 0); assert.equal(dc.readyState, 'closed');
  await h.session.signal({ from: 'second-peer', data: { local: true, sdp: { type: 'offer', sdp } } });
  const other = h.peers.at(-1).incoming('share'); other.message({ type: 'knock' }); h.session.approve('second-peer');
  const count = other.sent.length; other.bufferedAmount = 2 ** 20; other.message({ type: 'get', id: 'unknown-file', request: uuid(700) });
  assert.equal(other.sent.length, count); assert.equal(other.readyState, 'closed'); assert.equal(h.session.peers.size, 0);
});
