# GIF, image and password settings

Use these operations through the same MCP adapter or CLI fallback. All paths
must be absolute and local. Sources are preserved and outputs must be new.

## GIF inspection and extraction

`abox_gif_inspect` / `inspect-gif`: `input_path`, optional `frame_offset`
(zero-based, default 0) and `frame_limit` (1–100, default 20). Follow
`next_frame_offset` while `frames_truncated` is true. This reads headers,
rectangles, palette counts, disposal, stored and browser-style played timings.
It does not decode LZW or verify pixels: `verified` is false by design. A
complete container is not proof that its compressed frames are valid. Comments,
application identifiers and palette colors are excluded from results.

`abox_gif_split` / `split-gif`: `input_path`, `output_dir`, optional `mode`
(`composited` or `stored`, default `composited`) and `frames` (unique 1-based
integers, at most 200). Composited frames include preceding patches and disposal;
stored frames contain only their own patch, size and offset. No scaling. PNG
frames are exported in ascending source order, regardless of selection order.
For GIFs with more than 200 frames, choose a subset explicitly. Output
pixels are verified after encoding. Unsupported or damaged input fails before
retaining outputs. The new directory includes `timing.json`; tool responses
preview at most 20 outputs. Disposal 2 clears to transparency, following the
website compositor's browser-style policy rather than the GIF background color.

Limits: 32 MiB input, 1000 source frames, 8192 per side, 32 megapixels per screen
or patch, 128 Mi decoded patch pixels, 300 million walked screen pixels,
32 MiB per PNG and 256 MiB of PNG outputs. The upstream working-buffer admission
also applies. These are bounded admission policies, not a process memory cap.
PNG extraction needs the installed browser; inspection does not.

## Bitmap tracing

`abox_image_trace` / `trace-image`: `input_path`, `.svg` `output_path`;
`threshold` (`otsu` default or integer 0–255), `invert` (false), `detail`
(`auto` default or 0.1–10 curve tolerance), `corner_angle` (0–180 degrees,
default 65), `min_area` (integer 0–10000, default 2) and six-digit hex `fill`
(default black). Accepts still JPEG, PNG or WebP. Pixels with alpha below 128
are background before inversion; `invert:true` also inverts that background.

Produces one passive SVG path, verified by structure and rendered path pixels.
This is a lossy single-color interpretation, not photo conversion; colors,
gradients, fine detail and source metadata are not preserved. Limits: 4096 per
side, 4 megapixels, 100000 boundary edges, 1000 contours and 400000 SVG bytes.
Needs the installed browser. Review the threshold and chosen subject visually.

## Image stacking

`abox_image_stack` / `stack-images`: `input_paths` (2–8), `output_path`;
`method` (`average` default, `median`, `sigma`, `lighten`, `darken`, `add`),
`format` (`png` default or `jpeg`), `quality` (0–1, default .92), sigma-only
`kappa` (0.1–10, default 2) and add-only `gain` (0.1–16, default 1).

Still JPEG, PNG and WebP inputs must be opaque and have equal decoded sizes,
at most 4096 per side and 4 megapixels; combined files at most 128 MiB. Frames
are combined in their existing positions without alignment, rescaling, RAW
development or focus stacking. Uses encoded 8-bit SDR RGB values rather than
linear light. Independent sample arithmetic is checked; PNG pixels round-trip
exactly, while JPEG verification covers format, dimensions and opacity. Source
metadata is not copied. Needs the installed browser.

## Solid image redaction

`abox_image_redact` / `redact-image`: `input_path`, `.png` `output_path`,
`regions_path`. The latter is UTF-8 JSON (at most 64 KiB) with this shape:

```json
{"image_width":1200,"image_height":800,"regions":[{"x":40,"y":60,"width":200,"height":80}]}
```

Dimensions must match the decoded display image, including EXIF orientation.
Coordinates are zero-based whole pixels. Every rectangle must fit completely;
there is no clipping, rounding or scaling. 1–100 rectangles, 16384 per side,
32 megapixels and 128 million rectangle pixels including overlaps. Accepts
still JPEG, PNG or WebP, writes flattened PNG with fixed opaque black fills,
and checks every decoded output pixel. Redacted pixels must be exactly opaque
black; outside pixels retain alpha exactly and visible colors within one 8-bit
step of the decoded source. The new raster is 8-bit SDR, so source color and
precision can change. Source metadata is not copied. No blur,
pixelation, OCR or sensitive-content detection. Only selected regions are hidden;
verify coverage visually before sharing. Needs the installed browser.

Save the configuration above as `/absolute/path/regions.json`, using dimensions
and rectangles supplied by the user for the full-resolution display image. The
MCP arguments or CLI request file then contain paths only:

```json
{"input_path":"/absolute/path/image.png","output_path":"/absolute/path/image-redacted.png","regions_path":"/absolute/path/regions.json"}
```

Do not guess positions from a thumbnail. Ask for a regions file or exact pixel
coordinates when they are unavailable, and ask the user to review the saved PNG.

## Passwords and passphrases

`abox_password_generate` / `generate-passwords`: `.txt` `output_path`;
optional `config_path` (UTF-8 JSON, at most 16 KiB). Defaults are one password,
24 characters, lowercase/uppercase/digits/symbols, at least one of each class.
Secrets use the website's `crypto.getRandomValues` generation and are written
one per line with a final newline. The tool returns counts, settings and
verification without secrets, hashes or samples. The file is plaintext, not a
password vault; do not read it into chat.

Password configuration fields: `mode:"password"`, `count` (1–100), `length`
(8–128), booleans `lowercase`, `uppercase`, `digits`, `symbols`,
`avoid_lookalikes` (false) and `require_each` (true); `symbol_set` (`full`
default or `safe`). At least one class is required. Options are validated;
unknown or duplicate fields fail.

Passphrase configuration fields: `mode:"passphrase"`, `count` (1–100),
`words` (4–12, default 6), `wordlist` (`long` default or `short`), `separator`
(`hyphen` default, `space`, `dot`, `underscore`, `none`, `digit`),
`capitalization` (`lower` default, `title`, `upper`), `add_digit` (false) and
`add_symbol` (false). Uses bundled EFF words with replacement. Do not claim a
cracking time or infer strength from appearance. Output at most 64 KiB. No browser.

For two six-word passphrases, save a separate local configuration file such as
`/absolute/path/passphrase-settings.json`:

```json
{"mode":"passphrase","count":2,"words":6}
```

Then call the tool with:

```json
{"output_path":"/absolute/path/passphrases.txt","config_path":"/absolute/path/passphrase-settings.json"}
```

The returned path and count are enough to report completion. Never open the
generated file to confirm its contents, create a checksum, or show a sample.
