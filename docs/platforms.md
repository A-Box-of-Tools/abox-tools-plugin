# Platform support and publishing

Publisher: **Abox Technologies**. Product: **abox.tools**.

The [v0.10.0 release](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/tag/v0.10.0)
is public with 26 assets and 66 local file operations plus capabilities. All four
native builds, universal assembly, four universal launch checks, publication and
Registry registration passed. The exact active/latest Registry record matches
the public universal MCPB hash. The default Python installer downloaded and
verified the public Windows ZIP in an isolated cache; that actual cache passed
all 66 file operations and 67 MCP tools using bundled Node.js 24.22.1, with no
capability absences, relocation and launch without system Node. No local archive
or rebuild supplied the proof. Public Gemini CLI installation and the skill's
14-file project installation also passed; the latter checked the installer
contract offline without installing an adapter offline. See the
[v0.10.0 publication evidence](publishing.md#v0100-publication-evidence).

Historically, the [v0.9.0 release](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/tag/v0.9.0)
was published with 26 assets and 55 local file operations and one
capabilities tool. Native packages and the universal MCPB passed checks on all
four platforms, including packaged Gemini installation and standalone skill
setup. Source verification passed on Ubuntu and Windows. Directory status is
recorded separately below. See the v0.9.0
[release workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578848781)
and [source verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578847970).

| Client | Installation route | Runtime requirements |
| --- | --- | --- |
| Codex desktop | Extract the matching native `abox-tools-0.10.0-<platform>-<arch>.zip`, open `START-HERE.html`, and select **Install in Codex**. | The adapter's Node runtime and dependencies are included. Keep the extracted folder. |
| Claude Desktop / MCPB hosts | Open `abox-tools-0.10.0-universal.mcpb` in the host's extension installer. | The MCPB includes Windows x64, Linux x64, and both macOS runtimes. Host application support and installation approval still apply. |
| Cursor | Use the native ZIP's **Install tools in Cursor** button for the local MCP tools. The repository also carries a Cursor plugin and shared skill. | The native link uses the included runtime. A source plugin needs Node.js 22.15+ on PATH and one-time adapter setup. See [Cursor setup](cursor.md). |
| VS Code | Use the native ZIP's **Install tools in VS Code** button, included from version 0.6.0. | VS Code with its URL handler must be installed. The link selects the bundled runtime and absolute server path; keep the extracted folder. |
| Gemini CLI | Install the release extension through Gemini CLI; platform-specific archives have a root `gemini-extension.json`. | Gemini CLI must already be installed. The extension includes the adapter's Node runtime and dependencies. |
| Agents supported by skills.sh | Install `abox-local-files` from this repository, then run its one-time adapter setup. | The current skills CLI needs Node.js 22.20+. Adapter setup uses Python 3 and downloads a verified native ZIP; later file processing uses the cached bundled runtime. |

Image rendering/conversion, GIF creation/extraction, decoded audio, document
scans, local previews, receipt OCR, DICOM rendering, PDF raster redaction and
video decoding/encoding need an installed
Edge, Chrome or Chromium browser. New MP4 encoding also needs a supported native
H.264 encoder; it downloads no encoder or model during processing.
QR codes and barcodes default to
SVG without a browser; their PNG output uses the installed local browser.
PDF page/security operations, hashes, metadata operations, text processing,
audio/video packet copying, DICOM/GIF inspection and password generation use the local
adapter directly. All routes use the same processing engines and refuse
existing output paths.

## Gemini CLI

Install the released extension with:

```sh
gemini extensions install https://github.com/A-Box-of-Tools/abox-tools-plugin --ref v0.10.0
```

The release includes these Gemini-specific assets:

| Target | Asset |
| --- | --- |
| Windows x64 | `win32.x64.abox-tools.zip` |
| Linux x64 | `linux.x64.abox-tools.zip` |
| macOS Apple silicon | `darwin.arm64.abox-tools.zip` |
| macOS Intel | `darwin.x64.abox-tools.zip` |

These archives put `gemini-extension.json` at the archive root and select the
included native runtime through `${extensionPath}`. The source repository's
manifest is for development; a plain clone does not contain the bundled
runtime or installed server dependencies.

The public repository has the root manifest and `gemini-cli-extension` topic
required for Google's daily gallery crawler. A gallery listing is unconfirmed.
On 28 October 2026, Gemini CLI 0.65.0 installed the actual public repository at
`--ref v0.10.0` and reported version 0.10.0. All 67 tools, shared skill discovery,
bundled runtime selection and a local file operation passed.

Historically, the v0.9.0 extracted release archives passed packaged Gemini installation checks in
CI on all four platforms. The public GitHub-release installation check for
v0.9.0 passed on Windows on 27 October 2026 using Gemini CLI 0.65.0 and
`--ref v0.9.0`: 56 MCP tools, shared skill discovery, bundled runtime and a local
file operation. Historically, v0.8.0 passed using Gemini CLI 0.65.0 on Windows
with 32 MCP tools, bundled runtime selection, shared skill discovery and a local
file operation. See the official [release and gallery requirements](https://geminicli.com/docs/extensions/releasing/).

## Shared skill and skills.sh

The installation recipe is available:

```sh
npx skills add A-Box-of-Tools/abox-tools-plugin --skill abox-local-files
```

Choose the target agent when prompted. Then ask that agent to set up
`abox-local-files` before processing a file. Setup downloads the pinned native
adapter, verifies its checksum, and records a full file inventory under
`~/.abox-tools/adapters/<version>/<platform>-<arch>/`. The launcher verifies
that inventory before use. It performs no installation or download during a
file operation.

The [skills CLI](https://github.com/vercel-labs/skills#install-a-skill) documents
its Node.js 22.20+ requirement. Installation telemetry drives the
[skills.sh directory](https://www.skills.sh/docs/faq). The
[abox-local-files listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
was verified public on 25 October 2026, displaying Abox Technologies and the
standalone setup guide. Installation counts and rankings update separately.
Public skills CLI 1.7.4 installed version 0.10.0's 14 skill files from
`A-Box-of-Tools/abox-tools-plugin` into an isolated project/home on
28 October 2026, using the CLI defaults. The installer contract was checked
offline without installing an adapter offline. Actual adapter installation is
proved separately: the default Python installer downloaded and verified the
public Windows ZIP, then all 66 operations and 67 MCP tools passed against its
isolated cache using bundled Node.js 24.22.1, without capability absences or a
local rebuild. All four native and all four universal CI summaries also reported
67 tools without capability absences; exact runtime versions are recorded in
[Publishing](publishing.md#v0100-publication-evidence).

Historically, version 0.9.0's copied skill contains ten files. Packaged offline setup passed in
CI on all four platforms; the Linux log confirms skills CLI 1.7.4 and ten copied
files. Public skills CLI 1.7.4 also installed the v0.9.0 skill's ten files from
`A-Box-of-Tools/abox-tools-plugin` into an isolated project/home on
27 October 2026, using the CLI defaults. Its offline check validated the
standalone installer's contract without installing an adapter offline.
Separately, the default Python installer
downloaded and verified the actual v0.9.0 Windows ZIP in an isolated cache.
All 55 operations and 56 MCP tools passed against that downloaded bundle using
Node.js 24.22.1, including all 24 new routes without encoder absences,
relocation, installation links and launch without system Node. No local rebuild
supplied that evidence.

Historically, public skills CLI 1.7.4 installed the v0.8.0 skill's six files and passed
its offline installer checks on 27 October 2026 in an isolated directory.
The default Python installer downloaded and verified the public v0.8.0 Windows
ZIP on 27 October 2026 in an isolated cache. The installed bundle then passed
all 31 operations and exposed all 32 MCP tools using bundled Node.js 24.22.1.
Relocation and installation-link checks used that same downloaded bundle,
without a local rebuild or changes to the user's agent settings.

Historical v0.7.0 checks also covered public Gemini installation and the skill's
actual adapter download on Windows. The v0.8.0 and v0.9.0 receipts remain separate
from current v0.10.0 publication and installation verification.

## Publication status and other clients

The Cursor Marketplace application was submitted on 26 October 2026 for
Abox Technologies with the accepted `abox-tools` handle. Cursor acknowledged
receipt; review is pending and no live Marketplace listing is confirmed. The
source Cursor manifest, offline cache launcher and native installation link passed
protocol checks. Installation through Cursor's own interface remains unverified.

Gemini is installable from its public release; a gallery listing is unconfirmed.
The skills.sh listing is public.
See [directory submission materials](directory-submissions.md) and
[publishing](publishing.md) for the release and submission evidence recorded
for other destinations.

VS Code's native-bundle installation link is validated by URI decoding and a
real MCP connection using its extracted configuration. Desktop installation
through VS Code's own interface remains unverified; no VSIX or Marketplace
submission is needed for this route. Glama already indexes the public repository.
See [additional distribution routes](distribution-options.md) for Smithery,
AgentSkillsDir, SkillsMP, ClawHub and other current options and limitations.
On 27 October 2026, an authorized AgentSkillsDir submission attempt was blocked
because resource submissions were closed; no submission was accepted. Smithery remains
a follow-up for the publisher.

The website's development catalogue endpoint is a separate service. These
local-file packages do not deploy or publish that endpoint.
