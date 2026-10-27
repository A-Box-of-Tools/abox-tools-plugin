import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { editExif, MAX_EXIF_EDIT_INPUT_BYTES, MAX_EXIF_EDIT_CONFIG_BYTES } from '../src/exif-edit.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MARK = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-exif-edit-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function crc(bytes) {
  let sum = 0xffffffff;
  for (const byte of bytes) { sum ^= byte; for (let bit = 0; bit < 8; bit++) sum = (sum >>> 1) ^ (sum & 1 ? 0xedb88320 : 0); }
  return (sum ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out;
}
function chunks(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), MARK); const result = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8), end = at + size + 12;
    assert.ok(end <= bytes.length); assert.equal(crc(bytes.subarray(at + 4, end - 4)), bytes.readUInt32BE(end - 4));
    result.push({ type, data: bytes.subarray(at + 8, end - 4) }); at = end;
  }
  return result;
}
function png(exif = null, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([MARK, chunk('IHDR', header), ...(exif ? [chunk('eXIf', exif)] : []),
    chunk('tEXt', Buffer.from('Comment\0Private source annotation')), ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, 20, 40, 60, 128]))), chunk('IEND', Buffer.alloc(0))]);
}

// The fixture's directory offsets and raw values are assembled independently
// of the production TIFF writer, including its thumbnail and opaque maker note.
function tiff(big = false) {
  const u16 = value => { const bytes = Buffer.alloc(2); big ? bytes.writeUInt16BE(value) : bytes.writeUInt16LE(value); return bytes; };
  const u32 = value => { const bytes = Buffer.alloc(4); big ? bytes.writeUInt32BE(value) : bytes.writeUInt32LE(value); return bytes; };
  const thumbnail = Buffer.from([255, 216, 255, 217]);
  const groups = {
    ifd0: [[0x0110, 2, Buffer.from('Private camera\0')], [0x0112, 3, u16(6)], [0x8769, 4, 'exif'], [0x8825, 4, 'gps']],
    exif: [[0x927c, 7, Buffer.from('Private undocumented maker data')], [0x9286, 7, Buffer.from('ASCII\0\0\0Private original comment')], [0xa005, 4, 'interop']],
    gps: [[1, 2, Buffer.from('N\0')], [2, 5, Buffer.concat([u32(33), u32(1), u32(12), u32(1), u32(24), u32(1)])]],
    interop: [[1, 2, Buffer.from('R98\0')]],
    ifd1: [[0x0103, 3, u16(6)], [0x0201, 4, 'thumbnail'], [0x0202, 4, u32(thumbnail.length)]],
  };
  const offsets = {}; let size = 8;
  for (const [name, entries] of Object.entries(groups)) { offsets[name] = size; size += 2 + entries.length * 12 + 4; }
  const out = Buffer.alloc(4096); out.write(big ? 'MM' : 'II'); u16(42).copy(out, 2); u32(8).copy(out, 4);
  const pending = [];
  for (const [name, entries] of Object.entries(groups)) {
    const start = offsets[name]; u16(entries.length).copy(out, start);
    entries.forEach(([tag, type, raw], index) => {
      const at = start + 2 + index * 12; u16(tag).copy(out, at); u16(type).copy(out, at + 2);
      const length = typeof raw === 'string' ? 4 : raw.length, count = length / [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type];
      u32(count).copy(out, at + 4);
      if (typeof raw === 'string') { if (raw === 'thumbnail') pending.push(at + 8); else u32(offsets[raw]).copy(out, at + 8); }
      else if (length <= 4) raw.copy(out, at + 8);
      else { if (size % 2) size++; u32(size).copy(out, at + 8); raw.copy(out, size); size += raw.length; }
    });
    u32(name === 'ifd0' ? offsets.ifd1 : 0).copy(out, start + 2 + entries.length * 12);
  }
  if (size % 2) size++; for (const at of pending) u32(size).copy(out, at); thumbnail.copy(out, size); size += thumbnail.length;
  return out.subarray(0, size);
}
function entries(bytes) {
  const big = bytes.toString('ascii', 0, 2) === 'MM', u16 = at => big ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at),
    u32 = at => big ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at), queue = [['ifd0', u32(4)]], values = new Map(); let thumbnail;
  while (queue.length) {
    const [group, start] = queue.pop(); let thumbAt, thumbLength;
    for (let index = 0; index < u16(start); index++) {
      const at = start + 2 + index * 12, tag = u16(at), type = u16(at + 2), count = u32(at + 4), length = count * [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type],
        raw = bytes.subarray(length <= 4 ? at + 8 : u32(at + 8), (length <= 4 ? at + 8 : u32(at + 8)) + length);
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) queue.push([tag === 0x8769 ? 'exif' : tag === 0x8825 ? 'gps' : 'interop', big ? raw.readUInt32BE() : raw.readUInt32LE()]);
      else if (group === 'ifd1' && tag === 0x0201) thumbAt = big ? raw.readUInt32BE() : raw.readUInt32LE();
      else if (group === 'ifd1' && tag === 0x0202) thumbLength = big ? raw.readUInt32BE() : raw.readUInt32LE();
      else values.set(`${group}:${tag}`, { type, count, raw });
    }
    const next = u32(start + 2 + u16(start) * 12); if (next) queue.push(['ifd1', next]);
    if (thumbAt !== undefined) thumbnail = bytes.subarray(thumbAt, thumbAt + thumbLength);
  }
  return { values, thumbnail, big };
}
async function config(directory, value, name = 'edits.json') { const filename = path.join(directory, name); await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value)); return filename; }

test('EXIF edits preserve untouched raw tags, maker notes, thumbnail, PNG pixels and other private metadata in both byte orders', async t => {
  const directory = await workspace(t);
  for (const big of [false, true]) {
    const input = path.join(directory, `source-${big}.png`), output = path.join(directory, `edited-${big}.png`), originalExif = tiff(big), source = png(originalExif,
      [chunk('zTXt', Buffer.concat([Buffer.from('Compressed\0\0'), deflateSync(Buffer.from('Private compressed annotation'))]))]);
    await writeFile(input, source);
    const edits = await config(directory, { set: [{ group: 'ifd0', tag: 0x0110, value: 'Edited camera' },
      { group: 'exif', tag: 0x9286, value: 'Unicode commentaire 日本語' }, { group: 'ifd0', tag: 0x9c9b, type: 1, value: 'Title 日本語' }], remove: [{ group: 'gps', tag: 2 }] }, `edit-${big}.json`);
    const result = await editExif({ input_path: input, output_path: output, edits_path: edits });
    assert.equal(result.verified, true); assert.equal(result.set_count, 3); assert.equal(result.removed_count, 1);
    assert.equal(result.verification.decoded_pixels, false); assert.equal(result.after.thumbnail_present, true);
    const outputChunks = chunks(await readFile(output)), outputExif = outputChunks.find(item => item.type === 'eXIf').data,
      before = entries(originalExif), after = entries(outputExif);
    assert.equal(after.big, big); assert.deepEqual(after.thumbnail, before.thumbnail);
    for (const [key, value] of before.values) if (!['ifd0:272', 'exif:37510', 'gps:2'].includes(key)) assert.deepEqual(after.values.get(key), value);
    assert.equal(after.values.get('ifd0:272').raw.toString('utf8'), 'Edited camera\0'); assert.equal(after.values.has('gps:2'), false);
    const user = after.values.get('exif:37510').raw; assert.equal(user.toString('ascii', 0, 8), 'UNICODE\0');
    const body = Buffer.from(user.subarray(8)); if (big) body.swap16(); assert.equal(body.toString('utf16le'), 'Unicode commentaire 日本語');
    const title = after.values.get('ifd0:40091').raw; assert.equal(title.subarray(0, -2).toString('utf16le'), 'Title 日本語');
    const untouched = items => items.filter(item => item.type !== 'eXIf').map(item => [item.type, Buffer.from(item.data)]);
    assert.deepEqual(untouched(outputChunks), untouched(chunks(source)));
    assert.deepEqual(inflateSync(outputChunks.find(item => item.type === 'IDAT').data), Buffer.from([0, 20, 40, 60, 128]));
    for (const secret of ['Private camera', 'Unicode commentaire', 'Private source', 'Private undocumented']) assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(hash(await readFile(input)), hash(source));
  }
});

test('new EXIF and numeric values round trip; deleting every tag removes an empty big-endian EXIF block', async t => {
  const directory = await workspace(t), input = path.join(directory, 'plain.png'), output = path.join(directory, 'new.png'); await writeFile(input, png());
  const edits = await config(directory, { set: [{ group: 'ifd0', tag: 0x0112, type: 3, value: '8' },
    { group: 'exif', tag: 0x829a, type: 5, value: '0.125' }, { group: 'exif', tag: 0xc001, type: 11, value: '0.1 2.5' }] });
  const result = await editExif({ input_path: input, output_path: output, edits_path: edits }); assert.equal(result.rounded_numeric_tags, 2);
  const made = entries(chunks(await readFile(output)).find(item => item.type === 'eXIf').data).values;
  assert.equal(made.get('ifd0:274').raw.readUInt16LE(), 8);
  assert.equal(made.get('exif:33434').raw.readUInt32LE() / made.get('exif:33434').raw.readUInt32LE(4), 0.125);
  assert.equal(made.get('exif:49153').raw.readFloatLE(), Math.fround(0.1));
  const empty = Buffer.from('4d4d002a000000080001010e0002000000025800000000000000', 'hex');
  const old = path.join(directory, 'big.png'); await writeFile(old, png(empty));
  const remove = await config(directory, { remove: [{ group: 'ifd0', tag: 0x010e }] }, 'remove.json');
  const cleared = path.join(directory, 'clear.png'); await editExif({ input_path: old, output_path: cleared, edits_path: remove });
  assert.equal(chunks(await readFile(cleared)).some(item => item.type === 'eXIf'), false);
});

test('JPEG scan and WebP compressed payload remain byte-identical through metadata-only edits', async t => {
  const directory = await workspace(t), exif = tiff(), jpegSegment = (marker, data) => {
    const head = Buffer.alloc(4); head[0] = 255; head[1] = marker; head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]);
  };
  // These container fixtures deliberately make no native-decoding claim. The
  // adapter verifies byte preservation rather than certifying source pixels.
  const scan = Buffer.from([255, 218, 0, 2, 12, 34, 255, 0, 56, 255, 217]), jpg = Buffer.concat([Buffer.from([255, 216]),
    jpegSegment(225, Buffer.concat([Buffer.from('Exif\0\0'), exif])), jpegSegment(254, Buffer.from('Private comment')), scan]);
  const webpChunk = (type, data) => { const out = Buffer.alloc(8 + data.length + data.length % 2); out.write(type); out.writeUInt32LE(data.length, 4); data.copy(out, 8); return out; };
  const bits = Buffer.from([0x2f, 0, 0, 0, 0]), body = Buffer.concat([Buffer.from('WEBP'), webpChunk('VP8L', bits)]), webp = Buffer.alloc(body.length + 8);
  webp.write('RIFF'); webp.writeUInt32LE(body.length, 4); body.copy(webp, 8);
  const edits = await config(directory, { set: [{ group: 'ifd0', tag: 0x010e, type: 2, value: 'New description' }] });
  for (const [extension, bytes] of [['jpg', jpg], ['webp', webp]]) {
    const input = path.join(directory, `source.${extension}`), output = path.join(directory, `edited.${extension}`); await writeFile(input, bytes);
    const result = await editExif({ input_path: input, output_path: output, edits_path: edits }), saved = await readFile(output);
    assert.equal(result.verified, true); assert.equal(result.verification.compressed_picture_bytes, true); assert.equal(result.verification.decoded_pixels, false);
    if (extension === 'jpg') assert.deepEqual(saved.subarray(-scan.length), scan);
    else { const at = saved.indexOf(Buffer.from('VP8L')); assert.ok(at > 0); assert.deepEqual(saved.subarray(at + 8, at + 13), bits); assert.ok(saved.includes(Buffer.from('VP8X'))); }
    assert.deepEqual(await readFile(input), bytes);
  }
});

test('config grammar, range, pointer and unsupported tag encodings fail without exposing private values', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'); await writeFile(input, png(tiff()));
  const bad = [null, {}, { set: null }, { extra: [] }, { set: [{ group: 'ifd0', tag: 0x010e, value: 'PRIVATE' }] },
    { set: [{ group: 'ifd0', tag: 0x0110, type: 3, value: 'PRIVATE' }] }, { remove: [{ group: 'ifd0', tag: 0x8769 }] },
    { set: [{ group: 'ifd0', tag: 0x0112, value: '9' }] }, { set: [{ group: 'ifd0', tag: 0x0112, value: '6 7' }] },
    { set: [{ group: 'ifd0', tag: 0xc010, type: 3, value: '65536' }] }, { set: [{ group: 'ifd0', tag: 0xc010, type: 3, value: '1.5' }] },
    { set: [{ group: 'exif', tag: 0x927c, value: 'PRIVATE' }] }, { set: [{ group: 'ifd0', tag: 0x0110, value: '日本語' }] },
    { set: [{ group: 'ifd0', tag: 0x0110, value: '\ud800' }] }, { set: [{ group: 'ifd0', tag: 0x0110, value: 'Private\0' }] },
    { set: [{ group: 'exif', tag: 0xc010, type: 5, value: '-1' }] }, { set: [{ group: 'exif', tag: 0xc010, type: 11, value: '1e99' }] },
    { set: Array.from({ length: 65 }, (_, index) => ({ group: 'ifd0', tag: index + 1, type: 2, value: 'PRIVATE' })) },
    { set: [{ group: 'ifd0', tag: 0x0110, value: 'PRIVATE' }], remove: [{ group: 'ifd0', tag: 0x0110 }] }];
  for (const [index, value] of bad.entries()) {
    const edits = await config(directory, value), output = path.join(directory, `bad-${index}.png`);
    await assert.rejects(editExif({ input_path: input, output_path: output, edits_path: edits }), error => {
      assert.equal(error.code, 'EXIF_EDIT_CONFIG'); assert.ok(!error.message.includes('PRIVATE')); return true;
    }); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  for (const source of ['{"set":[],"set":[]}', '['.repeat(2000) + '0' + ']'.repeat(2000), Buffer.from([0xff, 0xfe])]) {
    const edits = path.join(directory, 'bad.json'); await writeFile(edits, source);
    await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, 'no.png'), edits_path: edits }), { code: 'EXIF_EDIT_CONFIG' });
  }
  const remove = await config(directory, { remove: [{ group: 'gps', tag: 99 }] });
  await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, 'none.png'), edits_path: remove }), { code: 'EXIF_TAG_MISSING' });
});

test('malformed EXIF and bounded compressed metadata are refused before source recursion or inflate', async t => {
  const directory = await workspace(t), edits = await config(directory, { set: [{ group: 'ifd0', tag: 0x0110, value: 'Edited' }] });
  const cases = [];
  const cycle = Buffer.alloc(26); cycle.write('II'); cycle.writeUInt16LE(42, 2); cycle.writeUInt32LE(8, 4); cycle.writeUInt16LE(1, 8);
  cycle.writeUInt16LE(0x8769, 10); cycle.writeUInt16LE(4, 12); cycle.writeUInt32LE(1, 14); cycle.writeUInt32LE(8, 18); cases.push(png(cycle));
  const duplicate = Buffer.from(tiff()); duplicate.writeUInt16LE(0x0110, 22); cases.push(png(duplicate));
  const unknown = Buffer.from(tiff()); unknown.writeUInt16LE(99, 12); cases.push(png(unknown));
  const missing = Buffer.from(tiff()); missing.writeUInt32LE(999999, 18); cases.push(png(missing));
  cases.push(png(tiff(), [chunk('eXIf', tiff())]), Buffer.concat([png(tiff()), Buffer.from('trailing')]));
  const brokenCrc = png(tiff()); brokenCrc[brokenCrc.length - 1] ^= 1; cases.push(brokenCrc);
  for (const [index, source] of cases.entries()) {
    const input = path.join(directory, `bad-${index}.png`); await writeFile(input, source);
    await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, `out-${index}.png`), edits_path: edits }), { code: 'INVALID_EXIF_IMAGE' });
  }
  for (const [name, source, code] of [
    ['bomb', png(tiff(), [chunk('zTXt', Buffer.concat([Buffer.from('Private\0\0'), deflateSync(Buffer.alloc(65537))]))]), 'EXIF_EDIT_LIMIT'],
    ['large-exif', png(Buffer.alloc(65528)), 'EXIF_EDIT_LIMIT'],
    ['animated', png(tiff(), [chunk('acTL', Buffer.alloc(8))]), 'ANIMATED_IMAGE'],
  ]) {
    const input = path.join(directory, `${name}.png`), output = path.join(directory, `${name}-out.png`); await writeFile(input, source);
    await assert.rejects(editExif({ input_path: input, output_path: output, edits_path: edits }), { code }); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('local paths, exclusive output, input/config caps and in-flight cancellation preserve every source', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), output = path.join(directory, 'out.png'), source = png(tiff()); await writeFile(input, source);
  const edits = await config(directory, '\ufeff' + JSON.stringify({ set: [{ group: 'ifd0', tag: 0x0110, value: 'Edited' }] }));
  await writeFile(output, 'existing'); await assert.rejects(editExif({ input_path: input, output_path: output, edits_path: edits }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'existing');
  await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, 'new.jpg'), edits_path: edits }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, 'new.png'), edits_path: 'relative.json' }), { code: 'LOCAL_PATH_REQUIRED' });
  for (const [name, size, field] of [['large.png', MAX_EXIF_EDIT_INPUT_BYTES, 'input_path'], ['large.json', MAX_EXIF_EDIT_CONFIG_BYTES, 'edits_path']]) {
    const filename = path.join(directory, name), file = await open(filename, 'w'); await file.truncate(size + 1); await file.close();
    await assert.rejects(editExif({ input_path: input, output_path: path.join(directory, 'limit.png'), edits_path: edits, [field]: filename }), { code: 'INPUT_SIZE' });
  }
  await assert.rejects(editExif({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), cancelled = path.join(directory, 'cancel.png'), pending = editExif({ input_path: input, output_path: cancelled, edits_path: edits }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(cancelled), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
});
