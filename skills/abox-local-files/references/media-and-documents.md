# Media, document and local-report operations

Use absolute local paths and new output files/directories. Inputs remain intact.
Configuration examples describe structure, not measurements to reuse blindly.
Read private payloads, passwords and image coordinates from their existing local
files rather than copying them into the conversation. Call `abox_capabilities`
for the installed adapter's exact limits and availability.

## Read a code or create a GIF

`abox_code_read` / `read-code-image`: `input_path`, `.json` `output_path`,
optional `thorough` (default `true`). Reads one QR or supported linear barcode
from a still JPEG/PNG/WebP. The local report contains decoded text; the tool
result only contains found/symbology/geometry and verification. Never open a
decoded URL or display a Wi-Fi password automatically. A `found:false` report
does not prove there is no code. Input: 32 MiB, 4096 pixels per side, 4 MP;
report: 64 KiB.

`abox_gif_create` / `create-gif`: ordered `input_paths` (1–32 still images),
`.gif` `output_path`; optional `delay_ms` (default 500) or one `delays_ms` entry
per image (20–60000 ms), `max_side` (default 480, 16–1000) or both `width` and
`height` (16–1000), `fit` (`contain` default, `cover`, `stretch`), `background`
(six-digit hex, white default), `colors` (4–256, default 256), `dither` (true),
`shared_palette` (false), `transparent` (false), `loop` (`forever` default,
`once`, `count`) and `loop_count` (1–65535, required only for count mode).
Do not supply `max_side` with explicit dimensions. Each input becomes one full
frame in order. Palette colors, one-bit transparency, resizing and centisecond
timing can change appearance. Inputs total 128 MiB; input frames are at most
4096 pixels per side/4 MP, rendered frames 16 MP combined, output 32 MiB.
Both operations need a local browser.

## PDF passwords

`abox_pdf_protect` / `protect-pdf`: `input_path`, `.pdf` `output_path`;
optional `open_password_file`, `owner_password_file`, `revision` (6 default,
AES-256; or 4, AES-128), `restrict_print`, `restrict_copy`, `restrict_change`
(all false). Supply at least a usable password as required by the adapter. The
input must be unencrypted or open with a blank password. If no owner password is
supplied, the source engine uses the open password as owner password.

`abox_pdf_unlock` / `unlock-pdf`: `input_path`, `.pdf` `output_path`;
optional `password_file` (omitted means blank password) and `remove_metadata`
(default true). Standard password security handlers only; no password guessing,
certificate decryption or arbitrary unsupported encryption variants.

Password arguments are paths to UTF-8 files of at most 1024 bytes. The exact text
is used, including a BOM, spaces and final newline; do not trim, normalize,
preview or put the password itself into a tool request. Generate a suitable
secret into a local file if authorized; a generator's final newline is part of
that file and therefore part of the PDF password. Keep it separately and use the
same exact file to unlock.

These routes admit 32 MiB input, 64 MiB output and 500 pages, with bounded worker
structure and Flate expansion. Unsupported legacy structural filters and
predictors can cause a conservative refusal. Reopening verifies page count,
reachable objects, raw streams and requested security settings. Permission
restrictions are advisory; compatible viewers may ignore them. Rewriting
invalidates signatures and discards previous incremental revisions. Metadata
removal covers supported standard fields, not all embedded or visible content.
These routes need no browser and do not redact PDF content.

## Audio and video

`abox_audio_edit` / `edit-audio`: WAV `input_path`, `.wav` `output_path`;
optional `reverse` (false), `speed` (0.25–4, default 1), `keep_pitch` (true),
`volume_mode` (`gain` default or `normalize`), gain-only `gain_db` (-60–24,
default 0), normalize-only `normalize_db` (-60–0, default -1), and `bits` (16
default or 32). Effects follow source order: reverse, speed/pitch, level. Check
clipping and warnings; pitch preservation does not promise transparent sound.

`abox_audio_trim` / `trim-audio`: `input_path`, `.wav` `output_path`,
`ranges:[{"start":0,"end":1}]` in seconds; optional `mode` (`keep` default
or `cut`), `fade_ms` (0–50, default 5), `bits` (16 default or 32). Every range
must fit inside the source and retain samples after rounding. Keep mode preserves
the supplied order, overlaps and duplicates. Cut mode merges ranges and emits
the ascending complement; the source omits leftover gaps of at most 1 ms. Set
`fade_ms:0` when no fade is wanted.

Both audio routes require a local browser and admit only simple little-endian
PCM16 or Float32 RIFF WAV, mono/stereo, 8–96 kHz, at most 600 seconds,
12 million frames, 24 million channel-samples and 64 MiB input. Output is at
most 128 MiB. Metadata and
unsupported WAV layouts are refused; compressed audio and video-audio extraction
are unavailable. Every encoded output sample is checked; input samples remain
local. PCM16 encoding quantizes/clips and native input decoding can differ by
one Float32 rounding step across platforms.

`abox_video_inspect` / `inspect-video`: `input_path`. Inspects MP4/M4V/MOV
containers, tracks, timing and sample tables without decoding or returning
packets/metadata text. It does not prove the compressed media can play.

`abox_video_trim` / `trim-video`: `input_path`, `.mp4` `output_path`,
`ranges:[{"start":0,"end":2}]`; optional `keep_audio` (true) and
`allow_preroll` (false). The first non-keyframe cut needs explicit preroll
permission; later sections must start on keyframes. Hidden boundary packets can
remain under output edit lists. Do not describe trimming as erasure/redaction.

`abox_video_join` / `join-videos`: ordered `input_paths` (2–8), `.mp4`
`output_path`, optional `keep_audio` (true). Codec descriptions, dimensions,
orientation and requested audio must match. Re-encoding is not performed.

These three routes require no browser, admit 64 MiB input (combined for joins),
100000 samples and 6 hours; trim has at most 20 ranges and output at most 128 MiB.
Incoming nonidentity edit lists are refused. Packet and timeline verification
establishes the stated copy behavior, not playback or content safety.

`abox_video_rotate` / `rotate-video`: `input_path`, `.mp4` `output_path`;
optional `degrees` (90 default, 180 or 270 clockwise), `keep_audio` (true).
Reuses the source's no-decode `copyPicture` path and changes the display matrix;
encoded video pixels are not rotated or re-encoded. Supported MP4/M4V/MOV only;
audio must be copyable AAC or explicitly omitted. Complex orientations and
incoming edited timelines are refused. Requires no browser/native codec.
Check the returned matrix, display size and packet verification. Players must
honor the matrix; this is not baked pixel rotation or a playback guarantee.

`abox_video_remux` / `remux-video`: `input_path`, `.mp4` `output_path`;
optional `keep_audio` (true). Copies an admitted H.264 `avc1`/`avc3`
MP4/M4V/MOV stream into a new MP4 using the source converter's copy path.
Audio must be copyable AAC or explicitly omitted. There is no re-encoding
fallback, compressed-packet decoding or support for arbitrary input containers.
Requires no browser/native codec; check packet, timing and orientation
verification. It is container remuxing, not compression or secure removal of
hidden/encoded content.

Rotation/remux each admit 64 MiB input, 128 MiB output, 100000 combined track
samples and 6 hours, with sides at most 32767 pixels. These copy paths require
ordinary nonfragmented input, tracks starting at zero, simple supported display
matrices and track dimensions matching the source. Incoming edit lists, delayed
tracks, clean-aperture crops, nonsquare pixels and scaled/complex orientations
are refused. Verification compares every packet, decode/presentation time,
duration, codec description, output matrix and dimension; no packet is decoded.

## Video encoding

`abox_images_to_video` / `images-to-video`: ordered still-image `input_paths`
(1–32), `.mp4` `output_path`; optional even `width`/`height` (default 1280×720,
each 16–1920, product at most 2,073,600 pixels), `fps` (1, 2, 5, 10, 15, 24,
25, 30; default 30), `duration_ms` (20–60000, default 1000) or `durations_ms` with one
entry per input, `fit` (`contain` default, `cover`, `blur`, `stretch`),
hex `background` (white), and `quality` (`low`, `medium` default, `high`).

`abox_gif_to_mp4` / `gif-to-mp4`: `input_path`, `.mp4` `output_path`;
optional hex `background` (white) and `bitrate` (400000–20000000). Converts
one verified GIF playback cycle, keeps source frame timing, flattens alpha over
the background and pads odd dimensions. Does not repeat an infinite GIF loop.

Both write silent H.264 using a supported native browser encoder, with no
external encoder download. Output is limited to 60 seconds, 1800 frames,
2,073,600 pixels and 128 MiB. GIF input is at most 32 MiB, 200 frames and
32 million decoded patch pixels.
Encoded frames, geometry and timing are checked; color conversion, chroma
subsampling and time quantization remain lossy. An unavailable encoder is a
supported refusal, not a reason to upload files or install an encoder silently.

## Document scans and ID photos

`abox_document_scan` / `scan-document`: ordered `input_paths` (1–16 still
JPEG/PNG/WebP), `output_path`, `config_path`; optional `format` (`pdf` default
or single-input `png`), `mode` (`colour` default, `photo`, `grey`, `mono`),
`strength` (0–100, default 50), `max_side` (64–4096, default 2800). PDF-only
settings: `page_size` (`fit` default, `a4`, `a5`, `letter`, `legal`), `dpi`
(36–1200, default 200), `margin_mm` (0–50, default 0), `quality` (0.3–1,
default 0.82). Omit PDF-only settings for PNG.

The UTF-8 JSON configuration contains one page in input order:

```json
{"pages":[{"image_width":1200,"image_height":1600,"corners":[{"x":40,"y":40},{"x":1160,"y":40},{"x":1160,"y":1560},{"x":40,"y":1560}]}]}
```

Dimensions must match the decoded display orientation. Four finite source
pixel-edge coordinates run clockwise from the desired output's top-left:
top-left, top-right, bottom-right, bottom-left. Every point must be inside the
declared image; clipped, tiny, crossed or degenerate shapes are refused. Use
real user-selected corners, not these example numbers. No automatic detector or
OCR is run. The unchanged warp crops 3–6 source pixels inward; review margins and
signatures. Alpha composites over white. PDF color modes use lossy JPEG;
monochrome PDF images and PNG output use their stated pixel checks. Limits:
64 KiB config, 128 MiB combined inputs, 128 MiB output, 16 MP per input,
8 MP per output page and 32 MP combined output pixels. Physical PDF page
dimensions are verified.

`abox_id_photo` / `make-id-photo`: `input_path`, new `output_dir`,
`settings_path`. The local settings JSON requires `image_width`, `image_height`,
`width_mm`, `height_mm`, integer `dpi` (72–600), `head_min_mm`, `head_max_mm`,
`eye_min_mm`, `eye_max_mm`, and `landmarks` with `crown`, `chin`, `left_eye`,
`right_eye`, each `{"x":number,"y":number}` in decoded source pixels. Head
length measures crown-to-chin; eye bands are measured from the bottom edge.
Supply custom numeric requirements and real landmarks; no country preset,
face detection or official acceptance is inferred.

Optional settings: paired `paper_width_mm`/`paper_height_mm` (default 152.4×101.6),
`margin_mm` (default 3), `gap_mm` (2), hex `background` (white), `quality`
(0.8–1, default 0.94), `allow_upscale` (false). Photo sides are 10–100 mm;
paper sides 20–500 mm; margins 1–30 mm and gaps 1–20 mm. The new directory holds a JPEG
photo, JPEG print sheet and local report. Geometry, DPI, dimensions and lossy
pixel error are checked. Both routes need a local browser. ID input is at most
32 MiB, 8192 pixels per side/32 MP; settings 16 KiB, each output 16 MP/32 MiB,
and 1–100 print copies.

## Local previews

`abox_business_profile` / `preview-business-profile`: `config_path`,
`output_path`; optional `format` (`png` default or `svg`), `scale` (PNG 1–3,
default 2; SVG only 1) and `photo_path` (local still image). This is an illustrative
preview; it does not contact Google, verify a business or publish a listing.
Use local JSON such as:

```json
{"profile":{"name":"Example shop","category":"Bookshop","status":"open24"},"surface":"panel"}
```

Optional profile fields: `price` (0–4 dollar signs), `rating` (0–5), `reviews`,
`address`, `serviceArea` (boolean), `phone`, `website`, `description`,
`attributes`, `clock` (`12`/`24`), `hours`. Statuses are `auto`, `open24`,
`temporary`, `permanent`. Auto needs seven Sunday-first entries such as
`{"closed":false,"open":"09:00","close":"17:00"}`; supply local
`preview_time` (`YYYY-MM-DDTHH:mm`) to make its preview time explicit.
Surfaces: `panel`, `mobile`, `listing`. A photo uses `photo_path`; do not put
URLs or image bytes into JSON. Website text is rendered, never opened.

`abox_height_compare` / `compare-heights`: `config_path`, `output_path`;
the same `format`/`scale` settings. Local JSON:

```json
{"figures":[{"name":"A","height":"175cm","shape":"woman"},{"name":"B","height":"160cm","shape":"object","width":"50cm"}],"unit":"cm"}
```

1–20 figures; shapes `man`, `woman`, `boy`, `girl`, `object`. Optional figure
`name`, hex `color`; `width` is object-only. Root `unit` is `cm` or `ft`,
`plot_height` 240–1200 (default 600), `background` hex or `none`, `show_ruler`
and `show_names` (true). Supplied names/heights remain in the output. No body
measurement or statistical inference is performed. Both preview routes need a
local browser; configs 64 KiB, outputs 32 MiB/8192 pixels per side/16 MP;
SVG markup at most 2 MiB.

## Receipt OCR

`abox_receipt_extract` / `extract-receipt`: `input_path`, `output_path`;
optional `format` (`json` default or `csv`). Admits one still JPEG/PNG/WebP,
32 MiB, 4096 pixels per side, 4 MP. Uses bundled English printed-text Tesseract OCR and the
unchanged receipt parser offline; no model download, account or price lookup.
Output is at most 2 MiB. Recognized text, merchant, amounts, dates and currencies stay only
in the local report; MCP summaries contain counts/confidence. CSV protects
formula-like text. Verification proves report structure, not recognition or
ledger accuracy. Ask the user to review every field against the source.

## DICOM

`abox_dicom_inspect` / `inspect-dicom`: `input_path`. Returns technical shape,
pixel layout and counts, without patient names, dates, private values or instance
identifiers. Does not modify the file and requires no browser.
It does not decode pixels or prove image validity. An admitted RLE stream can
have `compressed_stream_verified:true` while inspection still reports
`verified:false` and `decoded_pixels:false`.

`abox_dicom_render` / `render-dicom`: `input_path`, `.png` `output_path`;
optional 1-based `frame` (default 1), paired `window_center`/positive
`window_width`, and `invert` (false). Uses a technical full-range window by
default; no diagnostic or clinical preset. Supports admitted 8/16-bit integer
monochrome and unsigned 8-bit RGB; verifies every output pixel using the source
renderer. Requires a local browser.

Admits flat PS3.10 files in known uncompressed implicit/explicit little-endian
or explicit big-endian transfer syntaxes, plus a strict RLE Lossless subset.
RLE requires exactly one frame, one fragment and an empty Basic Offset Table.
Segment counts/offsets and every PackBits run must produce the exact declared
byte planes; incomplete data, overrun clipping and silent zero-fill are refused.
Rendering independently checks decoded stored samples and final output pixels.

Other sequences/undefined lengths, other compressed pixels, guessed syntax and
unsupported LUT/presentation transforms are refused. Input 64 MiB, 4096 pixels
per side, 4 MP per frame, 128 native frames (RLE only 1), 10000 tags; PNG
32 MiB. Rendering is not anonymization: burned-in identifiers can remain in the
picture. Do not infer a diagnosis from the technical preview.
