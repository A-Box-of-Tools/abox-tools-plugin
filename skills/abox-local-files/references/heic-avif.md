# HEIC and AVIF conversion

Use `abox_heic_convert` (`convert-heic`) for HEVC still HEICs, including the
admitted one-level grids used by many iPhone photos. Supply `input_path`, a new
`output_dir`, optional `format` (`jpeg` default, `png`, `webp`) and `quality`
(0–1, default 0.92). Every admitted top-level picture is written as
`image-001.jpg`, etc. The bundled website codec runs offline.

Use `abox_avif_convert` (`convert-avif`) for one reduced-header AV1 still AVIF.
Supply `input_path`, a new `output_path`, optional `format` (`png` default,
`jpeg`, `webp`) and `quality`. Animated/track-based AVIFs are refused.

Both routes require installed Edge, Chrome or Chromium. No codec is downloaded
during processing. They read complete item/extent tables and coded sequence
headers before native decoding. Limits: 64 MiB input, 8192 pixels per side,
32 MP per image, 96 MP combined item/grid and uncropped coded surfaces,
128 MP HEVC reference surfaces, 256 items and 16 top-level HEIC pictures. The installed
capabilities response is authoritative. Unsupported layouts fail locally.

Check `verified`, `verification.codec_geometry_admitted_before_decode`, output
dimensions and `pixel_mean_absolute_error`. PNG compares all canonical canvas
pixels exactly; JPEG/WebP compare all samples with a lossy error bound. This
does not prove original color accuracy: outputs are 8-bit SDR, source HDR/precision
can change, and re-encoding can make files larger. No EXIF or other source
metadata is copied. Original files remain unchanged. Keep encoded image bytes
out of the conversation and report paths/counts and verification summaries.
