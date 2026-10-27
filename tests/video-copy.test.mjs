import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { box } from '../vendor/abox/shared/js/mp4-boxes.js';
import { inspectVideo, trimVideo, joinVideos, preflightMp4, admitVideoOutput, MAX_VIDEO_OUTPUT_BYTES } from '../src/video-copy.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-video-copy-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

function fixture({ marker = 10, audio = true, width = 16, count = 6, timescale = 1000, compositionOffset = 0 } = {}) {
  const writer = new Mp4Writer();
  const video = writer.addTrack({ kind: 'vide', timescale, width, height: 16,
    sampleEntry: avcSampleEntry(width, 16, Uint8Array.from([1, 66, 0, 30, 255])) });
  for (let i = 0; i < count; i++) video.addSample({ data: Uint8Array.from([marker, i, 55]),
    dts: i * timescale, pts: i * timescale + compositionOffset, duration: timescale, isKey: i % 2 === 0 });
  if (audio) {
    const entry = new Uint8Array(28), view = new DataView(entry.buffer);
    view.setUint16(6, 1); view.setUint16(16, 2); view.setUint16(18, 16); view.setUint32(24, 48000 * 65536);
    const sound = writer.addTrack({ kind: 'soun', timescale: 48000, sampleEntry: box('mp4a', entry) });
    for (let i = 0; i < count; i++) sound.addSample({ data: Uint8Array.from([marker + 1, i]),
      dts: i * 48000, pts: i * 48000, duration: 48000, isKey: true });
  }
  return writer.finalize();
}

async function source(directory, name = 'source.mp4', options) {
  const input = path.join(directory, name), bytes = Buffer.from(await fixture(options).arrayBuffer());
  await writeFile(input, bytes); return { input, bytes };
}
async function decoded(bytes) { return demux(new File([bytes], 'test.mp4'), { timeline: 'media' }); }
function packets(bytes, track) { return track.samples.map(sample => [...bytes.subarray(sample.offset, sample.offset + sample.size)]); }

test('MP4 inspection checks bounded structure and returns counts without pretending packets were decoded', async t => {
  const directory = await workspace(t), { input, bytes } = await source(directory);
  const info = await inspectVideo({ input_path: input });
  assert.equal(info.duration_seconds, 6); assert.equal(info.video.sample_count, 6);
  assert.equal(info.video.keyframe_count, 3); assert.equal(info.audio.sample_count, 6);
  assert.equal(info.video.width, 16); assert.equal(info.video.height, 16);
  assert.equal(info.header_only, true); assert.equal(info.verified, false); assert.equal(info.decoding_verified, false);
  assert.ok(!Object.hasOwn(info.video, 'samples')); assert.deepEqual(await readFile(input), bytes);
});

test('lossless trimming retains exact selected video and audio packet bytes and independently checked edit lists', async t => {
  const directory = await workspace(t), { input, bytes } = await source(directory);
  const output = path.join(directory, 'trimmed.mp4');
  const result = await trimVideo({ input_path: input, output_path: output, ranges: [{ start: 2, end: 4 }] });
  assert.equal(result.verified, true); assert.equal(result.reencoded, false);
  assert.equal(result.preroll_seconds, 0); assert.equal(result.displayed_duration_seconds, 2);
  assert.equal(result.video_samples, 2); assert.equal(result.audio_samples, 2);
  const written = await readFile(output), media = await decoded(written);
  assert.deepEqual(packets(written, media.video), [[10, 2, 55], [10, 3, 55]]);
  assert.deepEqual(packets(written, media.audio), [[11, 2], [11, 3]]);
  assert.deepEqual(preflightMp4(written).edits, [[{ duration: 2000, mediaTime: 0, rate: 65536 }], [{ duration: 2000, mediaTime: 0, rate: 65536 }]]);
  assert.deepEqual(await readFile(input), bytes);
});

test('non-keyframe starts require explicit preroll acceptance and incoming edited media is refused', async t => {
  const directory = await workspace(t), { input } = await source(directory), output = path.join(directory, 'preroll.mp4');
  const args = { input_path: input, output_path: output, ranges: [{ start: 1, end: 3 }] };
  await assert.rejects(trimVideo(args), { code: 'VIDEO_PREROLL_REQUIRED' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  const made = await trimVideo({ ...args, allow_preroll: true });
  assert.equal(made.preroll_seconds, 1); assert.equal(made.video_samples, 3);
  assert.equal(made.verification.decoding, false); assert.ok(made.warnings.some(text => text.includes('not redaction')));
  const written = await readFile(output), media = await decoded(written);
  assert.deepEqual(packets(written, media.video), [[10, 0, 55], [10, 1, 55], [10, 2, 55]]);
  await assert.rejects(inspectVideo({ input_path: output }), { code: 'UNSUPPORTED_VIDEO_TIMELINE' });
  await assert.rejects(trimVideo({ input_path: output, output_path: path.join(directory, 'second.mp4'), ranges: [{ start: 0, end: 1 }] }), { code: 'UNSUPPORTED_VIDEO_TIMELINE' });
});

test('ordered ranges retain duplicates, can drop sound and refuse internal non-keyframe preroll', async t => {
  const directory = await workspace(t), { input } = await source(directory), output = path.join(directory, 'reordered.mp4');
  const result = await trimVideo({ input_path: input, output_path: output,
    ranges: [{ start: 4, end: 6 }, { start: 0, end: 1 }, { start: 4, end: 5 }], keep_audio: false });
  const written = await readFile(output), media = await decoded(written);
  assert.deepEqual(packets(written, media.video), [[10, 4, 55], [10, 5, 55], [10, 0, 55], [10, 4, 55]]);
  assert.equal(media.audio, null); assert.equal(result.displayed_duration_seconds, 4);
  await assert.rejects(trimVideo({ input_path: input, output_path: path.join(directory, 'bad.mp4'),
    ranges: [{ start: 0, end: 1 }, { start: 3, end: 4 }], allow_preroll: true }), { code: 'VIDEO_INTERNAL_PREROLL' });
});

test('lossless joining preserves packet order across different track clocks and refuses incompatible descriptions', async t => {
  const directory = await workspace(t), left = await source(directory, 'left.mp4', { count: 2 }),
    right = await source(directory, 'right.mp4', { count: 2, marker: 30, timescale: 90000 }), output = path.join(directory, 'joined.mp4');
  const made = await joinVideos({ input_paths: [left.input, right.input], output_path: output });
  assert.equal(made.clip_count, 2); assert.equal(made.displayed_duration_seconds, 4);
  const bytes = await readFile(output), media = await decoded(bytes);
  assert.deepEqual(packets(bytes, media.video), [[10, 0, 55], [10, 1, 55], [30, 0, 55], [30, 1, 55]]);
  assert.deepEqual(media.video.samples.map(sample => sample.dts), [0, 1000, 2000, 3000]);
  const different = await source(directory, 'different.mp4', { width: 32 });
  await assert.rejects(joinVideos({ input_paths: [left.input, different.input], output_path: path.join(directory, 'mismatch.mp4') }), { code: 'VIDEO_JOIN_MISMATCH' });
  assert.deepEqual(await readFile(left.input), left.bytes); assert.deepEqual(await readFile(right.input), right.bytes);
});

test('MP4 declared allocation counts, malformed boxes, paths, overwrites and cancellation fail without outputs', async t => {
  const directory = await workspace(t), { input, bytes } = await source(directory), output = path.join(directory, 'protected.mp4');
  await writeFile(output, 'existing');
  await assert.rejects(trimVideo({ input_path: input, output_path: output, ranges: [{ start: 0, end: 1 }] }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'existing');
  await assert.rejects(inspectVideo({ input_path: 'https://example.com/private.mp4' }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(inspectVideo({ input_path: input }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const huge = Buffer.from(bytes), table = huge.indexOf(Buffer.from('stsz'));
  assert.ok(table > 0); huge.writeUInt32BE(0xffffffff, table + 12);
  assert.throws(() => preflightMp4(huge), { code: 'VIDEO_SAMPLE_LIMIT' });
  assert.throws(() => preflightMp4(Buffer.from([0, 0, 0, 100, 109, 111, 111, 118])), { code: 'INVALID_VIDEO' });
  await assert.rejects(trimVideo({ input_path: input, output_path: path.join(directory, 'invalid.mp4'), ranges: [{ start: 0, end: 100 }] }), { code: 'VIDEO_RANGES' });
});

test('ordinary MP4 timing runs must cover every declared sample without reader recovery', async t => {
  const directory = await workspace(t), { bytes } = await source(directory, 'valid.mp4', { audio: false, compositionOffset: 100 });
  const stts = bytes.indexOf(Buffer.from('stts')), ctts = bytes.indexOf(Buffer.from('ctts'));
  assert.ok(stts > 0 && ctts > 0);
  assert.equal(preflightMp4(bytes).tracks[0].decode_duration, 6000);
  for (const [index, table, run] of [[0, stts, 5], [1, stts, 7], [2, ctts, 5], [3, ctts, 7]]) {
    const corrupt = Buffer.from(bytes); corrupt.writeUInt32BE(run, table + 12);
    assert.throws(() => preflightMp4(corrupt), { code: 'VIDEO_TIMELINE' });
    const input = path.join(directory, `bad-${index}.mp4`), output = path.join(directory, `output-${index}.mp4`);
    await writeFile(input, corrupt);
    await assert.rejects(trimVideo({ input_path: input, output_path: output, ranges: [{ start: 0, end: 1 }] }), { code: 'VIDEO_TIMELINE' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  const inconsistentDuration = Buffer.from(bytes), mdhd = inconsistentDuration.indexOf(Buffer.from('mdhd'));
  inconsistentDuration.writeUInt32BE(6001, mdhd + 20);
  const input = path.join(directory, 'duration.mp4'); await writeFile(input, inconsistentDuration);
  await assert.rejects(inspectVideo({ input_path: input }), { code: 'VIDEO_TIMELINE' });
});

test('MP4 chunks must account for all declared samples and reference the sole sample description', async t => {
  const directory = await workspace(t), { bytes } = await source(directory, 'valid.mp4', { audio: false });
  const stsc = bytes.indexOf(Buffer.from('stsc'));
  assert.ok(stsc > 0);
  assert.equal(bytes.readUInt32BE(stsc + 8), 1); assert.equal(bytes.readUInt32BE(stsc + 12), 1);
  for (const [offset, value, code] of [[stsc + 12, 2, 'INVALID_VIDEO'], [stsc + 16, 0, 'INVALID_VIDEO'],
    [stsc + 16, 2, 'VIDEO_SAMPLE_LIMIT'], [stsc + 20, 2, 'INVALID_VIDEO']]) {
    const corrupt = Buffer.from(bytes); corrupt.writeUInt32BE(value, offset);
    assert.throws(() => preflightMp4(corrupt), { code });
  }
  const corrupt = Buffer.from(bytes), stss = corrupt.indexOf(Buffer.from('stss'));
  corrupt.writeUInt32BE(7, stss + 12);
  assert.throws(() => preflightMp4(corrupt), { code: 'INVALID_VIDEO' });
});

test('MP4 packet and chunk bytes must remain inside media payloads, including the final sample edge', async t => {
  const directory = await workspace(t), { bytes } = await source(directory, 'valid.mp4', { audio: false });
  const stco = bytes.indexOf(Buffer.from('stco')), stsz = bytes.indexOf(Buffer.from('stsz'));
  const structure = preflightMp4(bytes); assert.equal(structure.mdats.length, 1);
  for (const offset of [0, bytes.indexOf(Buffer.from('moov')) + 4, structure.mdats[0].start - 1, structure.mdats[0].end - 1]) {
    const corrupt = Buffer.from(bytes); corrupt.writeUInt32BE(offset, stco + 12);
    assert.throws(() => preflightMp4(corrupt), { code: 'INVALID_VIDEO' });
  }
  const zero = Buffer.from(bytes); zero.writeUInt32BE(0, stsz + 16);
  assert.throws(() => preflightMp4(zero), { code: 'INVALID_VIDEO' });
});

test('MP4 sample-description cardinality and copied-description bytes are admitted before allocations', () => {
  const fullHeader = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);
  const hidden = Buffer.from(box('stsd', fullHeader, box('free'), box('free')));
  assert.throws(() => preflightMp4(hidden), { code: 'UNSUPPORTED_VIDEO' });
  const payload = 80 * 2 ** 20, sampleCount = 10000;
  assert.ok(admitVideoOutput(payload, sampleCount, 0) < MAX_VIDEO_OUTPUT_BYTES);
  assert.throws(() => admitVideoOutput(payload, sampleCount, 60 * 2 ** 20), { code: 'OUTPUT_SIZE' });
});
