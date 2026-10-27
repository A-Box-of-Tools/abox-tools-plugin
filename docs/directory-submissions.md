# Directory submission materials

These materials describe the local file-processing plugin. The website's
development catalogue MCP is a separate service and is not part of this listing.
Registration automation is documented in [Publishing](publishing.md).

## Listing copy

Display name: **abox.tools**

Publisher: **Abox Technologies**

Use this registered trade name consistently; abox.tools is the product name.

Short description: **Process local images, PDFs and files**

Category: **Productivity**

Description (within Claude's 50-word limit):

> Abox Technologies publishes abox.tools: 25 local image, PDF, structured-text,
> comparison, QR, barcode, metadata and checksum tools with a shared agent skill.
> Runtimes are included. Image processing uses installed Edge, Chrome or Chromium.
> PDF tables have no OCR. Files stay local. No account required.

Long description:

> Give your agent 25 reusable file tools: compress JPEG, PNG, and static WebP
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
> PDF tables are inferred without OCR and require review against the source.
> The adapter processes files locally and returns output paths and
> concise verification results. It never overwrites existing outputs.
>
> The release includes Node and the server dependencies. Image processing, PDF compression and watermark rendering need
> an installed Edge, Chrome, or Chromium. QR codes and barcodes default to SVG
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

The [version 0.7.0 Official MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.7.0)
identifies Abox Technologies as publisher. This release provides 25 local file
operations and one capabilities tool. Publication checks are recorded in its
[release and registration workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40555454288)
and [source verification workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40555454149)
for the release from [4c1fa98](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/4c1fa9806acbc8c417863bf7625067c2593e6fdd).
Claude's form confirmed the
publisher correction and the 0.3.0 review download link; directory review remains
pending. Its original 0.2.1 attachment cannot be replaced through response
editing, so the updated feedback directs reviewers to the current public MCPB.
Version 0.2.1 is installed and Running in Claude Desktop on Windows. OpenAI
remains pending local-MCP partner approval.

The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is public. Gemini's normal public-release installation was verified for v0.7.0;
version 0.7.0's four platform archives and offline skill setup are checked in CI.
The shared skill's real v0.7.0 GitHub release download and integrity verification
also passed on Windows on 27 October 2026 in an isolated directory.
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
