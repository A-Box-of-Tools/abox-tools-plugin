const TOOLS = new Set(['remote-camera', 'walkie-talkie', 'voice-oncall']);
const CODE = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function mediaConfig(value) {
  if (!value || !TOOLS.has(value.tool)) throw new Error('Unsupported live tool.');
  const role = value.tool === 'remote-camera' && value.role === 'camera' ? 'host' : value.role;
  const roles = value.tool === 'remote-camera' ? ['host', 'viewer'] : value.tool === 'walkie-talkie' ? ['host', 'listener'] : ['host', 'sender'];
  if (!roles.includes(role) || value.invitation !== undefined && !text(value.invitation, 2048)
      || value.room_name !== undefined && !text(value.room_name, 80)) throw new Error('Unsupported live configuration.');
  return Object.freeze({ tool: value.tool, role, invitation: value.invitation ?? '', room_name: value.room_name ?? '' });
}

export function voiceInvitation(tool, input) {
  if (!['walkie-talkie', 'voice-oncall'].includes(tool) || !text(input, 2048)) throw new Error('Use a valid invitation for this tool.');
  let fragment = input.trim().replace(/^#/, '');
  if (/^https?:/i.test(fragment)) {
    let url;
    try { url = new URL(fragment); } catch { throw new Error('Use a valid invitation for this tool.'); }
    if (url.origin !== 'https://abox.tools' || url.pathname !== `/${tool}/` || url.username || url.password || url.search) throw new Error('Use an abox.tools invitation for this tool.');
    fragment = url.hash.slice(1);
  }
  if (tool === 'voice-oncall' && CODE.test(fragment)) return { code: fragment };
  const params = new URLSearchParams(fragment), allowed = tool === 'walkie-talkie' ? ['code', 'listen'] : ['code'];
  if ([...params.keys()].some(key => !allowed.includes(key)) || allowed.some(key => params.getAll(key).length !== 1)
      || !CODE.test(params.get('code') ?? '') || tool === 'walkie-talkie' && !KEY.test(params.get('listen') ?? '')) throw new Error('Use a complete invitation for this tool.');
  return { code: params.get('code'), ...(tool === 'walkie-talkie' ? { key: params.get('listen') } : {}) };
}

export function cameraInvitation(input, parseCode) {
  if (!text(input, 2048)) throw new Error('Use a valid camera invitation.');
  if (/^https?:/i.test(input.trim())) {
    let url;
    try { url = new URL(input.trim()); } catch { throw new Error('Use a valid camera invitation.'); }
    if (url.origin !== 'https://abox.tools' || url.pathname !== '/remote-camera/' || url.username || url.password || url.search) throw new Error('Use an abox.tools camera invitation.');
  }
  const code = parseCode(input);
  if (!code) throw new Error('Use a valid camera invitation.');
  return code;
}

const errorMessages = {
  'error-microphone': 'Microphone access failed or was interrupted. Stop and start again when ready.',
  'error-password': 'The pager password was refused. Check it and connect again.',
  'error-access': 'The invitation or access credential was refused.',
  'error-full': 'The receiver has reached its connection limit.',
  'error-connection': 'The direct connection could not be established. Check both devices and try again.',
  'connection.server-failed': 'The pairing service could not be reached. Stop and try again.',
  'connection.direct-failed': 'The devices could not establish a direct connection. They may need the same reachable network.',
  'connection.not-found': 'This invitation is not currently available.',
  'connection.taken': 'This invitation is already in use.',
  'connection.busy': 'This session has reached its connection limit.',
  'connection.invalid': 'The peer sent an unsupported connection message. The session was closed.',
  'code.invalid': 'The camera invitation is invalid.',
  'viewer.denied': 'The camera owner declined this request.',
  'camera.ended': 'Camera access ended. Stop and start again when ready.',
  'camera.switch-ended': 'Camera access ended. Stop and start again when ready.',
  'camera.paused': 'The camera is paused. Stop and start again when ready.',
};

// This controller has no permission, storage or transport work at construction.
// The browser view supplies unchanged website engines only after explicit Start.
export function createMediaController({ config: rawConfig, engines, render = () => {}, report = () => {}, onMedia = () => {}, onMute = () => {} }) {
  const config = mediaConfig(rawConfig);
  let epoch = 0, session = null, capture = null, busy = false, active = false, talking = false, lastReport = '';
  const muted = new Set(), captureListeners = [];
  const state = { ...config, phase: 'idle', connected: false, peer_count: 0, capture: 'none', invitation: '',
    message: 'Nothing is connected. Start when you are ready.', requests: [], viewers: [], participants: [], talking: false, can_talk: false };
  function publish() {
    render({ ...state, requests: state.requests.map(row => ({ ...row })), viewers: state.viewers.map(row => ({ ...row })), participants: state.participants.map(row => ({ ...row })) });
    const safe = { phase: state.phase, connected: state.connected, peer_count: state.peer_count, capture: state.capture }, encoded = JSON.stringify(safe);
    if (encoded !== lastReport) { lastReport = encoded; void Promise.resolve(report(safe)).catch(() => {}); }
  }
  function media(stream, id = 'remote', local = false) { onMedia(stream, id, { local, muted: local || muted.has(id) }); }
  function release() {
    for (const remove of captureListeners.splice(0)) remove();
    const old = session; session = null;
    try { old?.setTalking?.(false); } catch {}
    try { config.tool === 'remote-camera' ? old?.stop() : old?.stop({ notify: true, state: null }); } catch {}
    try { capture?.stop(); } catch {} capture = null;
    talking = false; busy = active = false; muted.clear();
    state.capture = 'none'; state.connected = false; state.peer_count = 0; state.talking = false; state.can_talk = false;
    state.requests = []; state.viewers = []; state.participants = []; media(null, '*');
  }
  function stop() { ++epoch; release(); state.phase = 'stopped'; state.invitation = ''; state.message = 'Stopped. Camera, microphone and peer connections are closed.'; publish(); }
  function failed(message) { ++epoch; release(); state.phase = 'error'; state.invitation = ''; state.message = message; publish(); }
  function watchCamera(stream, current) {
    const tracks = stream.getVideoTracks();
    const ended = () => { if (current()) failed(errorMessages['camera.ended']); };
    for (const track of tracks) {
      track.addEventListener('ended', ended, { once: true });
      captureListeners.push(() => track.removeEventListener('ended', ended));
    }
    // A native device can finish between permission resolution and listener
    // installation. Never publish an invitation for that already-ended source.
    if (!tracks.length || tracks.some(track => track.readyState !== 'live')) ended();
    return current();
  }
  function cameraState(key) {
    if (errorMessages[key]) return failed(errorMessages[key]);
    if (['connection.ended', 'connection.stopped'].includes(key)) return failed('The other device ended the connection. You can start again.');
    if (key.includes('reconnect') || key === 'viewer.signaling-lost') { state.phase = 'reconnecting'; state.message = 'Pairing is reconnecting. An existing direct connection may continue.'; }
    else if (key === 'camera.streaming') { state.phase = 'connected'; state.connected = true; state.message = 'Camera is streaming to approved viewers.'; }
    else { state.phase = state.connected ? 'connected' : 'waiting'; state.message = config.role === 'host' ? 'Camera is ready. Share its invitation and approve each viewer below.' : 'Waiting for the camera owner to approve this device.'; }
    publish();
  }
  function voiceState(key, detail = {}) {
    if (errorMessages[key]) return failed(errorMessages[key]);
    if (['broadcast-ended', 'inbox-ended', 'listener-left', 'sender-left', 'kicked'].includes(key)) return failed(key === 'kicked' ? 'The receiver removed this caller.' : 'The other device ended the session. You can start again.');
    if (key === 'error-moderation-full') { state.message = 'The receiver could not confirm that moderation action. Local muting remains active.'; publish(); return; }
    if (key.startsWith('error-')) return failed('The live connection could not continue. Stop and try again.');
    const source = config.tool === 'walkie-talkie' ? config.role === 'host' : config.role === 'sender';
    state.connected = Boolean(detail.directReady);
    if (config.tool === 'walkie-talkie' && config.role === 'host') state.peer_count = Number.isSafeInteger(detail.listeners) ? Math.min(32, Math.max(0, detail.listeners)) : 0;
    else if (config.role !== 'host') state.peer_count = state.connected ? 1 : 0;
    state.can_talk = source && detail.captureState === 'ready' && !detail.muted && Boolean(detail.directReady || detail.signaling && !detail.waiting);
    state.talking = talking && state.can_talk;
    if (!state.can_talk && talking) { talking = false; session?.setTalking(false); }
    if (source && ['ended', 'interrupted'].includes(detail.captureState)) state.message = 'The microphone is interrupted. Stop and start again when ready.';
    else if (detail.muted) state.message = 'The receiver has muted this caller.';
    else state.message = state.connected ? source ? 'Connected. Hold Talk to send voice; release to mute.' : 'Connected. Enable sound to listen.' : config.role === 'host' ? 'Ready. Share the invitation with the other device.' : 'Waiting for a direct connection. Both devices may need the same reachable network.';
    state.phase = key.includes('reconnect') ? 'reconnecting' : state.connected ? 'connected' : 'waiting'; publish();
  }
  async function start(values = {}) {
    if (busy || active) return false;
    const current = ++epoch; busy = true; state.phase = 'starting'; state.message = 'Starting only the selected session…'; state.invitation = ''; publish();
    const isCurrent = () => epoch === current;
    try {
      const room = values.room_name === undefined ? config.room_name : values.room_name;
      if (!text(room, 80) || config.tool === 'voice-oncall' && config.role === 'host' && !room.trim()) throw new Error('Enter a pager name from 1 to 80 characters.');
      const invitation = values.invitation === undefined ? config.invitation : values.invitation;
      const password = values.password ?? '';
      if (!text(password, 256)) throw new Error('Use a password of at most 256 characters.');
      if (config.tool === 'remote-camera') {
        const code = config.role === 'host' ? engines.makeCode() : cameraInvitation(invitation, engines.parseCode);
        const instance = new engines.CameraSession({
          onState: key => { if (isCurrent()) cameraState(key); },
          onRequests: rows => { if (isCurrent()) { state.requests = rows.slice(0, 4).map(row => ({ id: row.id, note: String(row.note ?? '').slice(0, 80) })); publish(); } },
          onViewers: rows => { if (isCurrent()) { state.viewers = rows.slice(0, 32).map(row => ({ id: row.id, note: String(row.note ?? '').slice(0, 80), streaming: row.streaming === true })); state.peer_count = state.viewers.filter(row => row.streaming).length; state.connected = state.peer_count > 0; publish(); } },
          onStream: stream => { if (isCurrent()) { media(stream); state.connected = Boolean(stream?.getVideoTracks().some(track => track.readyState === 'live')); state.peer_count = state.connected ? 1 : 0; state.phase = state.connected ? 'connected' : 'waiting'; state.message = state.connected ? 'Connected to the approved camera.' : 'Waiting for camera video.'; publish(); } },
        }); session = instance;
        if (config.role === 'host') {
          capture = new engines.CameraCapture();
          const stream = await capture.start({ video: { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 15, max: 30 } }, audio: false });
          if (!isCurrent() || !stream) return false;
          if (!watchCamera(stream, isCurrent)) return false;
          state.capture = 'camera'; media(stream, 'preview', true); publish();
          if (!isCurrent()) return false;
          await instance.startHost(stream, code, { discoverable: false, requireApproval: true });
          if (isCurrent()) state.invitation = `https://abox.tools/remote-camera/#${code}`;
        } else await instance.connect(code, 'Local companion viewer');
      } else {
        let identity;
        if (config.role === 'host') {
          identity = await engines.makeInboxIdentity();
          if (!isCurrent()) return false;
          if (config.tool === 'walkie-talkie') identity.listenKey = engines.makeSenderKey();
          else identity.passwordProof = password ? await engines.derivePasswordProof(identity.code, password) : null;
          identity.roomName = room.trim() || 'Local voice session';
        } else {
          identity = voiceInvitation(config.tool, invitation);
          if (config.tool === 'voice-oncall') { identity.key = engines.makeSenderKey(); identity.passwordProof = password ? await engines.derivePasswordProof(identity.code, password) : null; }
        }
        if (!isCurrent()) return false;
        const source = config.tool === 'walkie-talkie' ? config.role === 'host' : config.role === 'sender';
        const Session = config.tool === 'walkie-talkie' ? engines.BroadcastSession : engines.InboxSession;
        const mediaDevices = engines.mediaDevices ? { getUserMedia: async constraints => {
          const stream = await engines.mediaDevices.getUserMedia(constraints);
          if (isCurrent()) { state.capture = 'microphone'; publish(); }
          return stream;
        } } : undefined;
        const instance = new Session({ role: config.role, ...identity, discover: false,
          ...(mediaDevices ? { mediaDevices } : {}),
          onState: (key, detail) => { if (isCurrent()) voiceState(key, detail); },
          onStream: (stream, id) => { if (isCurrent()) media(stream, id ?? 'remote'); },
          onParticipants: rows => { if (isCurrent()) { state.participants = rows.slice(0, 10).map(row => ({ id: row.id, name: String(row.name ?? '').slice(0, 64), muted: Boolean(row.muted || muted.has(row.id)), connected: row.connected === true, talking: row.talking === true, pendingRemoval: row.pendingRemoval === true })); state.peer_count = state.participants.filter(row => row.connected).length; state.connected = state.peer_count > 0; publish(); } },
        }); session = instance;
        // start() owns the permission race and closes a late stream after Stop.
        const success = await instance.start();
        if (!isCurrent()) return false;
        if (!success) { failed('The session did not start. Check access, device permissions and the other device.'); return false; }
        state.capture = source ? 'microphone' : 'none';
        if (config.role === 'host') {
          const params = new URLSearchParams({ code: identity.code, ...(config.tool === 'walkie-talkie' ? { listen: identity.listenKey } : {}) });
          state.invitation = `https://abox.tools/${config.tool}/#${params}`;
        }
      }
      if (!isCurrent()) return false;
      active = true; busy = false; if (state.phase === 'starting') state.phase = 'waiting'; publish(); return true;
    } catch (error) {
      if (isCurrent()) failed(['Enter a pager name from 1 to 80 characters.', 'Use a password of at most 256 characters.', 'Use a valid invitation for this tool.', 'Use an abox.tools invitation for this tool.', 'Use a complete invitation for this tool.', 'Use a valid camera invitation.', 'Use an abox.tools camera invitation.'].includes(error?.message) ? error.message : 'The session could not start. Check device permissions, the invitation and the pairing connection.');
      return false;
    } finally { if (isCurrent()) { busy = false; publish(); } }
  }
  function setTalking(value) { talking = value === true && active && state.can_talk; session?.setTalking?.(talking); state.talking = talking; publish(); }
  function approve(id) { return state.requests.some(row => row.id === id) && session?.approve(id) === true; }
  function deny(id) { return state.requests.some(row => row.id === id) && session?.deny(id); }
  function disconnect(id) { return state.viewers.some(row => row.id === id) && session?.disconnectViewer(id); }
  function moderate(id, value) {
    if (!state.participants.some(row => row.id === id)) return false;
    if (value) muted.add(id); else muted.delete(id); onMute(id, value === true);
    return session?.moderate(id, value) === true;
  }
  function kick(id) { if (!state.participants.some(row => row.id === id)) return false; muted.add(id); onMute(id, true); return session?.kick(id) === true; }
  publish();
  return { start, stop, setTalking, approve, deny, disconnect, moderate, kick, get snapshot() { return { ...state }; } };
}
