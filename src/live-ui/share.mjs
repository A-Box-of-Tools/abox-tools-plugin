import { makeCode } from '../../vendor/abox/tools/share-text/src/names.js';
import { ShareSession, checkedText, checkedFiles, readTextFile, shareLimits, shareInvitation, saveReceivedParts, startPreparedShare } from './share-controller.mjs';

const $ = id => document.getElementById(id), bridge = request => window.aboxLive(request);
const phrases = { ready: 'Ready. Choose when to connect.', connecting: 'Contacting the pairing service…', hosting: 'Sharing privately. Waiting for a reader.',
  sharing: 'Sharing with approved readers.', 'waiting-content': 'Connected. Waiting for the sharer…', private: 'The sharer requires approval. Choose Request access.',
  'waiting-approval': 'Waiting for the sharer to approve this request.', receiving: 'Connected to the share.', stopped: 'Stopped. No sharing connections remain.',
  ended: 'The sharer ended this session.', denied: 'The sharer declined this request.', disconnected: 'The connection closed. Choose Connect to try again.',
  'name-taken': 'That share code is already in use. Close this session and choose another code.', 'not-found': 'No open share was found under that code.',
  'connection-failed': 'The connection could not be established. Check both pages, local-network mode and network isolation, then try again.',
  'mode-mismatch': 'The other page uses a different network mode. Start it in Local network mode; this page never switches to a relay.',
  'protocol-error': 'The peer sent unsupported or oversized information. The connection was closed.', 'save-failed': 'The received file could not be saved. No incomplete output is retained.',
  error: 'The local sharing page could not start.' };
let config, limits, session = null, saving = false, starting = false, received = '', offered = [], readingVersion = 0, loadedFile = null, startVersion = 0;
const requests = new Map();
const message = value => { $('message').textContent = value; };
function controls() {
  const active = Boolean(session?.active);
  $('start').disabled = starting || saving; $('stop').disabled = !active && !starting && !saving;
  $('room-name').disabled = active || starting; $('attachments').disabled = active || starting; $('text-input').disabled = active || starting;
  $('update-text').disabled = config?.role !== 'host' || !active;
  $('save-text').disabled = !config?.has_output_dir || !active || !session?.readerAdmitted || saving || Boolean(session?.rx || session?.delivering);
  for (const button of $('offered-files').querySelectorAll('button')) button.disabled = !config?.has_output_dir || !active || saving || Boolean(session?.rx || session?.delivering);
  $('start').textContent = config?.role === 'reader' ? 'Connect' : active ? 'Restart sharing' : 'Start sharing';
}
function state(value) {
  $('state').textContent = phrases[value.phase] ?? 'Sharing state changed.';
  $('knock-row').hidden = !['private', 'waiting-approval'].includes(value.phase);
  $('knock').disabled = value.phase !== 'private'; $('introduction').disabled = value.phase !== 'private';
  if (!session?.active) { requests.clear(); $('requests').replaceChildren(); $('invitation-row').hidden = true; }
  controls();
  const phase = value.phase === 'ready' ? 'idle' : value.phase === 'connecting' ? 'starting'
    : value.connected ? 'connected' : ['hosting', 'private', 'waiting-content', 'waiting-approval'].includes(value.phase) ? 'waiting'
      : ['stopped', 'ended', 'denied', 'disconnected'].includes(value.phase) ? 'stopped' : 'error';
  void bridge({ kind: 'status', phase, connected: value.connected, peer_count: value.peer_count, capture: 'none' }).catch(() => {});
}
function renderSelected() {
  $('selected-files').replaceChildren();
  try {
    for (const file of checkedFiles($('attachments').files, limits)) { const item = document.createElement('li'); item.textContent = `${file.name} (${file.size.toLocaleString()} bytes)`; $('selected-files').append(item); }
  } catch { message('The selected files exceed the local sharing limits. Choose at most 16 files, 128 MiB each and 256 MiB combined.'); }
}
function peerRequest(value) {
  requests.get(value.id)?.remove(); requests.delete(value.id); if (value.removed) return;
  const row = document.createElement('div'), label = document.createElement('span'), approve = document.createElement('button'), deny = document.createElement('button'); row.className = 'peer';
  label.textContent = value.note ? `Reader introduction: ${value.note}` : 'A reader requests access without an introduction.';
  approve.type = deny.type = 'button'; approve.textContent = 'Approve reader'; deny.textContent = 'Decline'; deny.className = 'deny';
  approve.onclick = () => session?.approve(value.id); deny.onclick = () => session?.deny(value.id);
  row.append(label, approve, deny); requests.set(value.id, row); $('requests').append(row);
}
function renderOffered(files) {
  offered = files; $('offered-files').replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button'); row.className = 'file';
    label.textContent = `${file.name || 'Unnamed file'} (${file.size.toLocaleString()} bytes)`; button.type = 'button'; button.textContent = 'Receive and save';
    button.onclick = () => { message(''); if (!session?.receive(file.id)) message('Another transfer is active, the item changed, or this session reached its receive limit.'); controls(); };
    row.append(label, button); $('offered-files').append(row);
  }
  controls();
}
async function saveParts(parts, settings) {
  saving = true; controls();
  try { await saveReceivedParts(bridge, parts, settings); message('Saved a new file in the chosen output folder.'); }
  catch { message('The save was stopped or could not finish. No incomplete output is retained.'); throw new Error('Local save failed.'); }
  finally { saving = false; controls(); }
}
async function loadText() {
  const file = $('text-input').files[0]; if (!file || file === loadedFile) return;
  const version = ++readingVersion;
  try { const text = await readTextFile(file, limits); if (version === readingVersion && !session?.active) { $('share-text').value = text; loadedFile = file; message('Local text loaded. Choose Start sharing when ready.'); } }
  catch { if (version === readingVersion) { loadedFile = null; message('Choose valid UTF-8 text within 50,000 characters and 200,000 bytes.'); throw new Error('Text file is unsupported.'); } }
}
function stop() { startVersion++; readingVersion++; const owned = session; owned?.stop(); session = null; starting = false; received = ''; offered = []; $('received-text').textContent = ''; renderOffered([]); $('cancel-file').hidden = true; controls(); }

$('attachments').addEventListener('change', renderSelected);
$('text-input').addEventListener('change', () => { void loadText().catch(() => {}); });
$('share-text').addEventListener('input', () => { readingVersion++; loadedFile = $('text-input').files[0] ?? null; });
$('start').addEventListener('click', async () => {
  if (starting || saving) return;
  if (session) stop(); const version = ++startVersion, current = () => startVersion === version;
  try {
    starting = true; controls(); message('');
    const owner = await startPreparedShare({ current, prepare: async () => {
      if (config.role === 'host') await loadText();
      return { text: config.role === 'host' ? checkedText($('share-text').value, limits) : '', files: config.role === 'host' ? checkedFiles($('attachments').files, limits) : [] };
    }, create: ({ text, files }) => {
    const created = new ShareSession({ role: config.role, room: $('room-name').value, text, files, limits,
      onState: state, onRequest: peerRequest, onText: text => { received = text; $('received-text').textContent = text; controls(); }, onFiles: renderOffered,
      onProgress: value => { $('cancel-file').hidden = !value.receiving; $('progress').textContent = value.receiving ? `Receiving ${value.bytes.toLocaleString()} of ${value.total.toLocaleString()} bytes…` : value.cancelled ? 'File transfer cancelled.' : ''; controls(); },
      onReceived: async value => {
        if (!config.has_output_dir || !value.current()) throw new Error('No output folder.');
        await saveParts(value.parts, { name: value.name, size: value.size, type: 'file', current: value.current });
      } }); session = created; return created;
    } });
    if (!owner || !current()) return;
    if (config.role === 'host' && owner.active) { $('invitation').value = shareInvitation(owner.room); $('invitation-row').hidden = false; }
  } catch { if (current()) { if (session) stop(); message('The share could not start. Check the share code, local-network link, text encoding and file limits.'); } }
  finally { if (current()) { starting = false; controls(); } }
});
$('stop').addEventListener('click', stop);
$('close-session').addEventListener('click', () => { stop(); void bridge({ kind: 'stop' }).catch(() => message('Close this companion window to end the session.')); });
$('update-text').addEventListener('click', () => { try { session?.updateText($('share-text').value); message('Updated text sent to approved readers.'); } catch { message('The text exceeds the local character or UTF-8 byte limit.'); } });
$('knock').addEventListener('click', () => { session?.knock($('introduction').value); });
$('cancel-file').addEventListener('click', () => { session?.cancelFile(); controls(); });
$('save-text').addEventListener('click', async () => {
  const owner = session; if (!owner?.active || !owner.readerAdmitted || saving || !config.has_output_dir) return;
  const bytes = new TextEncoder().encode(received), generation = owner.generation;
  try { await saveParts([bytes.buffer], { name: '', size: bytes.length, type: 'text', current: () => session === owner && owner.active && owner.generation === generation }); } catch {}
});
$('copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('invitation').value); message('Share link copied.'); }
  catch { $('invitation').focus(); $('invitation').select(); message('Select and copy the share link manually.'); }
});
window.addEventListener('pagehide', stop);
try {
  config = await bridge({ kind: 'config' });
  if (!config || config.tool !== 'share-text' || !['host', 'reader'].includes(config.role) || typeof config.has_output_dir !== 'boolean') throw new Error();
  limits = shareLimits(config.limits); $('title').textContent = config.role === 'host' ? 'Share local text and files' : 'Receive text and files';
  $('host-options').hidden = config.role !== 'host'; $('reader-options').hidden = config.role !== 'reader';
  $('room-name').value = config.room_name ?? (config.role === 'host' ? makeCode() : ''); $('room-name').readOnly = Boolean(config.room_name);
  if (!config.has_output_dir && config.role === 'reader') $('save-policy').textContent = 'No output folder was chosen. Received text can be viewed here; create a receive session with an output folder to save text or files.';
  state({ phase: 'ready', connected: false, peer_count: 0, capture: false }); renderSelected();
  if (config.role === 'host' && $('text-input').files.length) await loadText();
} catch { $('state').textContent = 'This page must be opened by the local abox.tools adapter.'; $('start').disabled = true; }
