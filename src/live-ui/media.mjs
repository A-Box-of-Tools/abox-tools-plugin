import { CameraSession } from '/vendor/abox/tools/remote-camera/src/session.js';
import { CameraCapture } from '/vendor/abox/tools/remote-camera/src/capture.js';
import { makeCode, parseCode } from '/vendor/abox/tools/remote-camera/src/protocol.js';
import { BroadcastSession } from '/vendor/abox/tools/walkie-talkie/src/session.js';
import { InboxSession } from '/vendor/abox/tools/voice-oncall/src/session.js';
import { makeInboxIdentity, makeSenderKey, derivePasswordProof } from '/vendor/abox/tools/voice-oncall/src/inbox-credentials.js';
import { createMediaController, mediaConfig } from './media-controller.mjs';

const element = id => document.getElementById(id);
const ui = Object.fromEntries(['title', 'purpose', 'status', 'setup', 'room-field', 'room', 'invitation-field', 'invitation', 'password-field', 'password',
  'start', 'invitation-output', 'share-link', 'copy', 'copy-status', 'camera-section', 'camera-title', 'camera', 'camera-empty', 'approval-section',
  'requests', 'requests-empty', 'viewers', 'viewers-empty', 'voice-section', 'talk-controls', 'talk', 'sound', 'sound-status', 'audio-streams',
  'participants-title', 'participants', 'participants-empty', 'stop', 'close'].map(id => [id, element(id)]));
let controller, soundEnabled = false, disposed = false;
const audio = new Map(), localMuted = new Set();

function clearMedia() {
  ui.camera.pause(); ui.camera.srcObject = null; ui['camera-empty'].hidden = false;
  for (const node of audio.values()) { node.pause(); node.srcObject = null; node.remove(); }
  audio.clear(); localMuted.clear(); soundEnabled = false; ui['sound-status'].textContent = 'Sound has not been enabled.';
}
function mute(id, value) {
  if (value) localMuted.add(id); else localMuted.delete(id);
  const node = audio.get(id); if (node) node.muted = value;
}
async function playSound() {
  soundEnabled = true; let blocked = false;
  for (const node of audio.values()) { try { await node.play(); } catch { blocked = true; } }
  ui['sound-status'].textContent = blocked ? 'Playback is paused by the browser. Use the audio player controls to enable sound.' : audio.size ? 'Sound enabled for connected streams.' : 'Sound enabled. Waiting for a voice stream.';
}
function receive(stream, id, detail) {
  if (id === '*') { clearMedia(); return; }
  if (stream?.getVideoTracks().length || id === 'preview' || controller?.snapshot.tool === 'remote-camera') {
    // This companion exposes video-only camera playback. Muting before play
    // also retains the website's silent-video autoplay behavior after approval.
    ui.camera.muted = true; ui.camera.srcObject = stream; ui['camera-empty'].hidden = Boolean(stream);
    if (stream) void ui.camera.play().catch(() => { ui['camera-empty'].hidden = false; ui['camera-empty'].textContent = 'Use the video player Play control to view the connected camera.'; });
    else ui.camera.pause(); return;
  }
  let node = audio.get(id);
  if (!stream) { if (node) { node.pause(); node.srcObject = null; node.remove(); audio.delete(id); } return; }
  if (!node) {
    node = document.createElement('audio'); node.controls = true; node.setAttribute('aria-label', 'Received voice stream');
    audio.set(id, node); ui['audio-streams'].append(node);
  }
  // Muting is local playback authority, independent of cooperative signaling.
  node.muted = localMuted.has(id) || detail.muted; node.srcObject = stream;
  if (soundEnabled) void node.play().catch(() => { ui['sound-status'].textContent = 'Use the audio player controls to enable sound.'; });
}
function button(label, action, disabled = false) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.disabled = disabled; node.addEventListener('click', action); return node;
}
function row(label, actions) { const node = document.createElement('li'), title = document.createElement('p'); title.textContent = label; node.append(title, ...actions); return node; }
function render(state) {
  ui.status.textContent = state.message;
  const running = ['starting', 'waiting', 'connected', 'reconnecting'].includes(state.phase);
  ui.start.disabled = running; ui.stop.disabled = !running;
  for (const input of [ui.room, ui.invitation, ui.password]) input.disabled = running;
  ui['invitation-output'].hidden = !state.invitation; ui['share-link'].value = state.invitation;
  if (!state.invitation) ui['copy-status'].textContent = '';
  ui.talk.disabled = !state.can_talk; ui.talk.setAttribute('aria-pressed', String(state.talking)); ui.talk.textContent = state.talking ? 'Talking — release to mute' : 'Hold Talk';
  ui.requests.replaceChildren(...state.requests.map(item => row(item.note || 'Unverified viewer request', [button('Approve viewer', () => controller.approve(item.id)), button('Decline viewer', () => controller.deny(item.id))])));
  ui['requests-empty'].hidden = state.requests.length > 0;
  ui.viewers.replaceChildren(...state.viewers.map(item => row(`${item.note || 'Approved viewer'} · ${item.streaming ? 'connected' : 'waiting for video'}`, [button('Disconnect viewer', () => controller.disconnect(item.id))])));
  ui['viewers-empty'].hidden = state.viewers.length > 0;
  ui.participants.replaceChildren(...state.participants.map((item, index) => {
    const name = item.name || `Caller ${index + 1}`;
    return row(`${name} · ${item.pendingRemoval ? 'removal pending' : item.muted ? 'muted' : item.talking ? 'speaking' : item.connected ? 'connected' : 'connecting'}`, [
      button(item.muted ? 'Unmute caller' : 'Mute caller', () => controller.moderate(item.id, !item.muted), item.pendingRemoval),
      button('Remove caller', () => controller.kick(item.id), item.pendingRemoval),
    ]);
  }));
  ui['participants-empty'].hidden = state.participants.length > 0 || state.tool !== 'voice-oncall' || state.role !== 'host';
}

function releaseTalk() { controller?.setTalking(false); }
ui.talk.addEventListener('pointerdown', event => { if (event.button !== 0 || ui.talk.disabled) return; event.preventDefault(); ui.talk.setPointerCapture?.(event.pointerId); controller.setTalking(true); });
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) ui.talk.addEventListener(name, releaseTalk);
ui.talk.addEventListener('keydown', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) controller?.setTalking(true); } });
ui.talk.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); releaseTalk(); } });
ui.talk.addEventListener('blur', releaseTalk);
window.addEventListener('blur', releaseTalk);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseTalk(); });
window.addEventListener('pagehide', () => { disposed = true; controller?.stop(); clearMedia(); });
ui.setup.addEventListener('submit', async event => {
  event.preventDefault(); if (!controller || disposed) return;
  const password = ui.password.value; ui.password.value = '';
  await controller.start({ room_name: ui.room.value, invitation: ui.invitation.value, password });
});
ui.stop.addEventListener('click', () => controller?.stop());
ui.sound.addEventListener('click', () => void playSound());
ui.copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ui['share-link'].value); ui['copy-status'].textContent = 'Invitation copied. Share only with the intended device.'; }
  catch { ui['share-link'].focus(); ui['share-link'].select(); ui['copy-status'].textContent = 'Select and copy the invitation from the field.'; }
});
ui.close.addEventListener('click', async () => { controller?.stop(); disposed = true; ui.close.disabled = true; try { await window.aboxLive({ kind: 'stop' }); } catch { ui.status.textContent = 'Stopped. You can close this window.'; } });

try {
  if (typeof window.aboxLive !== 'function') throw new Error('bridge');
  const config = mediaConfig(await window.aboxLive({ kind: 'config' })), host = config.role === 'host', camera = config.tool === 'remote-camera';
  const source = camera ? host : config.tool === 'walkie-talkie' ? host : !host;
  ui.title.textContent = camera ? host ? 'Share this camera' : 'View a remote camera' : config.tool === 'walkie-talkie' ? host ? 'Broadcast push-to-talk voice' : 'Listen to push-to-talk voice' : host ? 'Open a voice pager' : 'Call a voice pager';
  document.title = `${ui.title.textContent} · abox.tools`;
  ui.purpose.textContent = camera ? host ? 'Starting asks for camera access. No microphone is requested. Each viewer must be approved here before video is sent.' : 'Connecting does not request a camera or microphone. The camera owner must approve this device.' : source ? 'Starting asks for microphone access. Voice stays muted until you hold Talk.' : 'Starting does not request a camera or microphone. Use Enable sound to hear incoming voice.';
  ui.start.textContent = host ? 'Start' : 'Connect';
  ui['room-field'].hidden = config.tool !== 'voice-oncall' || !host; ui.room.value = config.room_name || 'Local pager';
  ui['invitation-field'].hidden = host; ui.invitation.value = config.invitation;
  ui['password-field'].hidden = config.tool !== 'voice-oncall';
  ui['camera-section'].hidden = !camera; ui['camera-title'].textContent = host ? 'Local camera preview' : 'Received camera';
  ui['approval-section'].hidden = !camera || !host;
  ui['voice-section'].hidden = camera; ui['talk-controls'].hidden = !source || camera;
  ui.sound.hidden = source; ui['sound-status'].hidden = source;
  ui['participants-title'].hidden = config.tool !== 'voice-oncall' || !host;
  controller = createMediaController({ config, engines: { CameraSession, CameraCapture, makeCode, parseCode, BroadcastSession, InboxSession, makeInboxIdentity, makeSenderKey, derivePasswordProof, mediaDevices: navigator.mediaDevices },
    render, onMedia: receive, onMute: mute, report: status => window.aboxLive({ kind: 'status', ...status }) });
} catch {
  ui.status.textContent = 'The local companion could not initialize this session. Close this window and open a new session from your agent.';
  ui.start.disabled = true; ui.stop.disabled = true;
}
