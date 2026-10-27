---
name: abox-local-files
description: Use abox.tools to process local images, PDFs, GIFs, audio, video and text, extract receipt or code reports, generate passwords and edit metadata while keeping file contents outside the conversation.
---

# abox.tools local files

Use the installed Abox Technologies adapter with absolute local paths. File
processing is offline. Keep source bytes, recognized text, decoded codes,
passwords and metadata values out of the conversation. Return output links and
the adapter's short verification summary.

## Workflow

1. Resolve the user's input paths and intended result. Call `abox_capabilities`
   when support, limits or settings are unclear; an installed release can expose
   fewer operations than a newer copy of this skill.
2. Choose new output paths. Existing outputs are refused and sources are kept.
   Split operations and ID photos require a new output directory.
3. Read only the relevant reference below, then call its operation. Use defaults
   unless the user requested otherwise. Keep passwords, payloads, OCR text and
   sensitive configuration in local files; pass their paths directly.
4. Check verification and warnings. Report missed size targets, clipping,
   unsupported formats or uncertain extraction accurately. Link the returned
   output paths, including a manifest when provided.

If MCP and the CLI are absent, use [installation](references/installation.md).
The standalone Python installer needs Python 3.9+ and downloads a verified
release; it needs no clone, Node or npm. Setup downloads use the network.
Do not install during a file operation unless setup is already authorized.

## Choose an operation

| Task | MCP operation | Reference |
|---|---|---|
| Compress, resize, convert or lay out images | `abox_image_compress`, `abox_image_resize`, `abox_image_convert`, `abox_image_layout` | [Core tools](references/core-tools.md) |
| Create icons, rasterize SVG | `abox_image_to_ico`, `abox_svg_to_image` | [Core tools](references/core-tools.md) |
| Split, merge, select, rotate or make PDFs | `abox_pdf_split`, `abox_pdf_merge`, `abox_pdf_select`, `abox_pdf_rotate`, `abox_images_to_pdf` | [Core tools](references/core-tools.md) |
| Compress, watermark or extract PDF tables | `abox_pdf_compress`, `abox_pdf_watermark`, `abox_pdf_to_csv` | [Core tools](references/core-tools.md) |
| Inspect/remove metadata or hash files | `abox_exif_inspect`, `abox_exif_remove`, `abox_file_hash` | [Core tools](references/core-tools.md) |
| Edit explicit EXIF tags | `abox_exif_edit` | [Metadata edit JSON](references/metadata-editing.md) |
| Format/convert text, Base64, data URIs or patches | `abox_json_format`, `abox_yaml_json`, `abox_xml_format`, `abox_base64`, `abox_image_data_uri`, `abox_text_diff` | [Core tools](references/core-tools.md) |
| Format HTML/CSS/YAML, map XML↔JSON or render Markdown | `abox_code_format`, `abox_xml_json`, `abox_markdown_html` | [Additional text formatting](references/text-formatting.md) |
| Generate QR/barcodes | `abox_qr_generate`, `abox_barcode_generate` | [Core tools](references/core-tools.md) |
| Inspect/split GIFs, trace or stack images | `abox_gif_inspect`, `abox_gif_split`, `abox_image_trace`, `abox_image_stack` | [Additional image tools](references/additional-tools.md) |
| Redact image rectangles or generate passwords | `abox_image_redact`, `abox_password_generate` | [Local JSON and secret files](references/additional-tools.md) |
| Read a QR/barcode or create a GIF | `abox_code_read`, `abox_gif_create` | [Media and documents](references/media-and-documents.md) |
| Protect/unlock PDFs | `abox_pdf_protect`, `abox_pdf_unlock` | [PDF passwords](references/media-and-documents.md#pdf-passwords) |
| Edit/trim WAV; inspect/copy MP4/MOV | `abox_audio_edit`, `abox_audio_trim`, `abox_video_inspect`, `abox_video_trim`, `abox_video_join`, `abox_video_rotate`, `abox_video_remux` | [Audio and video](references/media-and-documents.md#audio-and-video) |
| Make silent MP4 from images/GIF | `abox_images_to_video`, `abox_gif_to_mp4` | [Video encoding](references/media-and-documents.md#video-encoding) |
| Straighten document photos or make ID photos | `abox_document_scan`, `abox_id_photo` | [Explicit image coordinates](references/media-and-documents.md#document-scans-and-id-photos) |
| Preview a business profile or compare heights | `abox_business_profile`, `abox_height_compare` | [Local previews](references/media-and-documents.md#local-previews) |
| Extract printed receipt fields | `abox_receipt_extract` | [Receipt OCR](references/media-and-documents.md#receipt-ocr) |
| Inspect/render DICOM | `abox_dicom_inspect`, `abox_dicom_render` | [DICOM](references/media-and-documents.md#dicom) |

## Decisions that matter

- Use exact user-provided dimensions and coordinates for redaction, document
  corners and ID-photo landmarks. Ask when required coordinates are missing;
  never guess from a scaled preview. The adapter does not detect private content,
  faces or document edges, or certify ID-photo acceptance.
- Password files, QR/barcode payloads and PDF passwords are exact local text.
  Do not trim or append a newline. Generated secrets stay in a new plaintext
  file; never read, preview, quote or hash them in the conversation.
- OCR and PDF-table results need review against the original. Verification
  proves the stated structure/pixel/packet checks, not financial or clinical
  accuracy. DICOM pictures can retain burned-in identifiers.
- XML/JSON mapping is explicitly lossy. Formatting HTML preserves active markup;
  never open it automatically or call formatting sanitization. Markdown rendering
  instead emits the documented passive subset; source links stay in the file.
- Image solid-fill redaction removes the selected pixels. A PDF watermark and
  a video cut are overlays/timeline operations; they do not securely remove
  hidden content. PDF content redaction is not supported.
- HEIC conversion, compressed-audio decoding and arbitrary video transcoding
  are unavailable until codec allocation can be admitted safely. Network/device
  tools such as live sharing and remote cameras are outside this local adapter.
  Follow an explicit unsupported result; do not upload the file as a fallback.

## CLI fallback

Use the same adapter through its CLI and a local request JSON file:

```text
<node-executable> <plugin-root>/bin/abox.mjs <operation> --request-file <absolute-request-path>
```

Release bundles include `runtime/node.exe` on Windows and `runtime/node` on
macOS/Linux. Use the bundled runtime; source checkouts use their installed Node.
The references list the command names. `capabilities` lists support and `doctor`
checks local setup. Quote paths with spaces. Never put secret text into command
arguments or return file contents from the CLI to the conversation.
