# Platform support and publishing

Publisher: **Abox Technologies**. Product: **abox.tools**.

The v0.4.0 source prepares client configurations and release assets for the
routes below. Use a release command only after the matching GitHub release
and its assets are public. Prepared packaging does not establish a directory
listing or an approved submission.

| Client | Prepared installation route | Runtime requirements |
| --- | --- | --- |
| Codex desktop | Extract the matching native `abox-tools-0.4.0-<platform>-<arch>.zip`, open `START-HERE.html`, and select **Install in Codex**. | The adapter's Node runtime and dependencies are included. Keep the extracted folder. |
| Claude Desktop / MCPB hosts | Open `abox-tools-0.4.0-universal.mcpb` in the host's extension installer. | The MCPB includes Windows x64, Linux x64, and both macOS runtimes. Host application support and installation approval still apply. |
| Cursor | Use the native ZIP's **Install tools in Cursor** button for the local MCP tools. The repository also carries a Cursor plugin and shared skill. | The native link uses the included runtime. A source plugin needs Node.js 22.15+ on PATH and one-time adapter setup. See [Cursor setup](cursor.md). |
| Gemini CLI | Install the release extension through Gemini CLI; platform-specific archives have a root `gemini-extension.json`. | Gemini CLI must already be installed. The extension includes the adapter's Node runtime and dependencies. |
| Agents supported by skills.sh | Install `abox-local-files` from this repository, then run its one-time adapter setup. | The current skills CLI needs Node.js 22.20+. Adapter setup uses Python 3 and downloads a verified native ZIP; later file processing uses the cached bundled runtime. |

Image compression, resizing, conversion and images-to-PDF workflows need an
installed Edge, Chrome or Chromium browser. PDF page operations, hashes and
metadata removal use the local adapter directly. All routes use the same
processing engines and refuse existing output paths.

## Gemini CLI

After the v0.4.0 release is public, install the prepared extension with:

```sh
gemini extensions install https://github.com/A-Box-of-Tools/abox-tools-plugin --ref v0.4.0
```

The release prepares these Gemini-specific assets:

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

Gallery eligibility is prepared for the public release. A public repository
with a root manifest and the `gemini-cli-extension` topic is eligible for
Google's daily crawler and validation. A confirmed gallery entry must be
checked separately. See the official [release and gallery requirements](https://geminicli.com/docs/extensions/releasing/).

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
[skills.sh directory](https://www.skills.sh/docs/faq); publishing this recipe
does not by itself confirm a leaderboard entry.

## Publication status and other clients

The Cursor Marketplace application has not been submitted. Its Google sign-in
flow is waiting for the user's explicit identity-sharing approval. The source
Cursor manifest and native install link are prepared for validation and review.

Gemini gallery eligibility and the skills.sh installation recipe are prepared.
See [directory submission materials](directory-submissions.md) and
[publishing](publishing.md) for the release and submission evidence recorded
for other destinations.

VS Code and Copilot can connect local stdio servers, but this repository does
not yet provide a separately validated VS Code Marketplace package. Glama
indexing and other directories also need their own publication checks.

The website's development catalogue endpoint is a separate service. These
local-file packages do not deploy or publish that endpoint.
