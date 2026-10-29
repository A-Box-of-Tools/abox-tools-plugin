import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMediaController, mediaConfig, voiceInvitation, cameraInvitation } from '../src/live-ui/media-controller.mjs';

const code = 'a'.repeat(64), key = 'B'.repeat(43), listen = 'C'.repeat(43);
const cameraCode = 'cam-abcdefghijkl';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixtures(extra = {}) {
  const calls = [], sessions = [], captures = [], media = [], muted = [], reports = [], rendered = [];
  class Track extends EventTarget {
    constructor() { super(); this.readyState = 'live'; this.enabled = true; }
    stop() { this.readyState = 'ended'; calls.push('track-stop'); }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }
  const track = new Track(), tracks = extra.multipleTracks ? [track, new Track()] : [track];
  if (extra.endedCapture) track.readyState = 'ended';
  const stream = { getVideoTracks: () => tracks, getTracks: () => tracks };
  class CameraCapture {
    constructor() { captures.push(this); this.stopped = false; }
    async start(constraints) { calls.push(['capture', constraints]); const made = extra.capture ? await extra.capture.promise : stream;
      if (this.stopped) { made.getTracks().forEach(item => item.stop()); return null; } this.stream = made; return made; }
    stop() { this.stopped = true; (this.stream ?? stream).getTracks().forEach(item => item.stop()); this.stream = null; }
  }
  class CameraSession {
    constructor(options) { this.options = options; sessions.push(this); calls.push('camera-constructor'); }
    async startHost(made, value, settings) { calls.push(['camera-host', value, settings]); if (extra.endDuringHost) track.end(); this.options.onState('camera.waiting'); }
    async connect(value, note) { calls.push(['camera-connect', value, note]); this.options.onState('viewer.waiting'); }
    approve(id) { calls.push(['approve', id]); return true; }
    deny(id) { calls.push(['deny', id]); return true; }
    disconnectViewer(id) { calls.push(['disconnect', id]); return true; }
    stop() { calls.push('camera-stop'); }
  }
  class Voice {
    constructor(options) { this.options = options; sessions.push(this); calls.push('voice-constructor'); }
    async start() {
      calls.push('voice-start');
      if (this.options.mediaDevices) this.stream = await this.options.mediaDevices.getUserMedia({ audio: true, video: false });
      if (extra.voice) await extra.voice.promise;
      if (this.stopped) { this.stream?.getTracks().forEach(item => item.stop()); return false; }
      this.options.onState(`${this.options.role}-ready`, { directReady: true, captureState: 'ready', listeners: 1, signaling: true, waiting: false }); return true;
    }
    setTalking(value) { calls.push(['talk', value]); }
    stop() { this.stopped = true; this.stream?.getTracks().forEach(item => item.stop()); calls.push('voice-stop'); }
    moderate(id, value) { calls.push(['moderate', id, value]); return true; }
    kick(id) { calls.push(['kick', id]); return true; }
  }
  const engines = { CameraCapture, CameraSession, BroadcastSession: Voice, InboxSession: Voice,
    makeCode: () => cameraCode, parseCode: value => value === cameraCode || value === `https://abox.tools/remote-camera/#${cameraCode}` ? cameraCode : null,
    makeInboxIdentity: async () => { calls.push('identity'); if (extra.identity) await extra.identity.promise; return { code, key }; },
    makeSenderKey: () => { calls.push('sender-key'); return listen; },
    derivePasswordProof: async () => { calls.push('password-proof'); return key; },
    ...(extra.microphone ? { mediaDevices: { getUserMedia: async constraints => { calls.push(['microphone', constraints]); return stream; } } } : {}) };
  const make = config => createMediaController({ config, engines, render: value => rendered.push(value), report: value => reports.push(value), onMedia: (...args) => media.push(args), onMute: (...args) => { muted.push(args); calls.push(['mute-local', ...args]); } });
  return { make, calls, sessions, captures, media, muted, reports, rendered, track, tracks };
}

test('live media configuration and invitations refuse unrelated URLs, extra credentials and wrong roles', () => {
  assert.equal(mediaConfig({ tool: 'remote-camera', role: 'camera' }).role, 'host');
  for (const config of [{ tool: 'share-text', role: 'host' }, { tool: 'voice-oncall', role: 'listener' }, { tool: 'walkie-talkie', role: 'host', room_name: 'x\n' }]) assert.throws(() => mediaConfig(config));
  assert.deepEqual(voiceInvitation('walkie-talkie', `https://abox.tools/walkie-talkie/#code=${code}&listen=${listen}`), { code, key: listen });
  assert.deepEqual(voiceInvitation('voice-oncall', code), { code });
  assert.deepEqual(voiceInvitation('voice-oncall', `https://abox.tools/voice-oncall/#code=${code}`), { code });
  for (const input of [`https://evil.invalid/walkie-talkie/#code=${code}&listen=${listen}`, `https://abox.tools/voice-oncall/#code=${code}&listen=${listen}`,
    `code=${code}&listen=${listen}&listen=${listen}`, `code=${code}&listen=${listen}&key=${key}`, `https://abox.tools/walkie-talkie/?local=1#code=${code}&listen=${listen}`]) assert.throws(() => voiceInvitation('walkie-talkie', input));
  assert.equal(cameraInvitation(cameraCode, () => cameraCode), cameraCode);
  assert.throws(() => cameraInvitation('https://evil.invalid/remote-camera/#cam-abcdefghijk', () => cameraCode));
});

test('constructing every media view is passive and reports only a fixed technical status', () => {
  const f = fixtures();
  for (const [tool, roles] of [['remote-camera', ['host', 'viewer']], ['walkie-talkie', ['host', 'listener']], ['voice-oncall', ['host', 'sender']]]) {
    for (const role of roles) { const controller = f.make({ tool, role }); assert.equal(controller.snapshot.phase, 'idle'); }
  }
  assert.deepEqual(f.calls, []);
  for (const status of f.reports) assert.deepEqual(Object.keys(status).sort(), ['capture', 'connected', 'peer_count', 'phase']);
});

test('camera acquisition begins only at explicit Start and approval stays mandatory', async () => {
  const f = fixtures(), controller = f.make({ tool: 'remote-camera', role: 'host' });
  assert.equal(await controller.start(), true);
  const capture = f.calls.find(item => Array.isArray(item) && item[0] === 'capture'); assert.equal(capture[1].audio, false);
  assert.deepEqual(f.calls.find(item => Array.isArray(item) && item[0] === 'camera-host'), ['camera-host', cameraCode, { discoverable: false, requireApproval: true }]);
  assert.equal(controller.snapshot.capture, 'camera'); assert.equal(controller.snapshot.invitation, `https://abox.tools/remote-camera/#${cameraCode}`);
  // The common blur/visibility release runs for camera pages too, although
  // CameraSession intentionally has no voice transmission API.
  assert.doesNotThrow(() => controller.setTalking(false)); assert.doesNotThrow(() => controller.setTalking(true));
  assert.equal(controller.snapshot.talking, false);
  assert.equal(controller.approve('unknown'), false);
  f.sessions[0].options.onRequests([{ id: 'peer', note: '<img src=bad> unverified' }]);
  assert.equal(controller.approve('peer'), true); assert.equal(controller.deny('peer'), true);
  controller.stop(); assert.equal(f.track.readyState, 'ended'); assert.equal(controller.snapshot.phase, 'stopped'); assert.equal(controller.snapshot.invitation, '');
  assert.equal(f.reports.some(value => JSON.stringify(value).includes(cameraCode)), false);
});

test('Stop cancels a pending camera permission and closes a late acquired stream', async () => {
  const pending = deferred(), f = fixtures({ capture: pending }), controller = f.make({ tool: 'remote-camera', role: 'host' });
  const starting = controller.start(); controller.stop();
  pending.resolve({ getTracks: () => [f.track], getVideoTracks: () => [f.track] });
  assert.equal(await starting, false); assert.equal(f.track.readyState, 'ended'); assert.equal(controller.snapshot.phase, 'stopped');
  assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'camera-host'), false);
});

test('native camera termination closes all resources immediately and stale ended events cannot revive a stopped session', async () => {
  const f = fixtures({ multipleTracks: true }), controller = f.make({ tool: 'remote-camera', role: 'host' });
  assert.equal(await controller.start(), true); f.track.end();
  assert.equal(controller.snapshot.phase, 'error'); assert.equal(controller.snapshot.capture, 'none'); assert.equal(controller.snapshot.connected, false);
  assert.equal(controller.snapshot.invitation, ''); assert.equal(controller.snapshot.message, 'Camera access ended. Stop and start again when ready.');
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.ok(f.calls.includes('camera-stop')); assert.equal(f.media.at(-1)[1], '*');
  const afterFailure = f.reports.length; f.track.dispatchEvent(new Event('ended')); assert.equal(f.reports.length, afterFailure);

  const stopped = fixtures(), stoppedController = stopped.make({ tool: 'remote-camera', role: 'host' });
  await stoppedController.start(); stoppedController.stop(); const afterStop = stopped.reports.length;
  stopped.track.dispatchEvent(new Event('ended')); assert.equal(stopped.reports.length, afterStop); assert.equal(stoppedController.snapshot.phase, 'stopped');

  const raced = fixtures({ endDuringHost: true }), racedController = raced.make({ tool: 'remote-camera', role: 'host' });
  assert.equal(await racedController.start(), false); assert.equal(racedController.snapshot.phase, 'error'); assert.equal(racedController.snapshot.invitation, '');
  assert.ok(raced.reports.every(status => !status.connected));

  const ended = fixtures({ endedCapture: true }), endedController = ended.make({ tool: 'remote-camera', role: 'host' });
  assert.equal(await endedController.start(), false); assert.equal(endedController.snapshot.phase, 'error');
  assert.equal(ended.calls.some(call => Array.isArray(call) && call[0] === 'camera-host'), false);
});

test('camera viewer never creates capture and ignores callbacks after Stop', async () => {
  const f = fixtures(), controller = f.make({ tool: 'remote-camera', role: 'viewer', invitation: cameraCode });
  assert.equal(await controller.start(), true); assert.equal(f.captures.length, 0);
  controller.stop(); const before = f.reports.length;
  f.sessions[0].options.onStream({ getVideoTracks: () => [{ readyState: 'live' }] });
  f.sessions[0].options.onState('camera.streaming'); assert.equal(f.reports.length, before); assert.equal(controller.snapshot.connected, false);
});

test('walkie broadcaster uses separate listener capability and explicit hold-to-talk', async () => {
  const f = fixtures(), controller = f.make({ tool: 'walkie-talkie', role: 'host' });
  assert.equal(await controller.start(), true);
  const settings = f.sessions[0].options; assert.equal(settings.key, key); assert.equal(settings.listenKey, listen); assert.equal(settings.discover, false);
  assert.equal(controller.snapshot.invitation, `https://abox.tools/walkie-talkie/#code=${code}&listen=${listen}`);
  assert.equal(controller.snapshot.invitation.includes(key), false);
  assert.equal(controller.snapshot.talking, false); controller.setTalking(true); assert.equal(controller.snapshot.talking, true);
  controller.setTalking(false); assert.equal(controller.snapshot.talking, false);
  assert.equal(f.reports.some(status => JSON.stringify(status).includes(listen)), false);
  controller.stop(); assert.equal(controller.snapshot.capture, 'none'); assert.equal(controller.snapshot.can_talk, false);
});

test('voice listener never transmits and stale asynchronous identity cannot start transport', async () => {
  const pending = deferred(), f = fixtures({ identity: pending }), controller = f.make({ tool: 'walkie-talkie', role: 'host' });
  const starting = controller.start(); controller.stop(); pending.resolve(); assert.equal(await starting, false); assert.equal(f.sessions.length, 0);
  const listener = f.make({ tool: 'walkie-talkie', role: 'listener', invitation: `code=${code}&listen=${listen}` });
  assert.equal(await listener.start(), true); assert.equal(listener.snapshot.capture, 'none'); listener.setTalking(true); assert.equal(listener.snapshot.talking, false);
  listener.stop();
});

test('oncall host password stays outside invitations/status and local mute precedes signaling', async () => {
  const f = fixtures(), controller = f.make({ tool: 'voice-oncall', role: 'host' });
  assert.equal(await controller.start({ room_name: 'Private pager', password: 'Private password' }), true);
  assert.equal(f.sessions[0].options.passwordProof, key); assert.equal(controller.snapshot.capture, 'none');
  assert.equal(controller.snapshot.invitation, `https://abox.tools/voice-oncall/#code=${code}`);
  f.sessions[0].options.onParticipants([{ id: 'caller', name: 'Unverified caller', connected: true, muted: false }]);
  assert.equal(controller.moderate('caller', true), true);
  assert.deepEqual(f.calls.slice(-2), [['mute-local', 'caller', true], ['moderate', 'caller', true]]);
  f.sessions[0].options.onStream({}, 'caller'); assert.equal(f.media.at(-1)[2].muted, true);
  assert.equal(controller.kick('caller'), true); assert.deepEqual(f.calls.slice(-2), [['mute-local', 'caller', true], ['kick', 'caller']]);
  assert.equal(JSON.stringify(f.reports).includes('Private'), false); assert.equal(JSON.stringify(f.reports).includes('caller'), false);
  controller.stop();
});

test('oncall sender starts muted, closes pending source on Stop, and exposes fixed errors only', async () => {
  const pending = deferred(), f = fixtures({ voice: pending, microphone: true }), controller = f.make({ tool: 'voice-oncall', role: 'sender', invitation: code });
  assert.equal(f.calls.length, 0);
  const starting = controller.start({ password: 'Hidden secret' }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.snapshot.capture, 'microphone'); assert.equal(controller.snapshot.talking, false);
  controller.stop(); pending.resolve(); assert.equal(await starting, false); assert.equal(controller.snapshot.phase, 'stopped'); assert.ok(f.calls.includes('voice-stop'));
  assert.equal(f.track.readyState, 'ended'); assert.equal(controller.snapshot.capture, 'none');
  const camera = f.make({ tool: 'remote-camera', role: 'viewer', invitation: 'invalid' });
  assert.equal(await camera.start(), false); assert.equal(camera.snapshot.phase, 'error'); assert.equal(camera.snapshot.message, 'Use a valid camera invitation.');
});

test('media entry is accessible/passive markup and avoids active discovery, persistence and unsafe DOM insertion', async () => {
  const html = await readFile(new URL('../src/live-ui/media.html', import.meta.url), 'utf8'), entry = await readFile(new URL('../src/live-ui/media.mjs', import.meta.url), 'utf8');
  for (const id of ['status', 'start', 'stop', 'close', 'invitation', 'password', 'talk']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /role="status" aria-live="polite"/); assert.match(html, /type="password"/); assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /\bautoplay\b|<iframe|https?:\/\/[^<\s]+["']/);
  assert.doesNotMatch(entry, /innerHTML|outerHTML|localStorage|sessionStorage|peer-discovery|\/main\.js|watchDiscovery|fetch\(/);
  assert.match(entry, /visibilitychange/); assert.match(entry, /lostpointercapture/); assert.match(entry, /kind: 'config'/);
});
