import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { PdfDocument } from '../vendor/abox/shared/js/pdf-reader.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';
import { readPages } from '../vendor/abox/shared/js/pdf-pages.js';
import { withBrowser } from '../src/browser.mjs';
import { redactionFixture, redactionRegions } from '../tests/fixtures/pdf-raster-redaction.mjs';
import { jpegDicomFixture } from '../tests/fixtures/dicom-lossless.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const secrets = ['PRIVATE TEXT SECRET', 'PRIVATE SOURCE TITLE', 'PRIVATE SOURCE AUTHOR', 'PRIVATE XML METADATA',
  'PRIVATE EMBEDDED ORIGINAL FILE', 'PRIVATE ANNOTATION', 'PRIVATE^PATIENT', 'PRIVATE-PATIENT-ID', '19801231', '1.2.826.0.1.3680043.10.999.123'];
function privateSummary(result) {
  const text = JSON.stringify(result);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Private document contents reached an MCP summary.');
  const pending = [result];
  while (pending.length) {
    const value = pending.pop(); if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['data', 'pixels', 'samples', 'raw_tags', 'patient_name', 'patient_id', 'study_instance_uid', 'regions'].includes(key), 'A document payload reached an MCP summary.');
      pending.push(child);
    }
  }
}

async function pngPixels(filename) {
  const bytes = await readFile(filename);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 2); assert.equal(bytes.readUInt32BE(20), 2);
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'technical-preview.png', mimeType: 'image/png', buffer: bytes });
    return page.evaluate(async () => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]), canvas = document.createElement('canvas');
      try {
        if (bitmap.width !== 2 || bitmap.height !== 2) throw new Error('Unexpected technical preview dimensions.');
        canvas.width = canvas.height = 2; const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0);
        return Array.from(context.getImageData(0, 0, 2, 2).data);
      } finally { bitmap.close(); canvas.width = canvas.height = 0; }
    });
  });
}

// A caller supplies the already-connected packaged MCP client. Fixture creation
// and independent output inspection remain in the release-check process.
export async function smokeDocumentGaps({ run, workspace }) {
  assert.equal(typeof run, 'function'); const covered = new Set(), sources = new Map(), local = name => path.join(workspace, name);
  const source = async (name, bytes) => {
    const filename = local(name); await writeFile(filename, bytes, { flag: 'wx' }); sources.set(filename, hash(bytes)); return filename;
  };
  const invoke = async (name, args) => { const result = await run(name, args); covered.add(name); assert.equal(result.ok, true); privateSummary(result); return result; };

  const pdfBytes = await redactionFixture({ pages: 2 }), pdfInput = await source('document gap source.pdf', pdfBytes),
    config = redactionRegions(2), configPath = await source('document gap regions.json', Buffer.from(JSON.stringify(config))), pdfOutput = local('document gap redacted.pdf');
  const redacted = await invoke('abox_pdf_redact', { input_path: pdfInput, output_path: pdfOutput, regions_path: configPath, dpi: 72 });
  assert.equal(redacted.verified, true); assert.equal(redacted.page_count, 2); assert.equal(redacted.searchable_text, false);
  assert.equal(redacted.verification.original_objects_copied, false); assert.equal(redacted.verification.new_image_only_object_graph, true);
  assert.equal(redacted.verification.exact_stored_rgb_pixels, true);
  const saved = await readFile(pdfOutput), document = await PdfDocument.open(Uint8Array.from(saved)), pages = readPages(document);
  assert.equal(pages.length, 2); assert.equal(document.objects.size, 8); assert.equal(document.trailer.has('Info'), false);
  assert.deepEqual([...document.catalog.keys()].sort(), ['Pages', 'Type']);
  for (const secret of secrets) assert.ok(!saved.includes(Buffer.from(secret)), 'An original document secret was copied into the new PDF.');
  for (const [index, page] of pages.entries()) {
    assert.deepEqual([...page.dict.keys()].sort(), ['Contents', 'MediaBox', 'Parent', 'Resources', 'Type']);
    const resources = page.dict.get('Resources'); assert.deepEqual([...resources.keys()], ['XObject']);
    const objects = resources.get('XObject'); assert.deepEqual([...objects.keys()], ['Im0']);
    const image = document.resolve(objects.get('Im0')), content = document.resolve(page.dict.get('Contents'));
    assert.ok(image instanceof PdfStream); assert.ok(content instanceof PdfStream);
    assert.equal(image.dict.get('Subtype')?.value, 'Image'); assert.equal(image.dict.get('ColorSpace')?.value, 'DeviceRGB');
    assert.equal(image.dict.get('Width'), 100); assert.equal(image.dict.get('Height'), 80); assert.equal(image.dict.get('BitsPerComponent'), 8);
    assert.equal(image.dict.get('Filter')?.value, 'FlateDecode'); assert.equal(Buffer.from(content.raw).toString('latin1'), 'q\n100 0 0 80 0 0 cm\n/Im0 Do\nQ\n');
    const rgb = inflateSync(image.raw, { maxOutputLength: 100 * 80 * 3 }); assert.equal(rgb.length, 100 * 80 * 3);
    const color = (x, y) => Array.from(rgb.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)), region = config.pages[index].regions[0];
    for (let y = region.y - 1; y < region.y + region.height + 1; y++) for (let x = region.x - 1; x < region.x + region.width + 1; x++) assert.deepEqual(color(x, y), [0, 0, 0]);
    assert.deepEqual(color(10, 10), [255, 0, 0]); assert.deepEqual(color(90, 10), [0, 0, 255]);
  }

  for (const [index, settings] of [{ uid: '1.2.840.10008.1.2.4.70', predictor: 1 }, { uid: '1.2.840.10008.1.2.4.57', predictor: 7 }].entries()) {
    const input = await source(`document gap lossless-${index}.dcm`, jpegDicomFixture(settings)), output = local(`document gap preview-${index}.png`);
    const inspected = await invoke('abox_dicom_inspect', { input_path: input });
    assert.equal(inspected.compression, 'jpeg-lossless'); assert.equal(inspected.verified, false); assert.equal(inspected.verification.decoded_pixels, false);
    const rendered = await invoke('abox_dicom_render', { input_path: input, output_path: output, window_center: 150, window_width: 301 });
    assert.equal(rendered.verified, true); assert.equal(rendered.compression, 'jpeg-lossless');
    assert.equal(rendered.verification.compressed_stream, true); assert.equal(rendered.verification.stored_samples_checked, 4);
    assert.equal(rendered.verification.native_samples_checked, 0); assert.equal(rendered.verification.png_pixels_checked, 4);
    assert.deepEqual(await pngPixels(output), [0, 85, 170, 255].flatMap(value => [value, value, value, 255]));
  }
  for (const [filename, expected] of sources) assert.equal(hash(await readFile(filename)), expected, 'A document smoke source changed.');
  assert.deepEqual([...covered].sort(), ['abox_dicom_inspect', 'abox_dicom_render', 'abox_pdf_redact']);
  return [...covered];
}
