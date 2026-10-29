#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { execute, capabilities } from '../src/tools.mjs';
import { errorResult, AdapterError } from '../src/errors.mjs';
import { verifyVendor } from '../scripts/verify-vendor.mjs';
import { localPath } from '../src/files.mjs';
import { closeLiveSessions } from '../src/live.mjs';

const commands = {
  'share-session': 'abox_share_session', 'camera-session': 'abox_camera_session', 'walkie-session': 'abox_walkie_session', 'voice-oncall-session': 'abox_voice_oncall_session',
  'live-status': 'abox_live_status', 'live-stop': 'abox_live_stop',
  'reverse-video': 'abox_video_reverse', 'timelapse-video': 'abox_video_timelapse', 'video-to-gif': 'abox_video_to_gif', 'bake-video-rotation': 'abox_video_rotate_bake',
  'extract-audio': 'abox_audio_extract',
  'compress-video': 'abox_video_compress', 'crop-video': 'abox_video_crop', 'grab-video-frame': 'abox_video_frame',
  'redact-pdf': 'abox_pdf_redact',
  'convert-heic': 'abox_heic_convert', 'convert-avif': 'abox_avif_convert',
  'compress-image': 'abox_image_compress', 'resize-image': 'abox_image_resize', 'convert-image': 'abox_image_convert',
  'split-pdf': 'abox_pdf_split', 'merge-pdf': 'abox_pdf_merge', 'select-pdf-pages': 'abox_pdf_select', 'rotate-pdf': 'abox_pdf_rotate',
  'images-to-pdf': 'abox_images_to_pdf', 'remove-exif': 'abox_exif_remove', 'inspect-exif': 'abox_exif_inspect', 'hash-file': 'abox_file_hash',
  'compress-pdf': 'abox_pdf_compress', 'watermark-pdf': 'abox_pdf_watermark', 'image-to-ico': 'abox_image_to_ico',
  'svg-to-image': 'abox_svg_to_image', 'image-layout': 'abox_image_layout', 'pdf-to-csv': 'abox_pdf_to_csv',
  'format-json': 'abox_json_format', 'base64': 'abox_base64', 'image-to-data-uri': 'abox_image_data_uri',
  'convert-yaml-json': 'abox_yaml_json', 'format-xml': 'abox_xml_format', 'generate-qr': 'abox_qr_generate',
  'generate-barcode': 'abox_barcode_generate', 'diff-text': 'abox_text_diff', 'inspect-gif': 'abox_gif_inspect',
  'split-gif': 'abox_gif_split', 'trace-image': 'abox_image_trace', 'stack-images': 'abox_image_stack',
  'generate-passwords': 'abox_password_generate', 'redact-image': 'abox_image_redact', 'read-code-image': 'abox_code_read',
  'create-gif': 'abox_gif_create', 'protect-pdf': 'abox_pdf_protect', 'unlock-pdf': 'abox_pdf_unlock',
  'edit-audio': 'abox_audio_edit', 'trim-audio': 'abox_audio_trim', 'inspect-video': 'abox_video_inspect',
  'trim-video': 'abox_video_trim', 'join-videos': 'abox_video_join', 'scan-document': 'abox_document_scan',
  'make-id-photo': 'abox_id_photo', 'preview-business-profile': 'abox_business_profile', 'compare-heights': 'abox_height_compare',
  'extract-receipt': 'abox_receipt_extract', 'inspect-dicom': 'abox_dicom_inspect', 'render-dicom': 'abox_dicom_render',
  'images-to-video': 'abox_images_to_video', 'gif-to-mp4': 'abox_gif_to_mp4',
  'edit-exif': 'abox_exif_edit',
  'rotate-video': 'abox_video_rotate', 'remux-video': 'abox_video_remux',
  'format-code': 'abox_code_format', 'convert-xml-json': 'abox_xml_json', 'markdown-to-html': 'abox_markdown_html',
};
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void closeLiveSessions().finally(() => process.exit(event === 'SIGINT' ? 130 : 143)); });

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { request: { type: 'string' }, 'request-file': { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log(`abox capabilities | doctor | ${Object.keys(commands).join(' | ')}\nOperations accept --request <JSON> or --request-file <absolute path>.`);
  } else {
    if (extra.length) throw new AdapterError('INVALID_ARGUMENTS', 'Provide exactly one operation.');
    if (values.request && values['request-file']) throw new AdapterError('INVALID_ARGUMENTS', 'Choose request or request-file, not both.');
    let result;
    if (command === 'doctor') {
      const info = await capabilities();
      const vendor = await verifyVendor();
      result = { ...info, ok: vendor.ok && info.browser.available, vendor, node: process.versions.node };
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'capabilities') {
      result = await capabilities();
    } else {
      const name = commands[command];
      if (!name) throw new AdapterError('UNKNOWN_TOOL', `Unknown command: ${command}`);
      const json = values['request-file'] ? await readFile(localPath(values['request-file']), 'utf8') : values.request;
      if (!json) throw new AdapterError('INVALID_ARGUMENTS', 'Supply operation arguments with --request or --request-file.');
      result = await execute(name, JSON.parse(json));
    }
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.log(JSON.stringify(errorResult(error)));
  process.exitCode = 1;
}
