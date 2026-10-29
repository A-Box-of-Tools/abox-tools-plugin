# Privacy notice for the abox.tools local plugin

Effective 29 October 2026.

The abox.tools local plugin processes images, GIFs, PDFs, audio, video,
QR/barcodes, structured text, file comparisons, encodings and checksums, and
generates passwords and local reports on the computer where its
MCP server runs. These file operations have no hosted processing service,
analytics, telemetry, account system or API key, and do not upload contents to a
processing service. Separate opt-in live sessions can send selected text, files,
camera video or voice directly to another device after the person starts the
visible companion. Their network and permission boundaries are described below.

## Data used for a file operation

The agent supplies absolute input and output paths and operation settings. The
adapter reads the selected local file, processes its bytes in memory, and writes
new local outputs. It refuses to overwrite existing outputs. A large PDF split
also creates a local manifest listing the output files and source page numbers.
GIF frame extraction creates a local timing manifest. Password generation
writes plaintext secrets only to the selected new local file. It does not
register accounts, change credentials or keep a password history.

The MCP response contains paths, operation settings and results such as file
sizes, page counts, image dimensions, metadata inventory counts, checksum digests,
verification status, and error messages. Metadata inspection does not return tag values.
File bytes are not returned in MCP responses. The adapter does not maintain a
separate upload, user database, or processing history.

Image processing, images to PDF, PDF compression and watermark text rendering
use an installed browser with an isolated offline context and bundled modules.
PDF page operations, metadata operations and checksums run in the
local Node process. PDF table/security work, video sample copying and selected
text operations run in local worker threads so cancellation can stop their work.
Extraction returns table
counts and diagnostics without cell text or headings. JSON errors expose a
location without source snippets; Base64 contents remain in local output files.
QR and barcode payloads come from local UTF-8 files; their contents, completed
check-digit values and labels are not returned to the agent. The generated images
contain that payload. Unified text patches and image embeddings are written only
to local output files. Image data URIs preserve source bytes and metadata, including
SVG markup; encoding does not sanitize or anonymize the embedded image.
Compression does not require visiting the abox.tools site.
Markdown rendering uses only the sharing tool's pure local helper, with no live
sharing connection. Its passive HTML output keeps safe-scheme links, without
opening them or loading resources. Existing HTML/CSS formatting is different:
it preserves active markup and resource references, never executes or fetches
them during processing, and does not sanitize the saved file. Opening that file
separately can run retained content. XML/JSON conversion saves the documented
lossy mapping locally; recognized values and source excerpts are not returned.
Generated passwords, passphrases, their hashes and samples are excluded from
tool results. Optional password configuration and image redaction rectangles
are read from bounded local JSON files. Rectangle coordinates are not returned
in tool results. The agent still receives their file paths. Redaction replaces
the specified pixels in a new flattened PNG; it does not locate sensitive
content or verify that the chosen rectangles cover everything private.
GIF inspection returns header summaries without comment/application contents,
and explicitly does not verify compressed pixels. Image stacking and tracing
return counts and geometry without source pixels or SVG path data.
The plugin does not download a browser or processing dependencies during an
operation.

Receipt extraction runs bundled Tesseract WebAssembly, a local worker and English
language data in a job-specific offline browser context. It saves recognized
text and suggested merchant, date, currency and amount fields only in the local
JSON/CSV report. MCP results omit that text and those field values. The report
needs human review; it is not a verified ledger. The context permits only its
bundled processing scripts and local worker, with outbound connections blocked.
Other browser jobs keep their existing restrictions unless they need this
explicit capability.

Code reading writes any decoded URL, Wi-Fi password or other payload only into
a new local JSON file. It does not open URLs, join networks or act on the payload.
Document scans and ID photos read explicit dimensions, corners or landmarks
from local JSON; no face or sensitive-content detection service is called.
Business-profile and height previews keep supplied names, descriptions, photos
and measurements in their output files and do not publish a listing.

DICOM inspection excludes patient and private field values from its summary.
DICOM rendering is a technical preview, not anonymization or diagnosis: patient
identifiers burned into the picture can remain. Audio and video results contain
technical timing, sample or geometry checks rather than recordings or packets.
Video packet-copy trimming can retain hidden boundary footage in the output;
it is not secure erasure or redaction.

PDF security reads exact UTF-8 passwords from separate local files, including
any BOM or newline. Passwords and password hashes are excluded from tool results;
no password guessing is performed. Permission flags depend on the document
viewer. Encryption does not replace careful storage of plaintext originals,
password files or decrypted outputs.

## Opt-in live sharing and devices

The live companion supports Share Text, Remote Camera, Walkie Talkie and Voice
Oncall. Opening its isolated visible browser window does not start pairing,
camera capture or microphone capture. The person selects Start or Connect in
that window. Camera hosting requests video permission only; voice broadcasters
and callers request microphone permission. Camera viewers, voice listeners and
voice-inbox hosts do not need microphone capture. Share hosts and camera owners
approve their readers/viewers. Voice hosts can moderate callers; access links
and optional voice-inbox passwords are entered or shared in the window.

Live pairing uses `wss://rendezvous.abox.tools`. The service sees IP addresses,
connection timing, room identifiers and WebRTC negotiation metadata. Some modes
also send room labels, capability keys and derived password/access proofs needed
to authenticate pairing; a voice-inbox password is derived locally rather than
sent as raw text. Cloudflare keeps seven-day metadata logs.
Content is sent through encrypted direct WebRTC
connections between the selected peers; the companion offers no TURN relay,
public discovery or recording. It uses host candidates without STUN and can
require directly reachable devices, often on the same network. Host-candidate
filtering is not a guarantee that every connection stays on a private subnet.
The receiving person can retain or record what they receive independently.

The companion loads only bundled assets in its separate browser context and
permits the fixed pairing endpoints. Its loopback-looking address is fulfilled
inside that context; the adapter opens no HTTP listener or local file server.
Ordinary file-processing browser jobs keep their offline restrictions.

Pairing invitations, passwords, introductions, participant names, received text,
device labels, camera frames and voice are excluded from MCP results. The agent
receives a session identifier, tool/role, safe state, peer/capture counts, expiry,
and any selected output directory with saved-file counts and byte totals. A
supplied room label is used in the window and is not included in status results.

Share hosts may preload explicitly selected local text/files or choose them in
the window. Receiving text/files requires an explicit Save action and a new
output directory selected when opening the session. Saved names are generated
locally rather than taken from the peer: `text-<id>.txt` or `received-<id>.bin`.
Files are published exclusively without overwriting existing paths. Stop removes
unfinished receive files and retains completed saves. Saved files are plaintext
local files, and the original sender's copies are unaffected.

At most four companion windows can run in one adapter process. Sessions expire
after 30 minutes by default, configurable from one to 120 minutes. Closing the
window, stopping its session, expiry or adapter shutdown closes its peer/device
resources. The window's Stop control ends its connection while allowing a later
explicit restart; Close session or `abox_live_stop` also closes the window.
There is no automatic device permission grant or recording upload.

## The agent host and downloads

Your agent application receives tool arguments and results, including file
paths. Its handling of chat content, tool logs, retention, and cloud model calls
is governed by that application's settings and privacy policy. This plugin
cannot control content the user or agent independently shares with that host.

Downloading the plugin or a browser uses the download provider's network
service. GitHub hosts this repository and its release downloads. A directory or
agent application may separately check for updates. These setup activities are
separate from the adapter's local file processing.

The optional skills CLI is a separate distribution tool. Its default anonymous
installation telemetry helps skills.sh list skills; see its own privacy notice.
The included Python adapter installer downloads release archives and checksums
from GitHub and keeps a local integrity receipt. It uploads no user documents.

## Metadata removal

Metadata removal removes supported image metadata and checks the resulting
container. It retains orientation and ICC color profiles by default. Removing
metadata does not make visible content anonymous or guarantee that every image
format or application-specific field has been removed.

EXIF editing reads bounded explicit tag changes from a separate local JSON file.
Metadata values are excluded from the tool result and errors. Unchanged picture
bytes, other metadata and the thumbnail remain, so editing does not anonymize
the image. Rebuilding EXIF can affect undocumented maker-note offsets, and an
orientation edit can change how the unchanged picture displays.

Images-to-PDF keep mode may embed original JPEG streams, including their metadata.
Remove image metadata before creating the PDF when a clean document is required.

PDF compression can remove standard PDF metadata, while embedded image metadata,
attachments, annotations and visible content may remain. PDF watermarking adds
an image overlay and does not remove or protect the original content.

## Questions and support

Use the [project issue tracker](https://github.com/A-Box-of-Tools/abox-tools-plugin/issues)
for questions. Issues are public: describe the problem without attaching private
documents, photos, paths, or other sensitive information. The plugin's software
license and warranty terms are in [LICENSE](LICENSE).
