# abox.tools local plugin

Give an agent three existing [abox.tools](https://abox.tools/) operations through
a shared skill and a local MCP adapter: image compression, PDF splitting, and
image metadata removal. The adapter reuses the website's JavaScript and returns
output paths and JSON summaries. File bytes stay on your computer.

This is the first version. It is a separate project from the website; its vendored
source is pinned so a website change cannot silently change an installed plugin.

## Set up

Install Node.js 22.15 or later. For image compression, install Microsoft Edge,
Google Chrome, or Chromium. The adapter detects common installations; set
`ABOX_BROWSER_PATH` to an executable path if detection fails. It uses
`playwright-core` and does not download a browser.
The browser's sandbox must work on the host OS. On Linux, detection prefers an
installed stable Chrome before generic Chromium builds for that reason.

From this repository's root:

```sh
npm ci --ignore-scripts
npm test
npm run test:browser
npm run doctor
```

Setup downloads npm dependencies. Processing uses local files and requires no
outbound network access. The adapter has no account, API key, or hosted service.

## Install in an agent

This repository includes a portable `plugin.json`, `mcp.json`, a shared skill,
and a repository marketplace at `.agents/plugins/marketplace.json`. Add this
checkout as a local marketplace in a compatible agent host and install
`abox-tools`. Follow that host's plugin installation instructions. No public
repository or plugin directory listing is required for a local checkout.

For Codex marketplace discovery, run `codex plugin marketplace add` with the
absolute path to this checkout. Then install `abox-tools` from that marketplace
in the desktop app and run its Setup action. For a shared GitHub checkout, use
`codex plugin marketplace add A-Box-of-Tools/abox-tools-plugin` once you have
access to that repository. Plugin setup installs dependencies in the installed
copy, rather than relying on another checkout's node_modules.

The MCP configuration uses `${PLUGIN_ROOT}` to find the installed adapter, so it
does not depend on the user's current working directory. The host must support
that expansion and a local executor. Run `npm ci` in the installed plugin root if
the host copied the source to a new location without installing dependencies.

For a host that accepts standard MCP configuration but does not expand
`${PLUGIN_ROOT}`, register the server with your own absolute checkout path:

```json
{
  "mcpServers": {
    "abox": {
      "command": "node",
      "args": ["/absolute/path/to/abox-tools-plugin/bin/abox-mcp.mjs"],
      "cwd": "/absolute/path/to/abox-tools-plugin"
    }
  }
}
```

Use native absolute paths on Windows and escape backslashes in JSON, or use
forward slashes. If the host cannot find `node`, use its absolute executable
path. The skill can also be installed separately with this adapter registered.

Public plugin-directory submission is a separate step. Local MCP support in
ChatGPT desktop plugins currently has an approved-partner eligibility boundary;
a repository marketplace is the initial distribution route. See the official
[desktop plugin guidance](https://developers.openai.com/plugins/deploy/desktop-only).

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

The CLI provides the same operations without MCP:

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

The local adapter does not send file bytes over the network. The agent and its
host still see file paths, settings, summaries, and errors passed through MCP.

## Maintain the reused code

To refresh the pinned website sources from a local website checkout:

```sh
npm run sync-upstream -- --source /absolute/path/to/etoolbox
```

Review the vendor diff and upstream provenance, then run `npm test`,
`npm run test:browser`, and `npm run doctor`. Keep upstream license notices with the copied modules. The
adapter should call those implementations rather than duplicate their processing
logic.
