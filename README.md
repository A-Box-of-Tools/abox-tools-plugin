# abox.tools for agents

Compress images, split PDFs, and remove image metadata with the existing
[abox.tools](https://abox.tools/) code. An agent supplies local paths and receives
output paths and short JSON results. File bytes stay on your computer.

**[Download the latest release](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/latest).**
Listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.2.1)
as `io.github.A-Box-of-Tools/abox-tools`. New tagged releases update the Registry
automatically after their downloads pass verification.

Release bundles include Node.js, production dependencies, pinned processing
code, and the shared skill. You do not need to install Node or npm, or type setup
commands. Image compression still needs an installed Edge, Chrome, or Chromium;
PDF splitting and metadata removal do not.

## Install in Codex

Download the matching `.zip` from the release's **Assets**:

| Release label | Computer |
| --- | --- |
| `windows-x64` | Windows with an Intel or AMD 64-bit processor |
| `macos-arm64` | Mac with Apple silicon |
| `macos-x64` | Mac with an Intel processor |
| `linux-x64` | Linux with an Intel or AMD 64-bit processor |

1. Extract the entire ZIP to a permanent folder. For example, a 0.2.1 Windows
   bundle extracts as `abox-tools-0.2.1-windows-x64`. Keep this folder in place
   because the local marketplace uses it for plugin refresh.
2. Open `START-HERE.html` inside the extracted folder. This page works offline.
   Select **Install in Codex**, allow your browser to open the desktop app, then
   select **Install** on the plugin's detail page.
3. Start a new local chat and ask for one of the operations below.

You need the desktop app installed with its `codex://` link handler available.
The button opens the app's supported local-plugin detail link; the app handles
installation. See the [official OpenAI deep-link documentation](https://learn.chatgpt.com/docs/app/commands).
If your browser blocks the link, use `Install in Codex.cmd` on Windows or
`Install in Codex.command` on macOS. Linux includes `Install in Codex.sh` for
file managers that support executing shell scripts. These launchers open the
same detail page and may briefly show a terminal; no commands need to be typed.

## Install the tools in Claude Desktop

Download the `universal.mcpb` from the same release, open it with Claude Desktop,
and follow its installation prompts. One file supports Windows x64, Linux x64,
and both Apple silicon and Intel Macs. It includes the runtimes and processing
dependencies. Smaller platform-specific MCPBs are also available. This installs
the MCP tools; the shared agent skill is part of the Codex ZIP.

If opening the file does not show an installer, go to **Settings → Desktop app →
Manage** beside Extensions, then **Advanced settings → Install Extension…** and
select the `.mcpb`. See [Claude's desktop extension instructions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
Bundle format and MCP execution are checked in CI on all four platforms. The
0.2.1 universal bundle was installed and enabled in Claude Desktop on Windows,
where the app reported its local MCP server Running. The macOS desktop interface
has not been checked. Download and install a new bundle when updating; custom
MCPB files do not update automatically.

## Ask the agent

- “Compress this photo below 500 KB and save a new copy.”
- “Split this PDF into one file per page.”
- “Extract pages 1–3 and 4–6 as two PDFs.”
- “Remove location and other image metadata, keeping its orientation and colors.”

All input and output paths must be absolute. Existing outputs are never
overwritten. Image compression accepts an exact byte target; a result reports
whether the target was met.

| MCP tool | Required arguments | Useful options |
| --- | --- | --- |
| `abox_capabilities` | none | Lists formats, limits, and defaults. |
| `abox_image_compress` | `input_path`, `output_path`, `target_bytes` | `format`: `keep`, `auto`, `jpeg`, `png`, `webp`; `allow_resize` |
| `abox_pdf_split` | `input_path`, `output_dir` | `mode`: `each`, `every`, `ranges`; `pages_per_file`; `ranges`; `keep_bookmarks` |
| `abox_exif_remove` | `input_path`, `output_path` | `keep_orientation`; `keep_icc` |

## Use the CLI

The CLI provides the same operations without MCP. These commands use Node in a
source checkout. In a release bundle, replace `node` with `./runtime/node`, or
`.\runtime\node.exe` on Windows:

```sh
node bin/abox.mjs capabilities
node bin/abox.mjs doctor
node bin/abox.mjs compress-image --request-file /absolute/path/compress.json
node bin/abox.mjs split-pdf --request-file /absolute/path/split.json
node bin/abox.mjs remove-exif --request-file /absolute/path/metadata.json
```

A compression request file contains:

```json
{
  "input_path": "/absolute/path/photo.jpg",
  "output_path": "/absolute/path/photo-small.jpg",
  "target_bytes": 500000,
  "format": "keep",
  "allow_resize": true
}
```

A page-range request file contains:

```json
{
  "input_path": "/absolute/path/document.pdf",
  "output_dir": "/absolute/path/document-parts",
  "mode": "ranges",
  "ranges": ["1-3", "4-6"],
  "keep_bookmarks": true
}
```

An image metadata request file contains:

```json
{
  "input_path": "/absolute/path/photo.jpg",
  "output_path": "/absolute/path/photo-clean.jpg",
  "keep_orientation": true,
  "keep_icc": true
}
```

`--request '<JSON>'` is also supported, subject to your shell's quoting rules.
Request files avoid those differences. The CLI prints JSON summaries; it never
prints file contents.

## Limits and behavior

- Image compression: JPEG, PNG, and static WebP. Animated images are refused.
- Metadata removal: JPEG, PNG, and WebP containers, including their animation.
- PDFs: unencrypted input, up to 5,000 pages and 1,000 output files.
  Tool responses include at most 20 output entries. Larger splits also write a
  local `manifest.json` containing every output path and its source pages.
- Each input: at most 128 MiB.
- Compression: up to 80 megapixels and two minutes per image. `auto` may adjust
  the output extension to match the selected format. Other modes require the
  output extension to match the actual bytes, including an unchanged original.
- Compression may resize an image unless `allow_resize` is `false`. A file that
  already meets the target can pass through unchanged, retaining its metadata.
  Use metadata removal when that is part of the task.
- Metadata removal can retain animation in PNG and WebP because it edits their
  containers; compression refuses animation rather than flattening it.
- PDF splitting creates new PDFs. Document tags and metadata may be removed;
  digital signatures do not survive as valid signatures. Output page counts are
  verified. Bookmark preservation is enabled by default where supported.
- Metadata removal retains orientation and ICC profiles by default to preserve
  appearance. Set `keep_orientation` and `keep_icc` to `false` to remove those
  supported fields too; display orientation or colors may change. It does not
  establish that an image is anonymous.

Downloading a release or installing a browser uses the network. Processing files
through this adapter does not send their bytes over the network. The agent and
its host still receive paths, settings, summaries, and errors. The adapter needs
no account or API key.

See the [plugin privacy notice](PRIVACY.md) for the data handled by the adapter
and the separate responsibilities of the agent host.

The compressor detects common browser installations. Set `ABOX_BROWSER_PATH`
to an existing browser executable if needed. The browser's sandbox must work on
the host OS; Linux detection prefers installed stable Chrome over generic
Chromium builds. The plugin does not download a browser during processing.

## This plugin and the website's development MCP

This plugin runs file operations locally over MCP stdio. The separate website
catalogue at [mcp-dev.abox.tools/mcp](https://mcp-dev.abox.tools/mcp) exposes
`find_browser_tools`: it accepts a public search query, locale, and limit, then
returns tool links and an interactive catalogue. It accepts no files or filenames
and does not process files. Its source is the website's
[development catalogue worker](https://github.com/A-Box-of-Tools/website/tree/dev/workers/catalogue-mcp).

The `mcp-dev` endpoint is for development. This repository's release workflow
does not deploy the website or publish a production catalogue endpoint.
For directory submissions and MCP registration, see [Publishing](docs/publishing.md).

## Developer setup and other MCP hosts

Use the release bundle for installation without development tools. To develop
from a source checkout, install Node.js 22.15 or later, then run:

```sh
npm ci --ignore-scripts
npm test
npm run test:browser
npm run doctor
```

Source setup downloads npm dependencies. The source checkout's `mcp.json` uses
Node from the host; release packaging replaces it with the bundled executable.
A developer can add this repository marketplace with
`codex plugin marketplace add A-Box-of-Tools/abox-tools-plugin`, then install it
in the desktop app and run Setup in the installed copy. See the
[official OpenAI packaging guide](https://developers.openai.com/plugins/build/plugins).

For another host supporting local MCP stdio, point its configuration at the
extracted bundle's executable and server script using absolute paths:

```json
{
  "mcpServers": {
    "abox": {
      "command": "/absolute/path/to/bundle/runtime/node",
      "args": ["/absolute/path/to/bundle/bin/abox-mcp.mjs"]
    }
  }
}
```

On Windows, use `runtime/node.exe`. Escape backslashes in JSON or use forward
slashes. A source checkout can use `node` instead of the bundled executable.
Follow the host's own configuration format; do not replace unrelated settings.

## Maintain the reused code

To refresh the pinned website sources from a local website checkout:

```sh
npm run sync-upstream -- --source /absolute/path/to/etoolbox
```

Review the vendor diff and provenance, retain license notices, and run the checks
above. A `v*` tag starts `.github/workflows/release.yml`: it tests, builds all four
platform bundles, builds a universal MCPB, and checks extracted MCP execution on
all four platforms before publishing the GitHub Release. A successful tagged
release then publishes its verified metadata to the Official MCP Registry using
GitHub's short-lived identity token. Claude and OpenAI directory reviews remain
separate submissions; see [Publishing](docs/publishing.md).
