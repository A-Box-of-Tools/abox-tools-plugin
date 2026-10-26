---
name: abox-local-files
description: Compress, resize or convert images; create ICO icons; rasterize static SVGs; compress, watermark, merge, split, reorder or rotate PDFs; turn images into PDFs; inspect or remove image metadata; and calculate local file checksums with the abox.tools adapter.
---

# abox.tools local files

Use the installed abox.tools adapter. Pass absolute local paths; never read file
bytes into the conversation, encode them as base64, or upload them to a website.
The publisher is Abox Technologies.

If MCP and the CLI are absent, follow [local adapter installation](references/installation.md).
The self-contained skill includes a Python 3.9+ installer for a verified release;
it does not require cloning this repository, Node, or npm. Downloading setup files
uses the network; processing user files remains local. Do not install during a
file operation unless setup was requested or already authorized.

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
- `abox_exif_inspect`: `input_path`. Returns counts and presence of supported
  metadata, without private tag values. It does not modify the image.
- `abox_file_hash`: `input_path`, optional `algorithms` (unique choices from
  `md5`, `sha1`, `sha256`, `sha384`, `sha512`; default `["sha256"]`). Streams up
  to 8 GiB, including empty files. It returns digests without file contents.
- `abox_pdf_rotate`: `input_path`, `output_path`, `degrees` (90, 180 or 270
  clockwise), and optional `pages` (default `"all"`, or a selection such as
  `"1,3-5"`). Retains every page in its original order. Check `rotation_verified`.
- `abox_images_to_pdf`: ordered `input_paths` and `output_path`. The default is
  one image per A4 page, automatic orientation, contained within zero margins.
  Optional `page_size` (`fit`, `a3`, `a4`, `a5`, `letter`, `legal`, `tabloid`),
  `orientation`, `fit` (`contain`, `cover`, `stretch`), `margin_mm`, `dpi`,
  `image_mode` (`keep`, `jpeg`, `lossless`), `quality`, `max_side`, `background`.
  Keep mode can embed original JPEG bytes and their metadata. Use metadata
  removal first when the user requests a clean document. Check output page count.
- `abox_pdf_compress`: `input_path`, `output_path`; optional `preset` (`smallest`,
  `screen`, `print`, `gentle`; default `screen`), `dpi` (0 to 1200; 0 keeps the
  source resolution), `quality` (0.30 to 0.95), and `strip_metadata` (default
  `true`). Recompresses supported PDF images and rewrites the document. This is
  lossy for changed images and does not search for a byte target. Check `smaller`,
  `saved_bytes`, `images_changed` and warnings. The output can be larger. Page
  operators and geometry are verified; visual equivalence is not established.
- `abox_pdf_watermark`: `input_path`, `output_path`, one-line `text` (1 to 200
  characters). Optional `size` (`small`, `medium`, `large`), `color` (`grey`,
  `red`, `blue`), `opacity` (0.05 to 1), `diagonal` (default `true`), `tiled`
  (default `false`), and `first_page_only` (default `false`). Uses local fonts to
  draw a rasterized stamp. Check `stamps_verified` and `stamped_page_count`.
  A watermark can be removed in editors and does not redact or protect content.
- `abox_image_to_ico`: `input_path`, `output_path`; optional unique `sizes` from
  16, 20, 24, 32, 40, 48, 64, 96, 128, 256 (default `[16,32,48,256]`),
  `fit` (`pad`, `crop`, `stretch`), `storage` (`auto`, `png`, `bmp`) and
  `background` (six-digit hex color or `null` for transparency). Creates one ICO
  containing the selected sizes and verifies every entry.
- `abox_svg_to_image`: `input_path`, `output_path`; optional `format` (`png`,
  `jpeg`, `webp`; default `png`), `width`, `height`, `fit` (`fit`, `pad`,
  `stretch`), `quality` (0 to 1), and `background` (hex or `null`). Omitted
  dimensions use the SVG's intrinsic size; one dimension preserves the ratio.
  Accepts a static, self-contained subset; active content, external resources,
  CSS imports/escapes, foreign objects and animations are refused. JPEG uses a
  white background unless another color is requested. Fonts can affect rendering.

## Limits and privacy

Compression, resizing and conversion support JPEG, PNG, and static WebP. Metadata removal edits JPEG,
PNG, and WebP containers without flattening animation. PDFs must be unencrypted.
Each input is limited to 128 MiB, except streaming checksums (8 GiB). Images to
PDF accepts at most 128 MiB of combined inputs. PDFs are limited to 5,000 pages and 1,000 split output
files. Image processing, PDF compression and PDF watermark rendering need a locally installed Edge, Chrome, or Chromium;
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
`merge-pdf`, `select-pdf-pages`, `rotate-pdf`, `images-to-pdf`, `inspect-exif`,
`remove-exif`, `hash-file`, `compress-pdf`, `watermark-pdf`, `image-to-ico`, and
`svg-to-image`. Quote paths that contain
spaces. `<node-executable> <plugin-root>/bin/abox.mjs capabilities` lists support;
`<node-executable> <plugin-root>/bin/abox.mjs doctor` checks local setup. The CLI returns JSON
summaries rather than file bytes. Do not install dependencies during an operation
without an explicit request; follow the repository setup instructions when setup
is needed.
