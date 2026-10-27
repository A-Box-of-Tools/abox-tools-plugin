import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { mp4aSampleEntry } from '../vendor/abox/shared/js/aac.js';
import { box } from '../vendor/abox/shared/js/mp4-boxes.js';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { preflightMp4, MAX_VIDEO_INPUT_BYTES } from '../src/video-copy.mjs';
import { rotateVideo, remuxVideo } from '../src/video-rotate.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-transform-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function matrix(rotation, width = 16, height = 24, zero = false) {
  const affine = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, height, 0], 180: [-1, 0, 0, -1, width, height], 270: [0, -1, 1, 0, 0, width] }[rotation];
  const [a, b, c, d, x, y] = affine, out = Buffer.alloc(36);
  [a * 65536, b * 65536, 0, c * 65536, d * 65536, 0, zero ? 0 : x * 65536, zero ? 0 : y * 65536, 0x40000000]
    .forEach((value, index) => out.writeInt32BE(value, index * 4)); return out;
}
async function fixture({ rotation = 0, zero = false, audio = true, reorder = true, shift = 0, soundType = 'aac', aspect = null, width = 16, trackWidth = width * 65536, edited = false } = {}) {
  const writer = new Mp4Writer(), avc = Buffer.from(avcSampleEntry(width, 24, Uint8Array.from([1, 66, 0, 30, 255])));
  let entry = avc;
  if (aspect) { entry = Buffer.concat([avc, aspect]); entry.writeUInt32BE(entry.length); }
  const track = writer.addTrack({ kind: 'vide', timescale: 1000, sampleEntry: entry, matrix: matrix(rotation, width, 24, zero), width: trackWidth, height: 24 * 65536 });
  for (let index = 0; index < 4; index++) track.addSample({ data: Uint8Array.from([10, index, 255, 0, 37]),
    dts: index * 1000, pts: (reorder ? [0, 2000, 1000, 3000][index] : index * 1000) + shift, duration: 1000, isKey: index === 0 });
  if (edited) track.addEdit(1000, 3000);
  if (audio) {
    let sampleEntry = mp4aSampleEntry({ channels: 2, sampleRate: 48000, asc: Uint8Array.from([0x11, 0x90]) });
    if (soundType !== 'aac') { sampleEntry = Uint8Array.from(sampleEntry); sampleEntry.set(Buffer.from('alac'), 4); }
    const sound = writer.addTrack({ kind: 'soun', timescale: 48000, sampleEntry });
    for (let index = 0; index < 4; index++) sound.addSample({ data: Uint8Array.from([20, index, 77]), dts: index * 48000, pts: index * 48000, duration: 48000, isKey: true });
  }
  return Buffer.from(await writer.finalize().arrayBuffer());
}
const read = bytes => demux(new File([bytes], 'local.mp4'), { timeline: 'media' });
function packetFacts(bytes, track) {
  return track.samples.map((sample, index) => ({ bytes: Buffer.from(bytes.subarray(sample.offset, sample.offset + sample.size)),
    dts: sample.dts, pts: sample.pts, key: sample.isKey, duration: (track.samples[index + 1]?.dts ?? track.duration) - sample.dts }));
}

test('copy-only rotation composes every quarter turn and preserves descriptions, reordered clocks and exact video/AAC packets', async t => {
  const directory = await workspace(t);
  for (const start of [0, 90, 180, 270]) for (const degrees of [90, 180, 270]) {
    const bytes = await fixture({ rotation: start, zero: start === 270 }), input = path.join(directory, `source-${start}-${degrees}.mov`), output = path.join(directory, `turn-${start}-${degrees}.mp4`);
    await writeFile(input, bytes); const result = await rotateVideo({ input_path: input, output_path: output, degrees });
    assert.equal(result.verified, true); assert.equal(result.reencoded, false); assert.equal(result.verification.decoding, false); assert.equal(result.audio_copied, true);
    const expected = (start + degrees) % 360, saved = await readFile(output), before = await read(bytes), after = await read(saved);
    assert.equal(after.video.rotation, expected); assert.deepEqual(Buffer.from(after.video.matrix), matrix(expected));
    assert.equal(after.video.trackWidth, 16 * 65536); assert.equal(after.video.trackHeight, 24 * 65536);
    assert.deepEqual([result.width, result.height], expected % 180 ? [24, 16] : [16, 24]);
    assert.deepEqual(packetFacts(saved, after.video), packetFacts(bytes, before.video)); assert.deepEqual(packetFacts(saved, after.audio), packetFacts(bytes, before.audio));
    assert.deepEqual(after.video.sampleEntry, before.video.sampleEntry); assert.deepEqual(after.audio.sampleEntry, before.audio.sampleEntry);
    assert.equal(after.video.timescale, 1000); assert.equal(after.video.duration, 4000); assert.deepEqual(preflightMp4(saved).edits, []);
    assert.equal(hash(await readFile(input)), hash(bytes));
  }
});

test('H.264 remux preserves the original exact orientation and clocks; explicit audio omission is verified on both routes', async t => {
  const directory = await workspace(t), bytes = await fixture({ rotation: 270, zero: true }), input = path.join(directory, 'source.m4v'); await writeFile(input, bytes);
  const before = await read(bytes), output = path.join(directory, 'remuxed.mp4'), result = await remuxVideo({ input_path: input, output_path: output });
  const saved = await readFile(output), after = await read(saved); assert.equal(result.verified, true); assert.equal(result.reencoded, false);
  assert.deepEqual(after.video.matrix, before.video.matrix); assert.deepEqual(after.video.sampleEntry, before.video.sampleEntry);
  assert.deepEqual(packetFacts(saved, after.video), packetFacts(bytes, before.video)); assert.deepEqual(packetFacts(saved, after.audio), packetFacts(bytes, before.audio));
  assert.deepEqual([result.width, result.height], [24, 16]); assert.equal(result.duration_seconds, 4);
  const unsupported = path.join(directory, 'alac.mov'), encoded = await fixture({ soundType: 'alac' }); await writeFile(unsupported, encoded);
  for (const [index, operation] of [rotateVideo, remuxVideo].entries()) {
    const destination = path.join(directory, `silent-${index}.mp4`);
    await assert.rejects(operation({ input_path: unsupported, output_path: destination }), { code: 'VIDEO_AUDIO_COPY_UNSUPPORTED' });
    const made = await operation({ input_path: unsupported, output_path: destination, keep_audio: false }), checked = await read(await readFile(destination));
    assert.equal(checked.audio, null); assert.equal(made.audio_samples, 0); assert.equal(made.audio_copied, false);
  }
});

test('unsupported transforms, aspect crops, start normalization and edited timelines fail closed before copying', async t => {
  const directory = await workspace(t), valid = await fixture({ audio: false }), malformed = Buffer.from(valid), tkhd = malformed.indexOf(Buffer.from('tkhd'));
  const size = malformed.readUInt32BE(tkhd - 4), matrixAt = tkhd - 4 + size - 44; malformed.writeInt32BE(2 * 65536, matrixAt);
  const pasp = Buffer.alloc(8); pasp.writeUInt32BE(2); pasp.writeUInt32BE(1, 4);
  const cases = [[malformed, 'UNSUPPORTED_VIDEO_MATRIX'], [await fixture({ trackWidth: 32 * 65536 }), 'UNSUPPORTED_VIDEO_MATRIX'],
    [await fixture({ aspect: box('pasp', pasp) }), 'UNSUPPORTED_VIDEO_MATRIX'], [await fixture({ aspect: box('clap', Buffer.alloc(32)) }), 'UNSUPPORTED_VIDEO_MATRIX'],
    [await fixture({ audio: false, reorder: false, shift: 100 }), 'UNSUPPORTED_VIDEO_TIMELINE'],
    [await fixture({ audio: false, edited: true }), 'UNSUPPORTED_VIDEO_TIMELINE'], [await fixture({ width: 32768 }), 'VIDEO_DIMENSIONS']];
  const nonH264 = Buffer.from(valid), entry = nonH264.indexOf(Buffer.from('avc1'), nonH264.indexOf(Buffer.from('stsd'))); nonH264.write('hvc1', entry); cases.push([nonH264, 'VIDEO_REMUX_CODEC', remuxVideo]);
  for (const [index, [bytes, code, operation = rotateVideo]] of cases.entries()) {
    const input = path.join(directory, `unsupported-${index}.mp4`), output = path.join(directory, `none-${index}.mp4`); await writeFile(input, bytes);
    await assert.rejects(operation({ input_path: input, output_path: output }), { code }); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  const badTable = Buffer.from(valid), stsz = badTable.indexOf(Buffer.from('stsz')); badTable.writeUInt32BE(0xffffffff, stsz + 12);
  const input = path.join(directory, 'large-table.mp4'); await writeFile(input, badTable);
  await assert.rejects(rotateVideo({ input_path: input, output_path: path.join(directory, 'table.mp4') }), { code: 'VIDEO_SAMPLE_LIMIT' });
});

test('transform argument, exclusive-output, byte caps and cancellation contracts leave sources unchanged', async t => {
  const directory = await workspace(t), bytes = await fixture(), input = path.join(directory, 'source.mp4'), output = path.join(directory, 'new.mp4'); await writeFile(input, bytes);
  for (const degrees of [null, 0, 45, 360, '90']) await assert.rejects(rotateVideo({ input_path: input, output_path: output, degrees }), { code: 'INVALID_ARGUMENTS' });
  for (const operation of [rotateVideo, remuxVideo]) {
    await assert.rejects(operation({ input_path: input, output_path: output, keep_audio: null }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, 'bad.mov') }), { code: 'OUTPUT_EXTENSION' });
    await assert.rejects(operation({ input_path: 'relative.mp4', output_path: output }), { code: 'LOCAL_PATH_REQUIRED' });
    await assert.rejects(operation({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  }
  await writeFile(output, 'existing'); await assert.rejects(rotateVideo({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' }); assert.equal(await readFile(output, 'utf8'), 'existing');
  const huge = path.join(directory, 'huge.mp4'), handle = await open(huge, 'w'); await handle.truncate(MAX_VIDEO_INPUT_BYTES + 1); await handle.close();
  await assert.rejects(remuxVideo({ input_path: huge, output_path: path.join(directory, 'limit.mp4') }), { code: 'INPUT_SIZE' });
  const controller = new AbortController(), cancelled = path.join(directory, 'cancelled.mp4'), pending = rotateVideo({ input_path: input, output_path: cancelled }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(cancelled), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(bytes));
});
