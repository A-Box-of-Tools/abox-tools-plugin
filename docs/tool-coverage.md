# Local tool coverage

The upcoming v0.10.0 source targets 66 file operations plus `abox_capabilities`.
The published v0.9.0 release provides 55 operations; its verified public-download
and installation evidence remains in [publication evidence](publishing.md).
New source support is separate from a completed public release.

The adapter reuses the website's processing modules unchanged. Production
wrappers add container/codec-header admission, bounded decode plans, independent
verification, noninteractive settings, isolated browser/worker jobs and exclusive
local outputs. PDF raster redaction also uses pinned PDF.js. These engineering
guards are supported implementation, rather than a claim that container width
and height alone establish a decoder allocation bound.
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
| HEIC/AVIF | Convert admitted still photos | `heic-to-jpg` bundled libheif and conversion; `avif-to-jpg`; adapter item/codec admission | HEVC still items and one-level grids; reduced-header AV1 still AVIF; bounded coded/reference geometry before decoding |
| Metadata/checksums | Inspect, remove/edit EXIF, hash files | `exif-editor` container/TIFF/clean-copy code, shared checksum engines | Supported container metadata; explicit bounded tag edits; no anonymity or provenance proof |
| PDF pages/images | Split, merge, select, rotate, images-to-PDF | `merge-pdf` plan/assemble; shared PDF reader/writer; `images-to-pdf` document builder | Admitted unencrypted PDFs; document structure can be omitted and signatures become invalid |
| PDF optimization | Compress, watermark | `compress-pdf` image/placement logic, `watermark-pdf`, shared PDF infrastructure | Compression can be lossy or larger; watermarking adds a removable raster overlay |
| PDF redaction | Flatten every page and mask explicit regions | Bundled PDF.js 6.4.299; shared lossless PDF writer; adapter region/object verification | Fresh image-only PDF; every RGB sample and new object graph checked; no sensitive-area detection or original-file erasure |
| PDF tables/security | PDF-to-CSV, protect, unlock | `pdf-to-csv` text/table/CSV engines; shared `pdf-crypt`, `pdf-permissions`; `protect-pdf` and `unlock-pdf` helpers | Bounded filter subset; inferred tables need review; exact local password files; no password guessing |
| Text/encoding | JSON/XML/HTML/CSS/YAML formatting, YAML↔JSON, XML↔JSON, Markdown-to-HTML, Base64, data URI, text diff | Shared parse/print/byte codecs; `json-formatter` CSS, `xml-formatter` mapping, pure `share-text/markdown.js`, `yaml-to-json`, `image-to-data-uri`, `text-diff` | Documented syntax subsets and byte/node limits; XML mapping is lossy; HTML formatting retains active content while Markdown emits passive HTML |
| QR/barcodes | Generate QR/barcode, read code image | `qr-barcode`, `qr-barcode-reader` generators/readers and shared codecs | Exact local payload files; independent generation checks; reader returns at most one local decoded report |
| GIFs | Inspect, split, create | `gif-analyzer`, `split-gif`, `gif-maker`, shared GIF parser/decoder/compositor | Header inspection does not prove pixels; extraction is strict; creation quantizes colors/timing |
| Image effects | Trace, stack, redact | `image-to-svg`, `stack-images`, `redact-image` | Single-color trace; already aligned opaque equal-size stack; explicit solid black rectangles |
| Passwords | Generate passwords/passphrases | `password-generator` crypto generation and EFF wordlists | Secret text only in a new local plaintext file; no account changes or password-vault claim |
| Audio | Edit, trim, extract sound | `edit-audio` effects/speed/stretch; `trim-audio`; `extract-audio-from-video` mono mix; shared AAC/MP4/WAV helpers | PCM16/Float32 WAV, bounded MP3 Layer III/AAC-LC; output WAV or exact MP4 AAC packet copy to M4A; no video decoding for extraction |
| Video copy | Inspect, trim, join, display-matrix rotation, H.264 remux | Shared MP4 reader; `trim-video` copy/range/compatibility engines; `rotate-video` copyPicture/rotation plan; `convert-to-mp4` copy path | MP4/MOV sample-copy subset; no incoming edited timeline; packets/matrices verified without decoding |
| Video creation | Images-to-video, GIF-to-MP4 | `images-to-video`, `gif-to-mp4`, shared native codec/MP4 and GIF engines | Silent bounded H.264; installed native encoder required; no arbitrary compressed-video input |
| Video processing | Compress, crop, grab frame, reverse, time-lapse, GIF, baked rotation | `compress-video`, `crop-video`, `grab-frame`, `reverse-video`, `timelapse-video`, `video-to-gif`, `rotate-video`; shared native codecs | Admitted progressive 8-bit 4:2:0 H.264 MP4/MOV; source SPS/PPS and slice prefixes checked before decode; platform codec support required |
| Document photos | Scan document, make ID photo | `document-scanner` warp/clean/encode/document; `id-photo` geometry/sheet/JPEG | Explicit source coordinates; no edge/face detector, OCR or official ID acceptance |
| Local previews | Business profile, compare heights | `business-profile-preview`; `compare-heights` chart/artwork | Local illustrative SVG/PNG, no listing publication or measurement inference |
| Receipt OCR | Extract receipt | `receipt-invoice-extractor` OCR/receipt/CSV; pinned bundled Tesseract and English data | Printed English still-image input; suggested fields and recognized text saved locally; human review required |
| DICOM | Inspect, render | `dicom-viewer` parser/dictionary/pixel/window/RLE/JPEG modules | Flat PS3.10 native or strict single-frame RLE/JPEG Lossless subset; complete compressed admission and stored-sample checks; no diagnosis or anonymization |

Runtime processing does not fetch modules, models or encoders. The receipt OCR
assets are shipped and licensed with the plugin; their presence is not a network
blocker. Browser availability and native H.264/AAC/MP3 support vary by installation.
File/pixel/stream/worker limits are operation-specific admission policies, not a
universal operating-system process-memory cap.

## Website catalog mapping

The audited catalog contains 58 website tools: 54 file-oriented pages and four
live/device pages. Every file-oriented main workflow has a local route; this
does not imply every browser control, codec or source recovery behavior is
supported. The complete page mapping is:

| Website pages | Adapter workflow |
|---|---|
| `compress-image`, `resize-image`, `png-to-webp`, `webp-to-jpg`, `image-layout`, `image-to-ico`, `svg-to-image` | Image compression, resize/conversion, layout, ICO and admitted SVG rendering |
| `heic-to-jpg`, `avif-to-jpg` | Still HEIC/AVIF conversion |
| `image-to-svg`, `stack-images`, `redact-image` | Single-color trace, aligned-image stack and explicit solid-fill redaction |
| `exif-editor`, `hash-checksum` | Metadata inspect/remove/edit and checksums |
| `merge-pdf`, `images-to-pdf`, `compress-pdf`, `watermark-pdf`, `pdf-to-csv`, `protect-pdf`, `unlock-pdf`, `redact-pdf` | PDF page assembly, optimization, tables, passwords and flattened redaction |
| `json-formatter`, `xml-formatter`, `yaml-to-json`, `base64`, `image-to-data-uri`, `text-diff` | Bounded text formatting/mapping, byte encodings and exact local patches |
| `qr-barcode`, `qr-barcode-reader` | Generate or read codes using local payload/report files |
| `gif-analyzer`, `split-gif`, `gif-maker` | GIF technical inspection, extraction and creation |
| `edit-audio`, `trim-audio`, `extract-audio-from-video` | Bounded edit/trim/WAV extraction and MP4 AAC packet extraction |
| `compress-video`, `crop-video`, `grab-frame`, `reverse-video`, `timelapse-video`, `video-to-gif`, `rotate-video` | Admitted H.264 decoding and verified local video/image output; rotation also offers a separate packet-copy matrix route |
| `trim-video`, `convert-to-mp4`, `images-to-video`, `gif-to-mp4` | Packet-copy trim/join/remux and bounded video creation |
| `document-scanner`, `id-photo` | Explicit-coordinate document cleanup and custom ID-photo sheets |
| `business-profile-preview`, `compare-heights` | Local illustrative previews |
| `receipt-invoice-extractor`, `dicom-viewer`, `password-generator` | Bundled OCR, technical DICOM preview and local secret generation |
| `share-text`, `remote-camera`, `walkie-talkie`, `voice-oncall` | Interactive workflows remain separate; only the pure Markdown helper from `share-text` is reused locally |

## Concrete boundaries

### Codec admission and native capability

The HEIC wrapper admits complete item/extent relations and HEVC parameter/slice
headers before calling the website's offline libheif-js 1.19.8 bundle. HEIF
`ispe` is checked against visible codec geometry, while uncropped coded pixels
and reference surfaces have separate aggregate budgets. This resolves the earlier
container-only admission gap without changing the bundled decoder.

In the exact [libheif 1.19.8 libde265 plugin](https://github.com/strukturag/libheif/blob/v1.19.8/libheif/plugins/decoder_libde265.cc),
`de265_decode()` produces a decoded picture before it is copied into a libheif
image. The plugin does not pass the context image-size limit into libde265, so
the adapter cannot rely on the
[libheif security API](https://github.com/strukturag/libheif/blob/v1.19.8/libheif/api/libheif/heif.h)
as its sole allocation gate.
[libde265 1.0.15](https://github.com/strukturag/libde265/blob/v1.0.15/libde265/de265.h)
has an allocation callback API, but the website's compiled bundle does not
export it or expose its internal decoder context. The production admission
reader supplies the required earlier guard. Unsupported sequences, item relations,
grid structures and coded/render geometry changes fail before decoding.

Exact corresponding-source archives and build/replacement instructions travel
with the library under `vendor/libheif-sources/`; see
[third-party notices](../THIRD_PARTY_NOTICES.md). The upstream build is documented
in its [pinned Emscripten workflow](https://github.com/catdad-experiments/libheif-emscripten/blob/v1.19.8/.github/workflows/emscripten.yml)
and [libheif build script](https://github.com/strukturag/libheif/blob/v1.19.8/build-emscripten.sh).
AVIF uses a separate reduced-still AV1 header admission path. Animated AVIF and
arbitrary video/RAW photo formats are not silently accepted as generic images.

### Compressed audio and video subsets

Compressed audio now has complete MP3 frame/ADTS/table admission before a bounded
WebCodecs packet queue. Every returned block must match the admitted channel/rate
geometry and fit the reserved output planes. AAC-LC only, ordinary mono/stereo
and unedited audio timelines are supported; PCE/HE extensions, changed parameters,
fragments and arbitrary container/codecs remain refused. This is not a full
entropy-validity proof. Native priming/padding can reduce actual sample counts.
M4A extraction copies and verifies AAC packets without decoding or a browser.

Video decoding admits a stable progressive H.264 8-bit 4:2:0 SPS/PPS/slice subset,
with coded-side/pixel/reference and frame/time budgets before native decoding.
HEVC/AV1 video, interlacing, changed parameter sets, unusual timelines and complex
display transforms remain refused. Native codec absence is a separate capability
result. Packet-copy inspection/trim/join/matrix rotation/remux never decode video.
The copy routes do not establish playback compatibility or erase hidden packets.

### PDF content redaction

The website's original text-operation deletion is not sufficient for scanned text
or image pixels. The adapter therefore renders every admitted page with bundled
PDF.js, applies explicit black rectangles and writes a fresh lossless image-only
PDF. Every saved RGB byte and allowed new object are checked; source objects are
never copied. Searchable text, interactive features and signatures are lost.
The renderer's supported filter/image subset is intentionally conservative.
Redaction does not identify sensitive information, certify the user's coverage
or erase the original. PDF watermarking remains a removable overlay.

### DICOM and specialized formats

The current DICOM adapter admits native integer pixels and a narrow RLE Lossless
path: one frame, one fragment, an empty offset table, exact byte-plane segment
counts and complete PackBits runs. Its decoder allocates from admitted outer
geometry. A separate nonallocating run walk rejects the unchanged decoder's
silent padding/clipping recovery and verifies each decoded stored sample.
JPEG Lossless Process 14 now has a complete nonallocating SOF/SOS/Huffman/entropy
admission walk before the source decoder, with independently verified stored
samples afterward. Only one frame/fragment, an empty offset table, outer-matched
geometry and a single full interleaved scan are accepted. Restart/multiscan and
other compressed syntaxes remain refused; decoder disagreements fail closed.
Other sequences/undefined lengths and unsupported palette/LUT/presentation
transforms remain refused. The output can contain burned-in
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
