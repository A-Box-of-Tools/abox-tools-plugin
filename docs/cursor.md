# Use abox.tools in Cursor

The public v0.10.0 release implements 66 file operations plus capabilities.
All native/universal platform checks and public Registry registration passed.
The default Python installer downloaded and verified its public Windows ZIP.
That actual cache passed all 66 operations and 67 MCP tools with bundled
Node.js 24.22.1, no capability absences, relocation and launch without system
Node; no local archive or rebuild supplied the proof. Public Gemini installation
and skills CLI 1.7.4 copying of the 14-file shared skill also passed in isolated
profiles. The skill-only offline check validates its installer contract and does
not replace the separate actual adapter download above. Link/MCP verification does
not establish installation through Cursor's desktop interface. See
[publication evidence](publishing.md#v0100-publication-evidence).

The v0.10.0 release includes a native ZIP for Windows x64, Linux x64,
macOS Apple silicon and macOS Intel. Download
the ZIP matching your computer, extract it to a permanent folder, and open
`START-HERE.html`. Select **Install tools in Cursor** and review Cursor's
installation prompt. The link
configures the Node runtime and MCP server inside that extracted folder. Keep
the folder in place. Node.js, npm, Python and a source build are not required
for this route. The adapter exposes 66 local file operations and one capabilities
tool. Image rendering/conversion, GIF creation/extraction, decoded audio, receipt
OCR, document scans, previews, PDF raster redaction and video decoding/encoding
need an installed Edge, Chrome or
Chromium. MP4 encoding also needs its native H.264 encoder. PDF security, video
packet copying, text, metadata, inspection and password generation need no
browser. QR/barcodes default to SVG without one; PNG output uses the browser.

Historically, version 0.9.0 native and universal package checks passed on all four targets.
The default Python installer then downloaded and verified the public Windows
ZIP in an isolated cache; that actual bundle passed all 55 operations/56 MCP
tools, relocation, installation links and launch without system Node using its
Node.js 24.22.1 runtime. No local rebuild was used. Historically, v0.8.0
installation links and MCP configuration were checked
after downloading and installing the public Windows ZIP in an isolated cache.
The same bundle passed all 31 file operations with its included runtime.
Installation through Cursor's desktop interface remains unverified.

The Git repository also contains a Cursor plugin manifest at
`.cursor-plugin/plugin.json`. It explicitly selects `cursor-mcp.json`; the
root `mcp.json` remains the Codex configuration. Cursor's plugin root variable
is `${CURSOR_PLUGIN_ROOT}`. Cursor does not expand `${PLUGIN_ROOT}`.

A source or Marketplace install requires Node.js 22.15 or newer on PATH. No
built-in Cursor Node runtime is assumed. Run the shared `abox-local-files`
setup skill once to install the adapter for this plugin version. That setup
uses Python 3 and the standard library, downloads the matching published
native ZIP, and verifies its release checksum. A new plugin version needs its
matching adapter version.

To install the skill separately, use
`npx skills add A-Box-of-Tools/abox-tools-plugin --skill abox-local-files`
and select Cursor. The current skills CLI requires Node.js 22.20 or newer;
its installation requirement is separate from the adapter's runtime minimum.
The skill's first adapter setup needs Python 3 and network access to the
published GitHub release. Processing local files after setup stays local.

The source launcher verifies the installed file inventory and hashes before
starting the cached bundled runtime. Missing or changed files produce a setup
error. It performs no downloads while tools process files. The default cache
is `~/.abox-tools/adapters/<version>/<platform>-<arch>/`. An explicit absolute
`--adapter-root` is available for a deliberately configured installation.

Installing the MCP link adds the file tools. Installing the Cursor plugin also
provides the shared workflow skills. Marketplace review and installation in
Cursor are separate from protocol tests; follow the status in
`directory-submissions.md` for publication details.

The Cursor Marketplace application was submitted on 26 October 2026, with
**Abox Technologies** as the organization and **abox-tools** as the accepted
handle. Cursor acknowledged receipt; review is pending. A live Marketplace
listing has not been confirmed.

Cursor documents [plugin components and root variables](https://cursor.com/docs/reference/plugins),
[local MCP commands](https://cursor.com/docs/mcp), and
[MCP install links](https://cursor.com/docs/mcp/install-links).
The [skills CLI installation reference](https://github.com/vercel-labs/skills#install-a-skill)
documents its own Node.js prerequisite.
