---
name: abox-local-files
description: Compress local images, split local PDFs, and remove EXIF or image metadata with the abox.tools local adapter. Use when a user asks for these operations on existing JPEG, PNG, WebP, or PDF files.
---

# abox.tools local files

Use the installed abox.tools adapter. Pass absolute local paths; never read file
bytes into the conversation, encode them as base64, or upload them to a website.

## Workflow

1. Resolve input paths and the user's requested result. Call `abox_capabilities`
   only when support or settings are unclear.
2. Choose new output paths. Sources are preserved, and existing outputs cause an
   error. For PDF splitting, choose a new output directory.
3. Call the appropriate operation below. Use defaults unless the user requested
   different settings. Ask only when a required input or page selection cannot be
   determined from the request.
4. Check the returned verification and any warnings. Report the achieved result,
   including a missed size target or any partial result.
5. Return clickable links to output files and a short size, page, or metadata
   summary. Do not claim a result that the adapter did not verify.

## Operations

- `abox_image_compress`: `input_path`, `output_path`, positive integer
  `target_bytes`, optional `format` (`keep`, `auto`, `jpeg`, `png`, `webp`; default
  `keep`), and optional `allow_resize` (default `true`). Honor an explicit request
  to preserve dimensions by setting `allow_resize` to `false`. Compression can
  return the original bytes when the input already meets the target; metadata
  removal requires `abox_exif_remove`.
  Check `fitted` before claiming the target was met. `auto` may change the output
  filename extension; link the returned `output_path`.
- `abox_pdf_split`: `input_path`, `output_dir`, optional `mode` (`each`, `every`,
  `ranges`; default `each`), optional `pages_per_file`, optional `ranges`, and
  optional `keep_bookmarks` (default `true`). `every` uses `pages_per_file`;
  `ranges` uses an array such as `["1-3", "4-6"]`. Splitting creates new PDFs and
  can remove document tags and metadata and invalidate digital signatures.
  Large splits return the first 20 outputs and a complete local `manifest_path`;
  link the output directory and manifest instead of listing every file.
- `abox_exif_remove`: `input_path`, `output_path`, optional `keep_orientation`
  (default `true`), and optional `keep_icc` (default `true`). These defaults retain
  orientation and color profile information to preserve appearance. Set both to
  `false` when the user explicitly requests removal of all supported metadata.
  Explain that removing them can change display orientation or colors.

## Limits and privacy

Compression supports JPEG, PNG, and static WebP. Metadata removal edits JPEG,
PNG, and WebP containers without flattening animation. PDFs must be unencrypted.
Each input is limited to 128 MiB. PDFs are limited to 5,000 pages and 1,000 output
files. Image compression needs a locally installed Edge, Chrome, or Chromium;
`ABOX_BROWSER_PATH` can select its executable.

The adapter processes file bytes locally without outbound network requests.
The agent still receives paths, settings, and result summaries. Metadata removal
is limited to supported metadata types and is not a promise of anonymization.

## CLI fallback

If MCP is unavailable, use the same adapter through the local CLI. Resolve
`<plugin-root>` to this installed plugin's root, and write the operation's JSON
request to a local file. Run:

```text
node <plugin-root>/bin/abox.mjs <compress-image|split-pdf|remove-exif> --request-file <absolute-request-path>
```

Use one operation name, not the bracketed alternatives. Quote paths that contain
spaces. `node <plugin-root>/bin/abox.mjs capabilities` lists support;
`node <plugin-root>/bin/abox.mjs doctor` checks local setup. The CLI returns JSON
summaries rather than file bytes. Do not install dependencies during an operation
without an explicit request; follow the repository setup instructions when setup
is needed.
