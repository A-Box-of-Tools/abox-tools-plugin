import assert from 'node:assert/strict';
import test from 'node:test';
import { admitCompressedAudio, admitMp4Audio, copyAacToM4a } from '../src/audio-headers.mjs';
import { silentMp3, adtsFrame, aacContainer } from './audio-codec-fixtures.mjs';

test('MP3 admission walks complete stable Layer III frames and skips bounded metadata without resynchronizing', async () => {
  const bytes = silentMp3(5), info = await admitCompressedAudio(bytes);
  assert.equal(info.kind, 'mp3'); assert.equal(info.sample_rate, 44100); assert.equal(info.channels, 2);
  assert.equal(info.frames, 5 * 1152); assert.equal(info.packets.length, 5); assert.equal(info.packets[4].offset, 417 * 4);
  const header = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 4]), footer = Buffer.alloc(128); footer.write('TAG');
  const tagged = Buffer.concat([header, Buffer.from('note'), bytes, footer]), found = await admitCompressedAudio(tagged);
  assert.equal(found.metadata_skipped, true); assert.equal(found.frames, info.frames); assert.equal(found.packets[0].offset, 14);
});

test('MP3 admission refuses truncated, free-format, changing or externally dependent frame sequences', async () => {
  const original = silentMp3(3), values = [original.subarray(0, -1), Buffer.concat([original, Buffer.from('junk')])];
  for (const [offset, value] of [[2, 0], [417 + 2, 0x94], [417 + 3, 0xc0], [4, 1], [1, 0xfd]]) {
    const copy = Buffer.from(original); copy[offset] = value; values.push(copy);
  }
  for (const value of values) await assert.rejects(admitCompressedAudio(value), { code: 'UNSUPPORTED_AUDIO' });
});

test('AAC ADTS admission strips exact frame headers and checks LC profile, channels, timing and complete length', async () => {
  const first = adtsFrame(Buffer.from([1, 2, 3])), second = adtsFrame(Buffer.from([4, 5])), bytes = Buffer.concat([first, second]);
  const info = await admitCompressedAudio(bytes);
  assert.equal(info.kind, 'adts'); assert.equal(info.sample_rate, 48000); assert.equal(info.channels, 2);
  assert.equal(info.frames, 2048); assert.deepEqual(Array.from(info.description), [0x11, 0x90]);
  assert.equal(info.packets[0].offset, 7); assert.equal(info.packets[0].size, 3); assert.equal(info.packets[1].offset, first.length + 7);
  for (const [offset, value] of [[2, 0], [2, 0x50], [3, 0], [6, 0xfd]]) {
    const copy = Buffer.from(bytes); copy[offset] = value;
    await assert.rejects(admitCompressedAudio(copy), { code: 'UNSUPPORTED_AUDIO' });
  }
  await assert.rejects(admitCompressedAudio(bytes.subarray(0, -1)), { code: 'UNSUPPORTED_AUDIO' });
});

test('MP4 audio admission reuses sample-table guards and exact AAC descriptions for audio-only or video containers', async () => {
  const adts = Buffer.concat([adtsFrame(Buffer.from([1, 2, 3])), adtsFrame(Buffer.from([4, 5, 6]))]);
  for (const video of [false, true]) {
    const bytes = await aacContainer(adts, { video }), original = Buffer.from(bytes), info = await admitMp4Audio(bytes);
    assert.equal(info.kind, 'mp4-aac'); assert.equal(info.video_tracks, video ? 1 : 0); assert.equal(info.frames, 2048);
    assert.equal(info.sample_rate, 48000); assert.equal(info.packets.length, 2);
    const output = await copyAacToM4a(bytes, info), checked = await admitMp4Audio(output);
    assert.equal(checked.video_tracks, 0); assert.equal(checked.frames, info.frames); assert.equal(checked.packets.length, 2);
    for (let at = 0; at < 2; at++) assert.deepEqual(output.subarray(checked.packets[at].offset, checked.packets[at].offset + checked.packets[at].size),
      bytes.subarray(info.packets[at].offset, info.packets[at].offset + info.packets[at].size));
    assert.deepEqual(bytes, original);
  }
  await assert.rejects(admitMp4Audio(await aacContainer(adts, { edit: true })), { code: 'UNSUPPORTED_AUDIO' });
});

test('encoded audio admission bounds aggregate PCM before native decoding and observes cancellation', async () => {
  await assert.rejects(admitCompressedAudio(silentMp3(10417)), { code: 'AUDIO_LIMIT' });
  await assert.rejects(admitCompressedAudio(silentMp3(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
