# Core local file operations

Use the installed abox.tools adapter. Pass absolute local paths; never read file
bytes into the conversation or upload them to a website. Base64 operations write
local files; never put their encoded or decoded contents into the conversation.
The publisher is Abox Technologies.

QR and barcode payloads come from local UTF-8 files. Pass those paths directly;
do not read secrets into the conversation, echo completed digits, or add or trim
a final newline. Data URIs and unified patches also stay in local output files.
Generated passwords and passphrases stay in a new local plaintext file; never
read, quote, hash or preview those secrets in the conversation.

If MCP and the CLI are absent, follow [local adapter installation](installation.md).
The self-contained skill includes a Python 3.9+ installer for a verified release;
it does not require cloning this repository, Node, or npm. Downloading setup files
uses the network; processing user files remains local. Do not install during a
file operation unless setup was requested or already authorized.

## Workflow

1. Resolve input paths and the user's requested result. Call `abox_capabilities`
   only when support or settings are unclear.
2. Choose new output paths. Sources are preserved, and existing outputs cause an
   error. For PDF or GIF splitting, choose a new output directory.
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
- `abox_image_layout`: ordered `input_paths` (2 to 32), `output_path`; optional
  `layout` (`grid`, `horizontal`, `vertical`; default `grid`), `width` (default
  1600), grid-only `columns` (default 2), `ratio` (`square`, `landscape`,
  `portrait`, or strip-only `original`), `gap` and `padding` (default 16), `fit`
  (`contain` or `cover`), `format`, `quality`, and `background` (hex or `null`).
  Grid cells default to square; strips preserve original ratios. Output is at
  most 8192 pixels per side and 32 megapixels. Check actual width and height.
- `abox_pdf_to_csv`: `input_path`, `output_path` ending in `.csv`; optional
  `pages` (`all` or a selection such as `1,3-5`), `table_index` (1-based),
  `date_order` (`auto`, `dmy`, `mdy`), `include_headers` and `spreadsheet_safe`
  (both default `true`). Exports inferred tables from selectable text; no OCR.
  All-table export inserts a blank row between tables. Dates with years and
  inferred amounts may be normalized. Ambiguous auto dates use day-first;
  choose the date order when known. Check warnings, table/row counts and balance
  diagnostics. `verified` covers CSV structure, not extraction accuracy.
  Tell the user to review the CSV against the source. Keep formula protection
  enabled unless the user specifically requests raw spreadsheet text.
  This first version conservatively refuses predictors, ASCII armours and
  legacy LZW/RunLength filters, including in unused images/xrefs. Printed blocked
  PDF names can also cause refusal. It limits Flate expansion to 16 MiB per
  stream and 64 MiB overall; report refusals without claiming the PDF is invalid.
- `abox_json_format`: `input_path`, `.json` `output_path`; optional `minify`
  (default `false`), `indent` (`2`, `4`, `tab`; default `2`), and `sort_keys`
  (default `false`). Preserves numeric tokens, duplicate keys, string escapes
  and object key order. Sorting is opt-in; output ends with a newline. At most
  250000 syntax nodes, including keys.
- `abox_base64`: `input_path`, `output_path`, `mode` (`encode` or `decode`);
  optional `url_safe` (default `false`) and decoding `canonical` (default
  `false`). Standard encoding is padded; URL-safe encoding is unpadded. Relaxed
  decoding accepts whitespace, missing padding and either alphabet; canonical
  validation requires the selected exact spelling. Handles arbitrary binary
  and empty files. Return the output link and byte counts, never file contents.
- `abox_image_data_uri`: `input_path`, `output_path`; optional `shape` (`uri`,
  `css-rule`, `css-var`, `html`, `markdown`; default `uri`), `svg_encoding`
  (`auto` or `base64`), and simple CSS `identifier` up to 64 characters.
  Extensions are `.txt`, `.css`, `.css`, `.html`, `.md`, respectively. Original
  bytes and metadata are preserved. Auto uses readable percent encoding only
  for exact UTF-8 SVG in a standalone URI; SVG embedding envelopes use Base64
  to avoid HTML/CSS/Markdown escaping changes. Signature-based MIME recognition
  does not prove validity or rendering; SVG markup is not sanitized. Use metadata
  removal first only when the user requests it. Link the file, never its URI.
- `abox_yaml_json`: `input_path`, `output_path`, `direction` (`yaml-to-json` or
  `json-to-yaml`); optional `indent` (`2` or `4`, default `2`) and YAML-to-JSON
  `sort_keys` (default `false`). Output must end in `.json` or `.yaml`/`.yml`
  for the selected direction. This supports a YAML subset: no anchors, aliases,
  custom tags or multiple documents. Values, duplicate keys and large number
  tokens are retained, while comments, formatting and string escape spelling
  can change. Do not describe it as a lossless text conversion.
  The source printer refuses root multiline scalars and some four-space lists
  of mappings when verification fails. Prefer default indent `2`; if an explicit
  four-space request fails, explain the limitation before changing that setting.
- `abox_xml_format`: `input_path`, `.xml` `output_path`; optional `minify`
  (default `false`) and `indent` (`2`, `4`, `tab`; default `2`). UTF-8 only.
  DTDs and custom entities are refused; no external references are fetched.
  Normal predefined entities and valid numeric references remain supported.
  Check verification and warnings about insignificant whitespace, mixed content,
  `xml:space`, comments and CDATA rather than promising byte-identical markup.
- `abox_qr_generate`: UTF-8 payload `input_path`, `output_path`; optional
  `format` (`svg` default, or `png`), `level` (`L`, `M`, `Q`, `H`; default `M`),
  `quiet` (4–32 modules, default 4), `scale` (1–32, default 4), `foreground`
  (default black) and `background` (default white), both six-digit hex colors.
  Reads the exact payload file, including any final newline. No hosted redirect
  or QR service is involved. SVG needs no browser; PNG uses the local browser.
  Check verification and scan warnings; do not return the encoded payload.
- `abox_barcode_generate`: UTF-8 payload `input_path`, `output_path`; optional
  `symbology` (`code128` default, `ean13`, `upca`, `ean8`, `itf14`, `itf`,
  `code39`), `format` (`svg` default or `png`), `scale` (1–32), `height`
  (16–4096, default 100), `text` (labels, default `true`), `code39_check`
  (default `false`, Code 39 only), and hex colors. Inputs are not trimmed;
  a newline can make a numeric payload invalid. Retail check digits are computed
  or validated, and Code 39 can uppercase text. Check `check_digit_added`,
  `text_normalized`, verification and warnings without echoing digits. Reader
  verification capacity can reject otherwise encodable long barcodes. Test the
  saved code with its intended scanner; verification is not a print guarantee.
- `abox_text_diff`: `left_path`, `right_path`, `.diff` or `.patch` `output_path`;
  optional `context_lines` (0–100, default 3), `ignore_whitespace`, `ignore_case`
  and `ignore_blank_lines` (all default `false`). The saved unified patch always
  compares the original text and line endings. Ignore settings affect only
  `comparison_stats`; primary counts retain raw content and ending differences.
  Check `patch_application_verified`, `ending_changes`, and
  `coarse_rewrite_detected`. The bounded engine does not guarantee a minimal
  edit script. The patch uses fixed `a`/`b` headers and is not applied to inputs.

For these operations, read [GIF, tracing, stacking, redaction and password settings](additional-tools.md)
only when needed:

- `abox_gif_inspect`: `input_path`; optional zero-based `frame_offset` and
  `frame_limit` (1–100, default 20). Reports headers and timings without decoding
  LZW pixels. Check `container_complete`, `verification` and pagination.
- `abox_gif_split`: `input_path`, new `output_dir`; optional `mode`
  (`composited` default or `stored`) and unique 1-based `frames`. Selected frames
  are exported in ascending source order. Link the returned `manifest_path`
  for the complete timing and output list.
- `abox_image_trace`: `input_path`, new `.svg` `output_path`; optional
  threshold, detail, inversion, minimum area and fill. Produces a single-color
  approximation for logos and line art; inspect the SVG before relying on it.
- `abox_image_stack`: ordered `input_paths` (2–8), `output_path`; optional
  `method` and `format`. Inputs must already align, have equal dimensions and
  be opaque. This version performs no alignment or RAW decoding.
- `abox_image_redact`: `input_path`, new PNG `output_path`, `regions_path`
  pointing to local JSON with expected decoded dimensions and integer rectangles.
  Use user-provided coordinates and dimensions or an existing local regions file.
  Ask when these are missing; do not guess from a scaled preview or read private
  image pixels into the conversation. The tool does not detect sensitive content.
  Tell the user to review the saved image before sharing it.
- `abox_password_generate`: new `.txt` `output_path`; optional `config_path`
  to local JSON. Defaults to one random 24-character password. Passphrase mode
  defaults to six words. Put passphrase settings in that separate configuration
  file, rather than adding them to the MCP request. Return the output link and
  count without viewing secrets.

## Limits and privacy

Compression, resizing and conversion support JPEG, PNG, and static WebP. Metadata removal edits JPEG,
PNG, and WebP containers without flattening animation. The page operations in this
reference require unencrypted PDFs; [protect/unlock](media-and-documents.md#pdf-passwords)
handle the supported password-protected subset.
Each input is limited to 128 MiB, except streaming checksums (8 GiB), JSON,
Base64 and data URIs (8 MiB), YAML/XML (2 MiB), QR payloads (4 KiB) and barcode
payloads (256 bytes). JSON output is at most 32 MiB and 256 nesting levels. Images to
PDF and image layouts accept at most 128 MiB of combined inputs. PDFs are limited to 5,000 pages and 1,000 split output
files. Image processing, PDF compression and PDF watermark rendering need a locally installed Edge, Chrome, or Chromium;
`ABOX_BROWSER_PATH` can select its executable.
PDF-to-CSV output is limited to 16 MiB, 1000 tables, 64 columns per table,
100000 data rows and one million cells/glyphs; it performs no OCR.
YAML/XML output is limited to 16 MiB, 128 nesting levels and 100000 syntax nodes.
Data URI output is at most 32 MiB. Text diff inputs total at most 4 MiB and
20000 lines, with at most 8 MiB of patch output. Code output is at most 8192 per
side, 32 megapixels and 16 MiB; payload capacity can be lower than the input cap.
Barcode verification allows at most 400 alternating runs and plain ITF 4–40
digits. QR/barcode SVG output requires no browser; PNG output requires one.

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
`svg-to-image`, `image-layout`, `pdf-to-csv`, `format-json`, `base64`,
`image-to-data-uri`, `convert-yaml-json`, `format-xml`, `generate-qr`,
`generate-barcode`, `diff-text`, `inspect-gif`, `split-gif`, `trace-image`,
`stack-images`, `redact-image`, and `generate-passwords`. Quote paths that contain
spaces. `<node-executable> <plugin-root>/bin/abox.mjs capabilities` lists support;
`<node-executable> <plugin-root>/bin/abox.mjs doctor` checks local setup. The CLI returns JSON
summaries rather than file bytes. Do not install dependencies during an operation
without an explicit request; follow the repository setup instructions when setup
is needed.
