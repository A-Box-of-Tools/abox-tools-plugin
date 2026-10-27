#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { execute, capabilities } from '../src/tools.mjs';
import { errorResult, AdapterError } from '../src/errors.mjs';
import { verifyVendor } from '../scripts/verify-vendor.mjs';
import { localPath } from '../src/files.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { request: { type: 'string' }, 'request-file': { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log('abox capabilities | doctor | compress-image | resize-image | convert-image | split-pdf | merge-pdf | select-pdf-pages | rotate-pdf | images-to-pdf | inspect-exif | remove-exif | hash-file | compress-pdf | watermark-pdf | image-to-ico | svg-to-image | image-layout | pdf-to-csv | format-json | base64\nOperations accept --request <JSON> or --request-file <absolute path>.');
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
      const name = {
        'compress-image': 'abox_image_compress', 'resize-image': 'abox_image_resize',
        'convert-image': 'abox_image_convert', 'split-pdf': 'abox_pdf_split',
        'merge-pdf': 'abox_pdf_merge', 'select-pdf-pages': 'abox_pdf_select',
        'remove-exif': 'abox_exif_remove',
        'inspect-exif': 'abox_exif_inspect', 'hash-file': 'abox_file_hash',
        'rotate-pdf': 'abox_pdf_rotate', 'images-to-pdf': 'abox_images_to_pdf',
        'compress-pdf': 'abox_pdf_compress', 'watermark-pdf': 'abox_pdf_watermark',
        'image-to-ico': 'abox_image_to_ico', 'svg-to-image': 'abox_svg_to_image',
        'image-layout': 'abox_image_layout', 'pdf-to-csv': 'abox_pdf_to_csv',
        'format-json': 'abox_json_format', 'base64': 'abox_base64',
      }[command];
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
