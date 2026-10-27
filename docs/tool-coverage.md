# Local tool coverage

The v0.9.0 source targets 55 file operations plus `abox_capabilities`. This is
source coverage, not a claim that v0.9.0 downloads have been published or checked.
The README retains the separate verified public-release evidence.

The adapter reuses the website's processing modules unchanged. Its new code
admits supported local inputs, bounds work, supplies noninteractive settings,
isolates browser/worker jobs, verifies results and writes new local outputs.
[provenance.json](../vendor/abox/provenance.json) identifies every copied file and
its exact upstream commit/hash. Generated re-export bridges resolve the static
website's shared imports; they do not replace processing engines.

The operation names below cover meaningful workflows rather than one alias for
every website page. For example, image conversion covers the PNG/WebP/JPEG
conversion pages, and PDF selection covers extraction, ordering and duplication.
The installed adapter's `capabilities` response is the authority for its limits.

## Reused engines and supported scope

| Area | Operations | Unchanged website modules | Supported boundary |
|---|---|---|---|
| Raster images | Compress, resize, convert, layout, ICO, SVG rasterization | `compress-image`, `resize-image`, `image-layout`, `image-to-ico`, `svg-to-image`; shared image codecs/geometry | Still JPEG/PNG/WebP; static self-contained SVG subset; local browser encoders |
| Metadata/checksums | Inspect, remove/edit EXIF, hash files | `exif-editor` container/TIFF/clean-copy code, shared checksum engines | Supported container metadata; explicit bounded tag edits; no anonymity or provenance proof |
| PDF pages/images | Split, merge, select, rotate, images-to-PDF | `merge-pdf` plan/assemble; shared PDF reader/writer; `images-to-pdf` document builder | Admitted unencrypted PDFs; document structure can be omitted and signatures become invalid |
| PDF optimization | Compress, watermark | `compress-pdf` image/placement logic, `watermark-pdf`, shared PDF infrastructure | Compression can be lossy or larger; watermarking adds a removable raster overlay |
| PDF tables/security | PDF-to-CSV, protect, unlock | `pdf-to-csv` text/table/CSV engines; shared `pdf-crypt`, `pdf-permissions`; `protect-pdf` and `unlock-pdf` helpers | Bounded filter subset; inferred tables need review; exact local password files; no password guessing |
| Text/encoding | JSON/XML/HTML/CSS/YAML formatting, YAML↔JSON, XML↔JSON, Markdown-to-HTML, Base64, data URI, text diff | Shared parse/print/byte codecs; `json-formatter` CSS, `xml-formatter` mapping, pure `share-text/markdown.js`, `yaml-to-json`, `image-to-data-uri`, `text-diff` | Documented syntax subsets and byte/node limits; XML mapping is lossy; HTML formatting retains active content while Markdown emits passive HTML |
| QR/barcodes | Generate QR/barcode, read code image | `qr-barcode`, `qr-barcode-reader` generators/readers and shared codecs | Exact local payload files; independent generation checks; reader returns at most one local decoded report |
| GIFs | Inspect, split, create | `gif-analyzer`, `split-gif`, `gif-maker`, shared GIF parser/decoder/compositor | Header inspection does not prove pixels; extraction is strict; creation quantizes colors/timing |
| Image effects | Trace, stack, redact | `image-to-svg`, `stack-images`, `redact-image` | Single-color trace; already aligned opaque equal-size stack; explicit solid black rectangles |
| Passwords | Generate passwords/passphrases | `password-generator` crypto generation and EFF wordlists | Secret text only in a new local plaintext file; no account changes or password-vault claim |
| Audio | Edit, trim | `edit-audio` effects/speed/stretch; `trim-audio`; shared audio decode/WAV writing | Admitted simple PCM16/Float32 WAV only; bounds known before native decode; encoded samples verified |
| Video copy | Inspect, trim, join, display-matrix rotation, H.264 remux | Shared MP4 reader; `trim-video` copy/range/compatibility engines; `rotate-video` copyPicture/rotation plan; `convert-to-mp4` copy path | MP4/MOV sample-copy subset; no incoming edited timeline; packets/matrices verified without decoding |
| Video creation | Images-to-video, GIF-to-MP4 | `images-to-video`, `gif-to-mp4`, shared native codec/MP4 and GIF engines | Silent bounded H.264; installed native encoder required; no arbitrary compressed-video input |
| Document photos | Scan document, make ID photo | `document-scanner` warp/clean/encode/document; `id-photo` geometry/sheet/JPEG | Explicit source coordinates; no edge/face detector, OCR or official ID acceptance |
| Local previews | Business profile, compare heights | `business-profile-preview`; `compare-heights` chart/artwork | Local illustrative SVG/PNG, no listing publication or measurement inference |
| Receipt OCR | Extract receipt | `receipt-invoice-extractor` OCR/receipt/CSV; pinned bundled Tesseract and English data | Printed English still-image input; suggested fields and recognized text saved locally; human review required |
| DICOM | Inspect, render | `dicom-viewer` parser/dictionary/pixel/window/RLE modules | Flat PS3.10 native or strict single-frame RLE subset; technical preview, no diagnosis or anonymization |

Runtime processing does not fetch modules, models or encoders. The receipt OCR
assets are shipped and licensed with the plugin; their presence is not a network
blocker. Browser availability and native H.264 support can vary by installation.
File/pixel/stream/worker limits are operation-specific admission policies, not a
universal operating-system process-memory cap.

## Concrete unsupported paths

### HEIC: codec allocation before the available check

The website already carries an offline libheif-js 1.19.8 WebAssembly bundle;
its LGPL license is resolvable and is not the reason this route is absent.
`HeifDecoder.decode()` reads metadata and returns handles, and dimensions can be
queried before the JavaScript RGBA buffer is allocated. That alone is incomplete:
the codec's coded dimensions can disagree with HEIF `ispe` dimensions.

In the exact [libheif 1.19.8 libde265 plugin](https://github.com/strukturag/libheif/blob/v1.19.8/libheif/plugins/decoder_libde265.cc),
`de265_decode()` produces a decoded picture before it is copied into a libheif
image. The plugin does not pass the context image-size limit into libde265.
The [libheif security API](https://github.com/strukturag/libheif/blob/v1.19.8/libheif/api/libheif/heif.h)
therefore does not establish a preallocation bound inside that codec.
[libde265 1.0.15](https://github.com/strukturag/libde265/blob/v1.0.15/libde265/de265.h)
has an allocation callback API, but the website's compiled bundle does not
export it or expose its internal decoder context. The existing website source
has no reusable SPS geometry admission reader. This batch does not add a new
codec parser or rebuild the unchanged library to bypass that gap.

A supported future implementation needs a tested codec allocation gate or
upstream codec-header admission, plus the exact library/dependency corresponding
source and build/replacement instructions for redistribution. The actual build
is documented in the [pinned Emscripten workflow](https://github.com/catdad-experiments/libheif-emscripten/blob/v1.19.8/.github/workflows/emscripten.yml)
and [libheif build script](https://github.com/strukturag/libheif/blob/v1.19.8/build-emscripten.sh).
No HEIC conversion operation is registered.

### Compressed audio and video decoding

The reused browser audio decoder accepts compressed media but provides channel,
duration and frame counts after decoding. The WAV routes inspect complete
uncompressed headers before that allocation. MP3/AAC/other compressed audio and
`extract-audio-from-video` need an equivalent admission path before they can
claim the same resource bounds.

Video sample inspection/copying never decodes compressed packets. The current
adapter does not offer arbitrary video transcoding, cropping, reversing,
baked pixel rotation, time-lapse, video-to-GIF or grab-frame decoding.
Display-matrix rotation instead uses an existing no-decode copy path and is
available for the admitted subset. The source converter's H.264/AAC copy path
also provides MP4/MOV-to-MP4 remuxing; it does not expose that converter's
arbitrary decode/re-encode fallback. Container width/height
alone is insufficient evidence of the coded dimensions or decoder allocations.
Adding aliases to the browser decoder would not resolve this. Native encoder
availability is separately checked for the bounded image/GIF-to-video routes.

AVIF conversion is also outside the current raster input subset; it needs its
own container/codec admission and verification, rather than being silently
accepted through a generic image MIME type.

### PDF content redaction

The website's `redact-pdf` route removes selected text-show operations and
explicitly cannot remove scanned text or image pixels. A blanket permanent
redaction promise would require a verified content-removal or full rasterization
path covering text, images, annotations and other reachable representations.
This unchanged-source batch has no such general path. PDF watermarking is not
redaction. Solid-fill image redaction is available for explicitly selected image
pixels; it still cannot determine whether the user selected every sensitive area.

### DICOM and specialized formats

The current DICOM adapter admits native integer pixels and a narrow RLE Lossless
path: one frame, one fragment, an empty offset table, exact byte-plane segment
counts and complete PackBits runs. Its decoder allocates from admitted outer
geometry. A separate nonallocating run walk rejects the unchanged decoder's
silent padding/clipping recovery and verifies each decoded stored sample.
Other sequences/undefined lengths and unsupported palette/LUT/presentation
transforms remain refused. The existing JPEG-lossless decoder reads its internal
SOF dimensions before the outer-geometry check and can recover from end-of-input
without a strict completeness error, so it is not admitted in this batch.
Other compressed syntaxes are not claimed. The output can contain burned-in
patient identifiers even when no patient fields are returned.
RAW image decoding, automatic image alignment/focus stacking and automatic face,
landmark or document-edge detection are not exposed by these routes.

### Live sharing and devices

`share-text`, `remote-camera`, `walkie-talkie` and `voice-oncall` depend on live
connections, peer pairing or camera/microphone access. They require explicit
interactive device/network workflows rather than a local file adapter.
No route opens a camera, microphone, rendezvous connection, decoded URL or
business account. An unsupported file is not uploaded as a fallback.
The pure `share-text/src/markdown.js` helper is independently reusable and is
exposed as local Markdown-to-HTML; it does not import the live sharing workflow.

## How to extend this safely

Start with the existing website module and its documented behavior. Add a
production admission/verification wrapper and focused permanent checks to this
repository; put exploratory harnesses and measurements in
[etoolbox-lab](https://github.com/A-Box-of-Tools/etoolbox-lab).
Update the provenance seeds, operation schema, CLI mapping, shared-skill reference
and packaged smoke coverage together. A local unit success is separate from
four-platform release checks and installation of actual public downloads.
