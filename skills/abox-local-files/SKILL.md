---
name: abox-local-files
description: Compress, resize or convert local images; merge, split, extract or reorder local PDF pages; and remove EXIF or image metadata with the abox.tools local adapter. Use for these operations on existing JPEG, PNG, WebP or PDF files.
---

# abox.tools local files

Use the installed abox.tools adapter. Pass absolute local paths; never read file
bytes into the conversation, encode them as base64, or upload them to a website.
The publisher is Abox Technologies.

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
- `abox_image_resize`: `input_path`, `output_path`, and `width`, `height`, or
  both. `fit: "contain"` keeps the entire image within the box; `"cover"` crops
  centrally. `allow_upscale` defaults to `false`, so the actual output can be
  smaller than the requested box. `format` defaults to `keep`; JPEG, PNG and
  WebP are also available. Re-encoding can remove metadata. A no-op can preserve
  the original bytes and metadata; check `untouched`, `width` and `height`.
- `abox_image_convert`: `input_path`, `output_path`, and `format` (`jpeg`, `png`
  or `webp`). `quality` is between 0 and 1 and defaults to 0.92. JPEG fills
  transparency with `background` (six-digit hexadecimal color, default white).
  Conversion re-encodes, may change colors, and does not copy source metadata.
- `abox_pdf_split`: `input_path`, `output_dir`, optional `mode` (`each`, `every`,
  `ranges`; default `each`), optional `pages_per_file`, optional `ranges`, and
  optional `keep_bookmarks` (default `true`). `every` uses `pages_per_file`;
  `ranges` uses an array such as `["1-3", "4-6"]`. Splitting creates new PDFs and
  can remove document tags and metadata and invalidate digital signatures.
  Large splits return the first 20 outputs and a complete local `manifest_path`;
  link the output directory and manifest instead of listing every file.
- `abox_pdf_merge`: `input_paths` (2 to 32 PDFs in output order), `output_path`,
  and optional `keep_bookmarks` (default `true`). The combined inputs must fit
  within 128 MiB and 5,000 pages. Check `page_count` and verification.
- `abox_pdf_select`: `input_path`, `output_path`, `pages`, and optional
  `keep_bookmarks`. Comma-separated terms retain order and duplicates:
  `"3,1-2,3"` produces source pages 3, 1, 2, 3. Each range expands ascending,
  even when its endpoints are descending. Use explicit terms for a reverse
  sequence. The `page_order` result is a preview of at most 100 entries.
- `abox_exif_remove`: `input_path`, `output_path`, optional `keep_orientation`
  (default `true`), and optional `keep_icc` (default `true`). These defaults retain
  orientation and color profile information to preserve appearance. Set both to
  `false` when the user explicitly requests removal of all supported metadata.
  Explain that removing them can change display orientation or colors.

## Limits and privacy

Compression, resizing and conversion support JPEG, PNG, and static WebP. Metadata removal edits JPEG,
PNG, and WebP containers without flattening animation. PDFs must be unencrypted.
Each input is limited to 128 MiB. PDFs are limited to 5,000 pages and 1,000 output
files. Image operations except metadata removal need a locally installed Edge, Chrome, or Chromium;
`ABOX_BROWSER_PATH` can select its executable.

The adapter processes file bytes locally without outbound network requests.
The agent still receives paths, settings, and result summaries. Metadata removal
is limited to supported metadata types and is not a promise of anonymization.

## CLI fallback

If MCP is unavailable, use the same adapter through the local CLI. Resolve
`<plugin-root>` to this installed plugin's root, and write the operation's JSON
request to a local file. Release packages include `runtime/node.exe` on Windows
and `runtime/node` on macOS or Linux; use that executable without installing
Node or npm. For a source checkout, use its installed `node`. Run:

```text
<node-executable> <plugin-root>/bin/abox.mjs <operation> --request-file <absolute-request-path>
```

Operations are `compress-image`, `resize-image`, `convert-image`, `split-pdf`,
`merge-pdf`, `select-pdf-pages`, and `remove-exif`. Quote paths that contain
spaces. `<node-executable> <plugin-root>/bin/abox.mjs capabilities` lists support;
`<node-executable> <plugin-root>/bin/abox.mjs doctor` checks local setup. The CLI returns JSON
summaries rather than file bytes. Do not install dependencies during an operation
without an explicit request; follow the repository setup instructions when setup
is needed.
