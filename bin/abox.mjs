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
    console.log('abox capabilities | doctor | compress-image | split-pdf | remove-exif\nOperations accept --request <JSON> or --request-file <absolute path>.');
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
      const name = { 'compress-image': 'abox_image_compress', 'split-pdf': 'abox_pdf_split', 'remove-exif': 'abox_exif_remove' }[command];
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
