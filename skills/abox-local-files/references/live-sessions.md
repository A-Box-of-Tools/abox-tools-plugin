# Live text, camera and voice sessions

These opt-in tools open a separate visible companion. The existing 66 file tools
remain offline. A live window alone starts no pairing or capture: the person
clicks Start or Connect, enters invitations/passwords and handles permissions
there. Do not read those secrets or received content into the conversation, or
click device/peer approvals on the person's behalf. Return the session identifier
and explain the next visible action.

## Choose the session

Every open operation requires `role`. Optional `ttl_minutes` is an integer from
1 to 120 (default 30). Prefer omitting `room_name` so the person chooses the
address/label locally. For Share Text it is a share code: 1–64 lowercase letters,
digits and hyphens, starting with a letter or digit. For media it is an optional
label of at most 80 characters, including the voice-inbox pager name. Keep
sensitive labels and invitation addresses in the window. At most four windows
can run in one adapter process.

| MCP operation | CLI command | Roles and behavior |
|---|---|---|
| `abox_share_session` | `share-session` | `host` shares selected text/files; `reader` connects with a local-network invitation and requests approval |
| `abox_camera_session` | `camera-session` | `host` grants video-only camera access and approves each viewer; `viewer` receives the approved video |
| `abox_walkie_session` | `walkie-session` | `host` grants microphone access and holds Talk; `listener` receives voice without microphone capture |
| `abox_voice_oncall_session` | `voice-oncall-session` | `host` listens/moderates callers with an optional window-entered password; `sender` grants microphone access and holds Talk |

The voice-inbox host needs a nonempty pager name in the window. Camera sharing
has no microphone option, recording, alerts or camera-switching controls. Voice
has no hands-free toggle or automatic capture restart. The receiving person
enables playback in the window. Full invitations, capability keys and passwords
are entered/shared there rather than copied into tool requests or responses.

## Share local text/files

Only the share `host` accepts optional `text_path` and `input_paths`. Use existing
absolute local paths; never copy the file's text into a tool request. The host
can also choose inputs in the window. Limits: 16 attachments, 128 MiB per file,
256 MiB combined; UTF-8 text at most 50,000 characters and 200,000 bytes.
The text view is plain text; Markdown/HTML from a peer is not executed.
Text editing can normalize an initial UTF-8 BOM or line endings. Send the file
as an attachment when byte-exact preservation is required.

For explicit local saves, set `output_dir` to a new absolute directory when
opening a receiving share session. Without it, received text can be viewed in
the window but cannot be saved through the adapter. The person clicks Save text
or Receive and save for each item. Peer names are displayed in the window but
saved under generated `text-<id>.txt` or `received-<id>.bin` names. Completed
saves are retained; unfinished receives/saves are removed when stopped. Existing
outputs are never overwritten. Link the output directory and report saved counts
without listing or reading its private contents.

## Status and lifetime

`abox_live_status` / `live-status`: optional `session_id` selects one window;
omitting it lists this adapter process's windows. It returns only safe state,
tool/role, peer count, capture kind, expiry and saved counts/bytes/output directory.
It does not return pairing URLs, received text, participant names or media.
Check it after the person completes a visible action or asks for status.

`abox_live_stop` / `live-stop`: required `session_id`. Closes that companion,
releases capture/transports and removes unfinished files. An already closed
session is harmless. Completed saves remain. Closing the window, expiry or
adapter shutdown also ends its session. The window's Stop button ends the
connection while leaving its controls available for an explicit restart; Close
session closes the entire window.

Session identifiers belong to one running adapter process. MCP is the preferred
route for later status/stop calls. A CLI open command stays running with its
window; a second CLI process cannot control that first process's sessions.
Use its visible controls or Ctrl+C in the original CLI process.

## Network boundary

Live mode uses the existing `wss://rendezvous.abox.tools` pairing service. It sees
IP addresses, timing, room identifiers, any mode-specific labels/access
authentication data, and WebRTC negotiation metadata. Cloudflare keeps seven-day
metadata logs. Content travels over encrypted direct
WebRTC with host candidates. This companion offers no STUN/TURN fallback,
discovery or recording, and can require devices on a directly reachable network.
Host candidates do not guarantee a private-subnet-only path. Ask the person to
use the website's Local network mode on the other device when required.

Do not upload files, add a relay, open decoded links or start recording as a
fallback. The peer can retain or record what it receives outside this adapter.
An installed browser and graphical desktop are required; ordinary headless
file processing is separate. Synthetic device/browser tests are not proof of
physical-device compatibility or a user's actual peer connection.
