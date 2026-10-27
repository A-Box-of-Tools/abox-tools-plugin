# Directory submission materials

These materials describe the local file-processing plugin. The website's
development catalogue MCP is a separate service and is not part of this listing.
Registration automation is documented in [Publishing](publishing.md).

## Listing copy

Display name: **abox.tools**

Publisher: **Abox Technologies**

Use this registered trade name consistently; abox.tools is the product name.

Short description: **Local image, PDF, audio, video and text tools**

Category: **Productivity**

Description (within Claude's 50-word limit):

> Abox Technologies publishes abox.tools: 55 local image, GIF, PDF, audio, video,
> text, OCR, metadata and checksum operations with a shared agent skill.
> Runtimes and English OCR data are included. Rendering needs an installed browser.
> Files stay local. Extraction requires review. No account required.

Long description:

> Give your agent 55 reusable file operations: compress JPEG, PNG, and static WebP
> images to a byte target; resize or convert images; merge or split unencrypted
> PDFs; extract, reorder, duplicate or rotate their pages; create PDFs from images;
> inspect or remove supported image metadata; and calculate file checksums.
> Additional operations compress PDFs, overlay PDF text watermarks, create
> multi-size ICO icons and rasterize self-contained static SVGs. Compose grids or
> strips from images, extract selectable PDF tables into CSV, format JSON while
> preserving large numbers and duplicate keys, and encode/decode Base64 files.
> Convert supported YAML and JSON, format XML, compare text files with a verified
> unified patch, embed original image bytes as data URIs, and generate QR codes or
> barcodes from the exact UTF-8 text in a local file. YAML conversion supports a
> limited subset; XML formatting refuses DTDs and custom entities. Text comparison
> reports ignore settings separately while its patch always transforms the raw
> originals. QR and barcode results are independently decoded before writing.
> Inspect GIF headers or extract verified stored or composited PNG frames. Trace
> bitmap shapes into a single-color SVG, combine aligned opaque image frames,
> permanently replace selected image pixels with opaque black, or generate
> passwords and EFF passphrases directly into a new local plaintext file.
> Redaction uses explicit full-resolution rectangles and does not find sensitive
> content. Password values, hashes and samples are excluded from tool results.
> PDF tables are inferred without OCR and require review against the source.
> Read QR/barcode payloads only into a local report, create GIFs, protect or unlock
> PDFs using separate local password files, edit/trim admitted WAV audio, inspect
> or copy supported MP4/MOV timelines, and encode bounded silent H.264 videos from
> still images or one GIF cycle. Explicit local corner/landmark settings support
> document scans and custom ID photos without face detection or official approval.
> Generate local business-profile or height previews without publishing accounts.
> Bundled English receipt OCR writes suggested fields into a local report for
> review. Technical DICOM inspection/rendering supports admitted native or strict
> single-frame RLE images; it is not diagnosis or anonymization. Edit explicit
> EXIF tags, format supported HTML/CSS/YAML, map XML and JSON with documented
> losses, or render the small Markdown dialect into passive HTML. HTML formatting
> retains active markup and is not sanitization; video cuts can retain boundary
> packets and are not redaction.
> The adapter processes files locally and returns output paths and
> concise verification results. It never overwrites existing outputs.
>
> The release includes Node and the server dependencies. Image processing, GIF
> creation/extraction, WAV processing, scans, previews, OCR and new MP4 encoding need
> an installed Edge, Chrome, or Chromium. New MP4 encoding also needs its native
> H.264 encoder; no encoder or OCR model is downloaded during processing.
> QR codes and barcodes default to SVG
> without a browser; PNG output uses the installed local browser. Metadata
> cleaning keeps orientation and color profiles by default. Data URI encoding
> preserves original metadata and SVG markup; its signature check does not prove
> image validity or rendering. Most image and PDF inputs are limited to 128 MiB;
> text and code-generation tools have lower operation-specific limits, while
> streaming checksums support 8 GiB. Native ZIPs and Gemini extensions also
> include a shared workflow skill. The
> MCPB installs the MCP tools in compatible desktop hosts.

## Public links and assets

- Repository: <https://github.com/A-Box-of-Tools/abox-tools-plugin>
- Releases: <https://github.com/A-Box-of-Tools/abox-tools-plugin/releases>
- Homepage: <https://abox.tools/>
- Documentation: <https://github.com/A-Box-of-Tools/abox-tools-plugin#readme>
- Support: <https://github.com/A-Box-of-Tools/abox-tools-plugin/issues>
- Privacy: <https://github.com/A-Box-of-Tools/abox-tools-plugin/blob/main/PRIVACY.md>
- Software license and warranty: <https://github.com/A-Box-of-Tools/abox-tools-plugin/blob/main/LICENSE>
- Icon: `assets/icon.png` in the repository and release bundle.
- Claude attachment: the release's single `abox-tools-<version>-universal.mcpb`.
- OpenAI attachment: the ZIP matching the reviewer's desktop platform. Ask the
  reviewing organization how to supply additional platform variants; the portal
  documentation does not establish automatic native selection from four ZIPs.

Contact details belong in the submission form, rather than this public file.
First-party ownership is represented by the organization-owned source engines,
the public repository, and the manifest author's organization profile.

## Reviewer scenarios

Use disposable synthetic images and unencrypted PDFs. Choose fresh absolute
output paths for every scenario; do not upload private sample files. The tests
and release smoke checks generate synthetic fixtures and verify outputs.

| Positive case | Request | Expected result |
| --- | --- | --- |
| Image size | Compress a large JPEG below 500,000 bytes to a new local path. | `verified: true`; report `fitted` and actual bytes honestly. Original remains unchanged. |
| Resize | Fit a 256×256 PNG within a 96×64 box without upscaling. | New 64×64 PNG; original unchanged. Cover instead produces a centered 96×64 crop. |
| Convert | Convert a transparent PNG to lossless WebP, then back to PNG. | Actual format signatures and decoded dimensions match; alpha is preserved. |
| PDF pages | Split a three-page PDF into individual pages. | Three new PDFs, each reopened and verified as one page. |
| PDF merge | Combine a three-page PDF and a two-page PDF in order. | Five pages with the expected decoded page contents, preserving both inputs. |
| Page order | Select `3,1-2,3` from a three-page PDF. | Four output pages with actual content order 3,1,2,3. |
| PDF rotation | Rotate only page 2 clockwise by 90 degrees. | Three pages retained in order; only page 2's rotation changes. |
| Images to PDF | Put a PNG and JPEG into one PDF. | Two pages in input order; correct page sizes and source bytes unchanged. |
| Metadata inventory | Inspect an image with private EXIF and text. | Counts and presence reported without private tag values. Original unchanged. |
| Checksums | Hash an empty file and a multi-chunk file. | Digests match independent MD5/SHA implementations; input unchanged. |
| PDF ranges | Extract `1-2` and `3` as separate PDFs from a three-page input. | Two new PDFs with two and one pages respectively. |
| Default metadata | Remove image metadata while preserving appearance. | Verified clean copy; orientation and ICC may remain, and the result describes that. |
| Strict metadata | Remove supported metadata with `keep_orientation: false` and `keep_icc: false`. | New verified copy; supported orientation and ICC fields removed. |
| YAML / JSON | Convert a YAML configuration with a large integer and duplicate keys to JSON. | Numeric tokens and ordered duplicate keys retained; comments may be removed. Unsupported YAML features are refused. |
| XML | Format XML containing mixed text, `xml:space`, predefined entities and numeric references. | New XML retains the source engine's mixed-content and preserved-whitespace semantics. DTDs and custom entities are refused. |
| Text comparison | Compare two UTF-8 files containing changed whitespace and a missing final newline. | New `.diff` or `.patch` is independently replayed to the exact right-hand input; ignore options affect only the comparison summary. |
| Image data URI | Embed a synthetic SVG as a bare URI and an HTML image. | Decoded bytes equal the original; readable percent encoding is used only for a bare SVG URI and embedding envelopes use Base64. Metadata and markup remain intact. |
| QR code | Generate an SVG from a local UTF-8 payload file ending in a newline. | Independent decoding retains the exact payload, including the newline. The payload is absent from MCP results and errors. |
| Barcode | Generate a barcode from a disposable numeric payload file. | Independently decoded output matches the selected format's normalization and check-digit rules; unsupported capacity or verification limits are refused. |
| GIF inspection | Inspect a synthetic animation with multiple timings and disposal methods. | Paginated header and timing summary without embedded text or palette colors; `verified: false` makes the absence of pixel validation explicit. |
| GIF extraction | Extract selected composited PNGs from the same animation. | New timing manifest and decoded PNG pixels matching the source compositor; the GIF remains unchanged. |
| Bitmap tracing | Trace a simple black shape on white into an SVG. | Passive single-color path with checked rendered pixels; the result is an approximation and must be reviewed visually. |
| Image stacking | Average two already aligned opaque images of equal size. | New PNG matches independently checked stack arithmetic and decoded output pixels; no alignment is attempted. |
| Solid redaction | Redact user-specified rectangles from a synthetic PNG, using a local JSON file with exact decoded dimensions. | Requested pixels are exactly opaque black, outside alpha is retained, visible outside colors are checked, and source metadata is absent. Review coverage before sharing. |
| Password generation | Generate two six-word passphrases using a local configuration file. | New private plaintext file, with only path, count and settings returned. No generated value, hash or sample appears in tool replies. |

| Negative case | Request | Expected result |
| --- | --- | --- |
| Remote file | Process an HTTPS URL as `input_path`. | Reject the URL; require an absolute local path. No download. |
| Existing output | Save into a file that already exists. | Reject with no overwrite; input and existing output remain unchanged. |
| Encrypted PDF | Split an encrypted PDF. | Refuse the unsupported input; explain that an unencrypted PDF is needed. |

Before a directory submission, verify installation in the actual target desktop
application, exercise the main workflows there, and record the demo requested
by its review team. Protocol smoke checks do not establish a completed desktop
installation or replace that recording.

## Submission status and access

The active/latest [v0.9.0 Official MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.9.0)
identifies Abox Technologies as publisher. This version provides 55 local file operations and one
capabilities tool. Its
[release and registration workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578848781)
and [source verification workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578847970)
passed for tagged source
[9f06812](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/9f068120f51e0bba3ea91f3dd024ff9a312c7f9b).
The public release has 26 assets; native and universal packages passed all four
platform targets, and the public Registry record's universal MCPB hash matches
the GitHub asset.
Claude's form confirmed the
publisher correction and the 0.3.0 review download link; directory review remains
pending. Its original 0.2.1 attachment cannot be replaced through response
editing, so the updated feedback directs reviewers to the current public MCPB.
Version 0.2.1 is installed and Running in Claude Desktop on Windows. OpenAI
remains pending local-MCP partner approval.

The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is public. Version 0.9.0 passed packaged Gemini and offline skill checks on all
four CI targets; its copied skill contains ten files. The default Python installer
downloaded and verified the actual public Windows ZIP in an isolated cache.
That bundle passed all 55 file operations and 56 MCP tools with Node.js 24.22.1,
including relocation, installation links and launch without system Node; no
local rebuild supplied the proof. Public v0.9.0 Gemini and skills installation
checks also passed on 27 October 2026: Gemini CLI 0.65.0 installed
`--ref v0.9.0` with 56 tools, the shared skill, bundled runtime and a local file
operation. Skills CLI 1.7.4 copied ten skill files with adapter version 0.9.0
into an isolated project/home and checked the installer contract offline.
That skill-only check did not install an adapter offline; the separate public
Python download and 55-operation smoke above verify actual adapter installation.

Historical public skills CLI 1.7.4 installed the v0.8.0 skill's six files and
passed its offline installer checks in an isolated directory on 27 October 2026.
Gemini's normal public-release installation passed for v0.8.0 using CLI 0.65.0
on Windows, with 32 tools, the shared skill, bundled runtime and a local file
operation. Version 0.8.0's four platform archives and offline skill setup passed
CI. The default Python installer fetched and verified the real v0.8.0 Windows
ZIP in an isolated cache; all 31 operations and 32 MCP tools then passed against
that installed bundle using its Node.js 24.22.1 runtime. Relocation and
installation-link checks also passed. Historical v0.7.0 public installation and
download checks are recorded in [Publishing](publishing.md).
A gallery listing is unconfirmed after adding its discovery
topic. Cursor's native installation link and source launcher are tested. Its
Marketplace application was submitted on 26 October 2026 for Abox Technologies
with the accepted `abox-tools` handle. Cursor acknowledged receipt; review is
pending and no live Marketplace listing is confirmed.

The native bundle also includes a VS Code installation link. Its decoded
configuration and local MCP connection are tested; desktop installation in VS
Code remains unverified. The authorized AgentSkillsDir submission attempt was
not accepted: the backend reported “Resource submissions are currently closed”.
Smithery publication remains a follow-up for the publisher.

The Official MCP Registry workflow publishes metadata only after the release is
public and its universal MCPB has passed all four native smoke checks. A
successful workflow and a readable Registry record confirm publication.

Claude's [desktop extension form](https://clau.de/desktop-extention-submission)
requires a Google-account identity, contact information, one MCPB upload, and
agreement to the Directory Terms. Preparing an artifact does not mean it has
been submitted or approved.

OpenAI's [desktop-only submission guide](https://developers.openai.com/plugins/deploy/desktop-only)
requires representative-confirmed allowlisting for local MCP. The publisher
must first supply the organization ID from the
[organization settings](https://platform.openai.com/settings/organization/general)
to its OpenAI representative. Then use the
[plugin portal](https://platform.openai.com/plugins), with verified identity and
the required publishing role. Do not submit a skills-only package that silently
omits these MCP tools.
