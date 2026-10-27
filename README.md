# abox.tools for agents

Published by **Abox Technologies**. Compress, resize and convert images; create
ICO icons, rasterize SVGs and compose image layouts; compress, watermark, merge,
split, reorder and rotate PDF pages; extract PDF tables to CSV; turn images into
PDFs; format JSON; encode or decode Base64 files; inspect or remove
image metadata; and calculate file checksums with the existing
[abox.tools](https://abox.tools/) code. An agent supplies local paths and receives
output paths and short JSON results. File bytes stay on your computer.

**[Download the latest release](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/latest).**
Listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.6.0)
as `io.github.A-Box-of-Tools/abox-tools`. New tagged releases update the Registry
automatically after their downloads pass verification.

Release bundles include Node.js, production dependencies, pinned processing
code, and the shared skill. You do not need to install Node or npm, or type setup
commands. Image processing, PDF compression and PDF watermark rendering need an
installed Edge, Chrome, or Chromium. PDF page operations, metadata operations and
checksums, PDF table extraction, JSON and Base64 do not.

## Install in Codex

Download the matching `.zip` from the release's **Assets**:

| Release label | Computer |
| --- | --- |
| `windows-x64` | Windows with an Intel or AMD 64-bit processor |
| `macos-arm64` | Mac with Apple silicon |
| `macos-x64` | Mac with an Intel processor |
| `linux-x64` | Linux with an Intel or AMD 64-bit processor |

1. Extract the entire ZIP to a permanent folder. For example, a 0.6.0 Windows
   bundle extracts as `abox-tools-0.6.0-windows-x64`. Keep this folder in place
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

Version 0.3.0 corrects the publisher to Abox Technologies. If your desktop host
shows both the earlier publisher entry and the new one, disable the older entry
to avoid duplicate tools.

## Install in Gemini CLI

With Gemini CLI installed, run:

```sh
gemini extensions install https://github.com/A-Box-of-Tools/abox-tools-plugin
```

Gemini selects the matching prebuilt archive from the latest GitHub Release.
The extension includes its runtime, dependencies and shared skill. Review the
installation prompt and allow its local MCP server. See the
[Gemini extension release guide](https://geminicli.com/docs/extensions/releasing/).

## Install tools in Cursor

Extract the matching native ZIP, open `START-HERE.html`, and select **Install
tools in Cursor**. Cursor shows the local server configuration before adding it.
Keep the extracted folder in place. This adds the MCP tools; the shared skill
can be installed separately. The repository's Cursor plugin route needs Node
and a one-time adapter setup; see [Cursor installation](docs/cursor.md).

## Install tools in VS Code

Extract the matching native ZIP, open `START-HERE.html`, and select **Install
tools in VS Code**. Review the local server configuration in VS Code and keep
the extracted folder in place. The button uses the bundled runtime; Node, npm
and a VSIX are not required. This installs MCP tools. Install the shared skill
separately if your agent supports it. See the
[official MCP installation-link documentation](https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url).

## Install the shared skill through skills.sh

For agents supported by the skills CLI (Node 22.20+):

```sh
npx skills add A-Box-of-Tools/abox-tools-plugin --skill abox-local-files
```

Then ask the agent to set up the abox.tools local adapter. The skill includes
a Python 3.9+ setup script that downloads the matching packaged release, verifies
its checksum and installs the bundled runtime. It does not require cloning or
building this project. See [standalone setup](skills/abox-local-files/references/installation.md).
The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is public. Gemini release installation is verified; a gallery listing is unconfirmed.

## Ask the agent

- “Compress this photo below 500 KB and save a new copy.”
- “Resize this photo to fit within 1200 by 800 pixels.”
- “Convert this PNG to WebP.”
- “Merge these PDFs in this order.”
- “Split this PDF into one file per page.”
- “Extract pages 1–3 and 4–6 as two PDFs.”
- “Make one PDF containing pages 3, 1–2, and another copy of page 3.”
- “Rotate pages 2–4 clockwise by 90 degrees.”
- “Put these photos into one PDF, in this order.”
- “Check whether this image contains EXIF or XMP metadata.”
- “Remove location and other image metadata, keeping its orientation and colors.”
- “Calculate SHA-256 checksums for these files.”
- “Compress this scanned PDF for screen reading.”
- “Add a diagonal DRAFT watermark to every PDF page.”
- “Make an ICO with 16, 32, 48 and 256 pixel versions of this logo.”
- “Export this SVG as a transparent PNG, 1200 pixels wide.”
- “Arrange these photos into a two-column grid with transparent gaps.”
- “Extract the tables on pages 2–4 into a CSV I can review.”
- “Format this JSON without changing large numbers or key order.”
- “Decode this Base64 file into a new binary file.”

All input and output paths must be absolute. Existing outputs are never
overwritten. Image compression accepts an exact byte target; a result reports
whether the target was met.

| MCP tool | Required arguments | Useful options |
| --- | --- | --- |
| `abox_capabilities` | none | Lists formats, limits, and defaults. |
| `abox_image_compress` | `input_path`, `output_path`, `target_bytes` | `format`: `keep`, `auto`, `jpeg`, `png`, `webp`; `allow_resize` |
| `abox_image_resize` | `input_path`, `output_path`, `width` and/or `height` | `fit`: `contain` or `cover`; `allow_upscale`: false; `format`, `quality`, `background` |
| `abox_image_convert` | `input_path`, `output_path`, `format` | `jpeg`, `png`, or `webp`; `quality` from 0 to 1; JPEG `background` |
| `abox_pdf_split` | `input_path`, `output_dir` | `mode`: `each`, `every`, `ranges`; `pages_per_file`; `ranges`; `keep_bookmarks` |
| `abox_pdf_merge` | `input_paths`, `output_path` | 2–32 PDFs in input order; `keep_bookmarks` |
| `abox_pdf_select` | `input_path`, `output_path`, `pages` | Ordered terms such as `3,1-2,3`; `keep_bookmarks` |
| `abox_pdf_rotate` | `input_path`, `output_path`, `degrees` | Clockwise 90, 180, or 270; `pages` defaults to `all`; retains every page |
| `abox_images_to_pdf` | `input_paths`, `output_path` | One image per page; `page_size`, `orientation`, `fit`, `margin_mm`, `dpi`, `image_mode`, `quality`, `max_side`, `background` |
| `abox_exif_inspect` | `input_path` | Read-only metadata inventory; does not return private tag values |
| `abox_exif_remove` | `input_path`, `output_path` | `keep_orientation`; `keep_icc` |
| `abox_file_hash` | `input_path` | `algorithms`: MD5, SHA-1, SHA-256 (default), SHA-384, SHA-512 |
| `abox_pdf_compress` | `input_path`, `output_path` | `preset`: `smallest`, `screen`, `print`, `gentle`; optional `dpi`, `quality`, `strip_metadata` |
| `abox_pdf_watermark` | `input_path`, `output_path`, `text` | `size`, `color`, `opacity`, `diagonal`, `tiled`, `first_page_only` |
| `abox_image_to_ico` | `input_path`, `output_path` | `sizes`, `fit`: `pad`, `crop`, `stretch`; `storage`: `auto`, `png`, `bmp`; optional `background` |
| `abox_svg_to_image` | `input_path`, `output_path` | `format`: `png`, `jpeg`, `webp`; `width`, `height`, `fit`, `quality`, `background` |
| `abox_image_layout` | ordered `input_paths`, `output_path` | `layout`: `grid`, `horizontal`, `vertical`; `width`, grid `columns`, `ratio`, `gap`, `padding`, `fit`, `format`, `quality`, `background` |
| `abox_pdf_to_csv` | `input_path`, `output_path` | `pages`, `table_index`, `date_order`: `auto`, `dmy`, `mdy`; `include_headers`, `spreadsheet_safe` |
| `abox_json_format` | `input_path`, `output_path` | `minify`, `indent`: `2`, `4`, `tab`; `sort_keys` (opt-in natural sorting) |
| `abox_base64` | `input_path`, `output_path`, `mode` | `encode` or `decode`; `url_safe`; decoding `canonical` |

## Use the CLI

The CLI provides the same operations without MCP. These commands use Node in a
source checkout. In a release bundle, replace `node` with `./runtime/node`, or
`.\runtime\node.exe` on Windows:

```sh
node bin/abox.mjs capabilities
node bin/abox.mjs doctor
node bin/abox.mjs compress-image --request-file /absolute/path/compress.json
node bin/abox.mjs resize-image --request-file /absolute/path/resize.json
node bin/abox.mjs convert-image --request-file /absolute/path/convert.json
node bin/abox.mjs split-pdf --request-file /absolute/path/split.json
node bin/abox.mjs merge-pdf --request-file /absolute/path/merge.json
node bin/abox.mjs select-pdf-pages --request-file /absolute/path/select.json
node bin/abox.mjs rotate-pdf --request-file /absolute/path/rotate.json
node bin/abox.mjs images-to-pdf --request-file /absolute/path/photos.json
node bin/abox.mjs inspect-exif --request-file /absolute/path/inspect.json
node bin/abox.mjs remove-exif --request-file /absolute/path/metadata.json
node bin/abox.mjs hash-file --request-file /absolute/path/hash.json
node bin/abox.mjs compress-pdf --request-file /absolute/path/compress-pdf.json
node bin/abox.mjs watermark-pdf --request-file /absolute/path/watermark.json
node bin/abox.mjs image-to-ico --request-file /absolute/path/icon.json
node bin/abox.mjs svg-to-image --request-file /absolute/path/svg.json
node bin/abox.mjs image-layout --request-file /absolute/path/layout.json
node bin/abox.mjs pdf-to-csv --request-file /absolute/path/tables.json
node bin/abox.mjs format-json --request-file /absolute/path/format.json
node bin/abox.mjs base64 --request-file /absolute/path/base64.json
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

- Image compression, resizing and conversion: JPEG, PNG, and static WebP.
  Animated images are refused. Resizing fits the full image (`contain`) or crops
  centrally (`cover`); upscaling is disabled by default. Re-encoding can change
  colors and removes source metadata. A no-op resize preserves original bytes.
- Metadata removal: JPEG, PNG, and WebP containers, including their animation.
- PDFs: unencrypted input, up to 5,000 pages and 1,000 output files.
  Merging accepts 2–32 PDFs, at most 128 MiB combined. Page selection preserves
  the order and repetition of comma-separated terms. Ranges expand ascending:
  `3,1-2,3` produces 3,1,2,3; use explicit terms for reverse order.
  Merging PDFs with colliding interactive form field names is currently
  unsupported by the source engine and fails before creating an output.
  Tool responses include at most 20 output entries. Larger splits also write a
  local `manifest.json` containing every output path and its source pages.
- Images to PDF: still JPEG, PNG or WebP, one image per page, up to 128 MiB
  combined and 80 megapixels per image. Defaults to A4, automatic orientation,
  contain, no margins. `keep` can embed original JPEG streams with their metadata;
  remove metadata first when a clean document is required. `lossless` preserves
  decoded image pixels; `jpeg` re-encodes using the requested quality.
- Checksums: read-only, streaming, supports empty files and up to 8 GiB.
- PDF compression: presets recompress supported images and rewrite structure.
  `smallest` uses 96 DPI / 0.55 quality, `screen` 130 / 0.68, `print` 220 / 0.82,
  and `gentle` keeps resolution with 0.90 quality. `dpi` and `quality` can override
  those settings. It does not search for a byte target; check `smaller` and actual
  savings. The output can be larger. Changed images can lose detail. CMYK and
  unsupported image encodings are retained where safely readable. Unusual
  filter-wrapped JPEG encodings and nonidentity EXIF orientation in JPEG streams
  are refused before processing to prevent unintended image rotation. Standard PDF
  metadata is removed by default; embedded images, attachments and visible
  content can still contain personal information.
- PDF watermarks: one rasterized line, up to 200 characters, centered or tiled,
  on all pages or only the first. Local fonts affect appearance. Up to 100,000
  stamps. Watermarks can be removed by editors and do not redact or protect data.
- ICO: still JPEG, PNG or WebP to one file with up to ten sizes from 16 to 256
  pixels. `auto` stores sizes up to 64 as DIB and larger sizes as PNG. Padding
  preserves aspect ratio and transparency; crop fills the square; stretch can
  distort. The directory, frame dimensions and rendered pixels are verified.
- SVG: uncompressed, self-contained static SVG to PNG, JPEG or WebP; up to
  16,384 pixels per side and 80 megapixels. Active content, foreign objects,
  external references, CSS imports/escapes and animations are refused. JPEG
  fills transparency with white by default. Fonts and colors can vary by browser.
- Image layouts: 2–32 still JPEG, PNG or WebP images, at most 128 MiB combined
  and 80 megapixels per input. Output is at most 8192 pixels per side and 32
  megapixels. Grids default to two square columns; horizontal/vertical strips
  preserve original aspect ratios. Contain retains the full image; cover crops.
  New pixels are rendered in 8-bit SDR and source metadata is not copied.
- PDF to CSV: selectable text only, no OCR. Tables, headings, dates and amounts
  are inferred and can be incomplete or wrong; review the CSV against the PDF.
  UTF-8 BOM, comma delimiter, CRLF lines. Multiple tables have a blank separator
  row. Year-bearing dates and inferred amounts are normalized; auto date order
  falls back to day-first when ambiguous. Formula-like text is escaped with an
  apostrophe by default. Up to 1000 tables, 64 columns per table, 100000 data
  rows, one million cells/glyphs and 16 MiB of output. Structural verification
  does not establish extraction accuracy.
- PDF table extraction currently accepts unfiltered and Flate streams without
  predictors. It conservatively refuses legacy LZW/RunLength, ASCII-armoured
  streams and predictors, even in unused images or xrefs. Blocked PDF names in
  printed text can also cause refusal. Stream expansion is limited to 16 MiB
  per Flate stream and 64 MiB cumulatively before buffering decoded data.
- JSON: UTF-8 input up to 8 MiB, nesting up to 256 levels, output up to 32 MiB.
  Preserves raw number and string tokens, duplicate keys and object key order.
  Sorting is opt-in. Both pretty and minified output end with a newline. The
  parser accepts at most 250000 syntax nodes, including object keys.
- Base64: arbitrary binary files, including empty files; input up to 8 MiB,
  output up to 32 MiB. Standard encoding is padded; URL-safe encoding is unpadded.
  Relaxed decoding accepts whitespace, missing padding and either alphabet.
  Canonical validation requires the exact requested spelling and zero unused
  bits. Encoded/decoded bytes are written locally and never returned to the agent.
- Each other input: at most 128 MiB.
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
For Gemini CLI, Vercel skills.sh, Cursor and other distribution options, see
[Platform support and publishing](docs/platforms.md).
For additional directories, local distribution and their account or licensing
requirements, see [Other sharing platforms](docs/distribution-options.md).

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
