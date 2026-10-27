import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, stat, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { imageToDataUri, MAX_DATA_URI_INPUT_BYTES } from '../src/data-uri.mjs';

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-data-uri-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function crc32(data) {
  let n = 0xffffffff;
  for (const byte of data) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0PRIVATE-URI-PAYLOAD')), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('data URI encoding independently round-trips original image bytes and reports metadata without values', async t => {
  const root = await workspace(t), input = path.join(root, 'Logo Final (2).renamed');
  const original = png(); await writeFile(input, original);
  const output = path.join(root, 'image.txt');
  const result = await imageToDataUri({ input_path: input, output_path: output });
  const text = await readFile(output, 'utf8');
  assert.equal(text, `data:image/png;base64,${original.toString('base64')}\n`);
  assert.deepEqual(Buffer.from(text.trim().split(',')[1], 'base64'), original);
  assert.equal(result.mime, 'image/png'); assert.equal(result.encoding, 'base64');
  assert.equal(result.metadata.inspected, true); assert.equal(result.metadata.present, true);
  assert.deepEqual(result.metadata.kinds, ['text']); assert.ok(result.metadata.bytes > 0);
  assert.equal(result.bytes_preserved, true); assert.equal(result.verified, true);
  assert.equal(result.image_decode_verified, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-URI-PAYLOAD'));
  assert.ok(!JSON.stringify(result).includes(original.toString('base64')));
  assert.deepEqual(await readFile(input), original);
});

test('data URI shapes produce usable escaped CSS, HTML and Markdown envelopes', async t => {
  const root = await workspace(t), input = path.join(root, '12 My Logo.png');
  const original = png(); await writeFile(input, original);
  const uri = `data:image/png;base64,${original.toString('base64')}`;
  const expected = {
    'css-rule': ['.css', `.img-12-my-logo {\n  background-image: url("${uri}");\n}\n`],
    'css-var': ['.css', `:root {\n  --img-12-my-logo: url("${uri}");\n}\n`],
    html: ['.html', `<img src="${uri}" alt="">\n`], markdown: ['.md', `![](${uri})\n`],
  };
  for (const [shape, [extension, text]] of Object.entries(expected)) {
    const output = path.join(root, `embed-${shape}${extension}`);
    const result = await imageToDataUri({ input_path: input, output_path: output, shape });
    assert.equal(await readFile(output, 'utf8'), text);
    assert.equal(result.output_bytes, Buffer.byteLength(text));
  }
  const output = path.join(root, 'named.css');
  await imageToDataUri({ input_path: input, output_path: output, shape: 'css-rule', identifier: '_logo-1' });
  assert.ok((await readFile(output, 'utf8')).startsWith('._logo-1 {'));
});

test('SVG readable encoding preserves UTF-8 BOM, Unicode, quotes and whitespace; Markdown and non-UTF8 use exact Base64', async t => {
  const root = await workspace(t);
  const svg = '\ufeff<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\n<text>PRIVATE-URI-PAYLOAD 😀 50% # (x)</text></svg>';
  const bytes = Buffer.from(svg), input = path.join(root, 'vector.svg'); await writeFile(input, bytes);
  const output = path.join(root, 'vector.txt');
  const result = await imageToDataUri({ input_path: input, output_path: output });
  const text = await readFile(output, 'utf8');
  assert.ok(text.startsWith('data:image/svg+xml,')); assert.equal(result.encoding, 'percent');
  assert.deepEqual(Buffer.from(decodeURIComponent(text.trimEnd().split(',').slice(1).join(','))), bytes);
  assert.ok(!text.includes('<svg')); assert.ok(!text.includes('😀')); assert.ok(text.includes('%23'));
  assert.equal(result.metadata.inspected, false); assert.equal(result.metadata.present, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-URI-PAYLOAD'));
  for (const [shape, extension, encoding] of [['markdown', '.md', 'auto'], ['uri', '.txt', 'base64']]) {
    const filename = path.join(root, `${shape}-base64${extension}`);
    const made = await imageToDataUri({ input_path: input, output_path: filename, shape, svg_encoding: encoding });
    assert.equal(made.encoding, 'base64');
    assert.ok((await readFile(filename, 'utf8')).includes(`data:image/svg+xml;base64,${bytes.toString('base64')}`));
  }
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from(svg.slice(1), 'utf16le')]);
  const wideInput = path.join(root, 'wide.svg'); await writeFile(wideInput, utf16);
  const wideOutput = path.join(root, 'wide.txt');
  const wide = await imageToDataUri({ input_path: wideInput, output_path: wideOutput });
  assert.equal(wide.encoding, 'base64');
  assert.equal(await readFile(wideOutput, 'utf8'), `data:image/svg+xml;base64,${utf16.toString('base64')}\n`);
  assert.deepEqual(await readFile(input), bytes);
});

test('signature recognition is explicit about rendering and unknown or malformed metadata', async t => {
  const root = await workspace(t);
  for (const [name, bytes, mime] of [
    ['tiny.tif', Buffer.from([0x49, 0x49, 0x2a, 0]), 'image/tiff'],
    ['tiny.gif', Buffer.from('GIF89a'), 'image/gif'],
    ['malformed.png', Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('tEXt', Buffer.alloc(0)).subarray(0, 12).map((b, i) => i < 4 ? 255 : b)]), 'image/png'],
  ]) {
    const input = path.join(root, name); await writeFile(input, bytes);
    const result = await imageToDataUri({ input_path: input, output_path: `${input}.txt` });
    assert.equal(result.mime, mime); assert.equal(result.metadata.inspected, false);
    assert.equal(result.image_decode_verified, false);
  }
});

test('SVG envelopes retain bytes after HTML entity, CSS string and Markdown destination interpretation', async t => {
  const root = await workspace(t), input = path.join(root, 'escaping.svg');
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>one &amp; two \\41 (x)</text></svg>');
  await writeFile(input, source);
  const htmlDecode = text => text.replace(/&(amp|quot|lt|gt|apos);/g, (_, key) => ({ amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" })[key]);
  const cssDecode = text => text.replace(/\\([0-9a-f]{1,6})(?:\r\n|\s)?|\\([^\r\n])/gi,
    (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16)) : char);
  for (const [shape, extension] of [['html', '.html'], ['css-rule', '.css'], ['css-var', '.css'], ['markdown', '.md']]) {
    const output = path.join(root, `${shape}${extension}`);
    const made = await imageToDataUri({ input_path: input, output_path: output, shape });
    const text = await readFile(output, 'utf8');
    const uri = shape === 'html' ? htmlDecode(/src="([^"]+)"/.exec(text)[1])
      : shape === 'markdown' ? /^!\[\]\(([^\s()]+)\)\n$/.exec(text)[1]
        : cssDecode(/url\("((?:\\.|[^"\\])*)"\)/.exec(text)[1]);
    assert.equal(made.encoding, 'base64');
    assert.deepEqual(Buffer.from(await (await fetch(uri)).arrayBuffer()), source);
  }
});

test('data URI operations enforce paths, bounds, settings, exclusive outputs and cancellation', async t => {
  const root = await workspace(t), input = path.join(root, 'source.png'); await writeFile(input, png());
  const output = path.join(root, 'existing.txt'); await writeFile(output, 'keep');
  await assert.rejects(imageToDataUri({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep');
  for (const args of [{ shape: 'other' }, { svg_encoding: 'percent' }, { identifier: 'x" onload="bad' }, { identifier: 'a'.repeat(65) }]) {
    await assert.rejects(imageToDataUri({ input_path: input, output_path: path.join(root, 'unused.txt'), ...args }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(imageToDataUri({ input_path: input, output_path: path.join(root, 'wrong.html') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(imageToDataUri({ input_path: 'https://example.com/source.png', output_path: path.join(root, 'unused.txt') }), { code: 'LOCAL_PATH_REQUIRED' });
  const huge = path.join(root, 'huge.png'), file = await open(huge, 'wx');
  try { await file.truncate(MAX_DATA_URI_INPUT_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(imageToDataUri({ input_path: huge, output_path: path.join(root, 'large.txt') }), { code: 'INPUT_SIZE' });
  const unknown = path.join(root, 'unknown.png'); await writeFile(unknown, 'PRIVATE-URI-PAYLOAD');
  await assert.rejects(imageToDataUri({ input_path: unknown, output_path: path.join(root, 'unknown.txt') }), error => {
    assert.equal(error.code, 'UNSUPPORTED_IMAGE'); assert.ok(!error.message.includes('PRIVATE')); return true;
  });
  const cancelled = path.join(root, 'cancelled.txt');
  await assert.rejects(imageToDataUri({ input_path: input, output_path: cancelled }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), promise = imageToDataUri({ input_path: input, output_path: cancelled }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(promise, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
});
