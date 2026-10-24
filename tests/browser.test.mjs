import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withBrowser } from '../src/browser.mjs';
import { execute } from '../src/tools.mjs';
import { readBytes, serialize } from '../vendor/abox/tools/exif-editor/src/container.js';
import { serializeExif, createEntry } from '../vendor/abox/tools/exif-editor/src/tiff.js';

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-browser-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixtures() {
  return withBrowser(async page => page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 12345;
    for (let at = 0; at < pixels.data.length; at += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[at + channel] = seed >>> 24;
      }
      pixels.data[at + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const data = {};
    for (const format of ['jpeg', 'png', 'webp']) data[format] = canvas.toDataURL(`image/${format}`, 0.98).split(',')[1];
    const blocked = await fetch('https://example.com/abox-egress-probe', { method: 'POST', body: 'probe' }).then(() => false, () => true);
    return { data, blocked, offline: !navigator.onLine };
  }));
}

function imagePayload(item) {
  if (item.kind === 'jpeg') return Buffer.from(item.doc.scan);
  const names = item.kind === 'png' ? ['IDAT'] : ['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF'];
  return Buffer.concat(item.doc.chunks.filter(chunk => names.includes(chunk.type ?? chunk.fourcc)).map(chunk => Buffer.from(chunk.data)));
}

test('local browser compresses real images, verifies limits, and strips metadata without rewriting image payloads', { timeout: 180000 }, async t => {
  const root = await workspace(t);
  const generated = await fixtures();
  assert.equal(generated.blocked, true, 'remote requests must be blocked');
  assert.equal(generated.offline, true, 'the processing context must operate offline');
  const png = path.join(root, 'source.png');
  const original = Buffer.from(generated.data.png, 'base64');
  await writeFile(png, original);
  const compressed = await execute('abox_image_compress', {
    input_path: png, output_path: path.join(root, 'compressed.jpg'), target_bytes: 30000, format: 'jpeg',
  });
  assert.equal(compressed.verified, true);
  assert.equal(compressed.fitted, true);
  assert.ok(compressed.output_bytes <= 30000);
  assert.ok(compressed.width > 0 && compressed.height > 0);
  assert.ok(compressed.encodes > 0);
  assert.equal((await readBytes(new Uint8Array(await readFile(compressed.output_path)))).kind, 'jpeg');
  assert.deepEqual(await readFile(png), original);

  const copied = await execute('abox_image_compress', {
    input_path: png, output_path: path.join(root, 'untouched.png'), target_bytes: original.length + 1,
  });
  assert.equal(copied.untouched, true);
  assert.deepEqual(await readFile(copied.output_path), original);

  const missed = await execute('abox_image_compress', {
    input_path: png, output_path: path.join(root, 'missed.png'), target_bytes: 1, format: 'png', allow_resize: false,
  });
  assert.equal(missed.fitted, false);
  assert.ok(missed.output_bytes > 1);
  assert.ok(missed.warnings.length);

  const auto = await execute('abox_image_compress', {
    input_path: png, output_path: path.join(root, 'automatic.jpg'), target_bytes: 30000, format: 'auto',
  });
  assert.equal(auto.fitted, true);
  assert.equal(path.extname(auto.output_path), { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[auto.mime]);

  for (const [kind, encoded] of Object.entries(generated.data)) {
    const extension = kind === 'jpeg' ? 'jpg' : kind;
    const data = Buffer.from(encoded, 'base64');
    const image = await readBytes(new Uint8Array(data));
    const exif = serializeExif({ littleEndian: true, groups: {
      ifd0: [createEntry(0x0112, 3, '6', true), createEntry(0x0110, 2, 'Private camera', true)],
      exif: [], gps: [], interop: [], ifd1: [],
    }, thumbnail: null });
    const privateBytes = serialize(image, { exif, xmp: '<x:xmpmeta>Private information</x:xmpmeta>' });
    const input = path.join(root, `private.${extension}`);
    const output = path.join(root, `clean.${extension}`);
    await writeFile(input, privateBytes);
    const cleaned = await execute('abox_exif_remove', { input_path: input, output_path: output, keep_orientation: false, keep_icc: false });
    assert.equal(cleaned.after.exif_present, false);
    assert.equal(cleaned.after.xmp_present, false);
    const reread = await readBytes(new Uint8Array(await readFile(output)));
    assert.deepEqual(imagePayload(reread), imagePayload(await readBytes(privateBytes)));
    await withBrowser(async page => {
      await page.locator('#input').setInputFiles(output);
      const size = await page.evaluate(async () => {
        const bitmap = await createImageBitmap(document.querySelector('#input').files[0]);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      });
      assert.deepEqual(size, { width: 640, height: 480 });
    });
    assert.deepEqual(await readFile(input), Buffer.from(privateBytes));
  }

  const bogus = path.join(root, 'bogus.png');
  await writeFile(bogus, Buffer.from('not an image'));
  const unused = path.join(root, 'unused.png');
  await assert.rejects(execute('abox_image_compress', { input_path: bogus, output_path: unused, target_bytes: 100 }), { code: 'UNSUPPORTED_IMAGE' });
  await assert.rejects(stat(unused), { code: 'ENOENT' });
});
