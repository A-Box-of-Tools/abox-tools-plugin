# Platform support and publishing

Publisher: **Abox Technologies**. Product: **abox.tools**.

The [v0.5.0 release](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/tag/v0.5.0)
is public with 26 assets. All fifteen operations, Gemini installation and
standalone skill setup passed CI on all four platforms. Directory status is
recorded separately below.

| Client | Installation route | Runtime requirements |
| --- | --- | --- |
| Codex desktop | Extract the matching native `abox-tools-0.5.0-<platform>-<arch>.zip`, open `START-HERE.html`, and select **Install in Codex**. | The adapter's Node runtime and dependencies are included. Keep the extracted folder. |
| Claude Desktop / MCPB hosts | Open `abox-tools-0.5.0-universal.mcpb` in the host's extension installer. | The MCPB includes Windows x64, Linux x64, and both macOS runtimes. Host application support and installation approval still apply. |
| Cursor | Use the native ZIP's **Install tools in Cursor** button for the local MCP tools. The repository also carries a Cursor plugin and shared skill. | The native link uses the included runtime. A source plugin needs Node.js 22.15+ on PATH and one-time adapter setup. See [Cursor setup](cursor.md). |
| VS Code | From version 0.6.0, use the native ZIP's **Install tools in VS Code** button. | VS Code with its URL handler must be installed. The link selects the bundled runtime and absolute server path; keep the extracted folder. |
| Gemini CLI | Install the release extension through Gemini CLI; platform-specific archives have a root `gemini-extension.json`. | Gemini CLI must already be installed. The extension includes the adapter's Node runtime and dependencies. |
| Agents supported by skills.sh | Install `abox-local-files` from this repository, then run its one-time adapter setup. | The current skills CLI needs Node.js 22.20+. Adapter setup uses Python 3 and downloads a verified native ZIP; later file processing uses the cached bundled runtime. |

Image processing, PDF compression and PDF watermark rendering need an
installed Edge, Chrome or Chromium browser. PDF page operations, hashes and
metadata removal, PDF table extraction, JSON and Base64 use the local adapter directly. All routes use the same
processing engines and refuse existing output paths.

## Gemini CLI

Install the released extension with:

```sh
gemini extensions install https://github.com/A-Box-of-Tools/abox-tools-plugin --ref v0.5.0
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
required for Google's daily gallery crawler. A gallery listing is unconfirmed. The exact
public install command above passed using Gemini CLI 0.65.0 on Windows,
including bundled runtime selection, shared skill discovery and a local file
operation. See the official [release and gallery requirements](https://geminicli.com/docs/extensions/releasing/).

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

The website's development catalogue endpoint is a separate service. These
local-file packages do not deploy or publish that endpoint.
