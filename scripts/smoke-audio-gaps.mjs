import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { admitMp4Audio } from '../src/audio-headers.mjs';
import { silentMp3, aacContainer } from '../tests/audio-codec-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function floatWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); let format, data;
  for (let at = 12; at < bytes.length;) {
    assert.ok(at + 8 <= bytes.length);
    const size = bytes.readUInt32LE(at + 4), start = at + 8, type = bytes.toString('ascii', at, at + 4);
    assert.ok(start + size + (size & 1) <= bytes.length);
    if (type === 'fmt ') format = { channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4),
      bits: bytes.readUInt16LE(start + 14), code: bytes.readUInt16LE(start) };
    if (type === 'data') { assert.equal(data, undefined); data = bytes.subarray(start, start + size); }
    at = start + size + (size & 1);
  }
  assert.equal(format?.bits, 32); assert.equal(format?.code, 3); assert.ok([1, 2].includes(format.channels)); assert.ok(data);
  assert.equal(data.length % (format.channels * 4), 0);
  const frames = data.length / (format.channels * 4), planes = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let at = 0; at < frames; at++) for (let channel = 0; channel < planes.length; channel++) {
    const value = data.readFloatLE((at * planes.length + channel) * 4); assert.ok(Number.isFinite(value)); planes[channel][at] = value;
  }
  return { ...format, frames, planes };
}

// These checks run through the same MCP client as the other release checks.
// The AAC fixture is an original checked-in synthetic tone, so a release test
// needs neither an encoder, an external recording nor a network download.
export async function smokeAudioGaps({ call, client, workspace }) {
  const covered = new Set(), sourceHashes = new Map(), local = name => path.join(workspace, name);
  const run = async (name, args) => {
    const result = await call(client, name, args); covered.add(name);
    assert.equal(result.ok, true); assert.equal(result.verified, true);
    for (const key of ['data', 'samples', 'packets', 'description', 'sample_entry']) assert.equal(Object.hasOwn(result, key), false);
    return result;
  };
  const source = async (name, bytes) => { const filename = local(name); await writeFile(filename, bytes, { flag: 'wx' }); sourceHashes.set(filename, hash(bytes)); return filename; };
  const mp3Path = await source('bounded synthetic silence.mp3', silentMp3());
  const mp3Wav = local('bounded silence decoded.wav');
  const decodedMp3 = await run('abox_audio_extract', { input_path: mp3Path, output_path: mp3Wav, bits: 32 });
  const silence = floatWav(await readFile(mp3Wav)); assert.equal(silence.rate, 44100); assert.equal(silence.channels, 2);
  assert.ok(silence.frames >= 20 * 1152 && silence.frames <= 24 * 1152);
  assert.equal(decodedMp3.input_format, 'mp3'); assert.equal(decodedMp3.verification.decoder_output_bounds, true);
  assert.ok(silence.planes.every(plane => plane.every(value => value === 0)));

  const aacBytes = await readFile(new URL('../tests/fixtures/abox-synthetic.aac', import.meta.url));
  const aacPath = await source('bounded synthetic stereo.aac', aacBytes), baselinePath = local('bounded stereo decoded.wav');
  const decodedAac = await run('abox_audio_extract', { input_path: aacPath, output_path: baselinePath, bits: 32 });
  const baseline = floatWav(await readFile(baselinePath)); assert.equal(baseline.rate, 48000); assert.equal(baseline.channels, 2);
  assert.equal(decodedAac.input_format, 'adts'); assert.equal(decodedAac.verification.native_bitstream_validity, false);
  const power = baseline.planes.map(plane => plane.reduce((sum, sample) => sum + sample * sample, 0));
  assert.ok(power[0] > 10 && power[1] > 1 && power[0] > power[1] * 2);
  const reversedPath = local('bounded stereo reversed.wav');
  const reversed = await run('abox_audio_edit', { input_path: aacPath, output_path: reversedPath, reverse: true, bits: 32 });
  const backwards = floatWav(await readFile(reversedPath)); assert.equal(backwards.frames, baseline.frames); assert.equal(reversed.reverse, true);
  for (let channel = 0; channel < 2; channel++) for (let at = 0; at < baseline.frames; at++) assert.equal(backwards.planes[channel][at], baseline.planes[channel][baseline.frames - at - 1]);
  const ranges = [{ start: 0.08, end: 0.1 }, { start: 0.04, end: 0.06 }, { start: 0.08, end: 0.1 }], trimmedPath = local('bounded ordered stereo.wav');
  const trimmed = await run('abox_audio_trim', { input_path: aacPath, output_path: trimmedPath, ranges, fade_ms: 0, bits: 32 });
  const selected = floatWav(await readFile(trimmedPath)); assert.equal(trimmed.section_count, 3);
  for (let channel = 0; channel < 2; channel++) {
    const expected = ranges.flatMap(range => Array.from(baseline.planes[channel].subarray(Math.round(range.start * baseline.rate), Math.round(range.end * baseline.rate))));
    assert.deepEqual(Array.from(selected.planes[channel]), expected);
  }

  const videoBytes = await aacContainer(aacBytes, { video: true }), videoPath = await source('AAC with opaque picture.mp4', videoBytes);
  const original = await admitMp4Audio(videoBytes); assert.equal(original.video_tracks, 1);
  const m4aPath = local('copied AAC only.m4a'), copied = await run('abox_audio_extract', { input_path: videoPath, output_path: m4aPath, format: 'm4a' });
  assert.equal(copied.reencoded, false); assert.equal(copied.verification.decoding, false);
  const m4aBytes = await readFile(m4aPath), after = await admitMp4Audio(m4aBytes); assert.equal(after.video_tracks, 0);
  assert.deepEqual(after.description, original.description); assert.equal(after.packets.length, original.packets.length);
  for (let at = 0; at < after.packets.length; at++) {
    const before = original.packets[at], packet = after.packets[at]; assert.equal(packet.timestamp, before.timestamp); assert.equal(packet.frames, before.frames);
    assert.deepEqual(m4aBytes.subarray(packet.offset, packet.offset + packet.size), videoBytes.subarray(before.offset, before.offset + before.size));
  }
  const videoWavPath = local('video AAC decoded.wav');
  await run('abox_audio_extract', { input_path: videoPath, output_path: videoWavPath, bits: 32 });
  assert.deepEqual(await readFile(videoWavPath), await readFile(baselinePath));
  for (const [filename, expected] of sourceHashes) assert.equal(hash(await readFile(filename)), expected, 'An audio smoke source changed.');
  assert.deepEqual([...covered].sort(), ['abox_audio_edit', 'abox_audio_extract', 'abox_audio_trim']);
  return { tools: [...covered], compressed_formats: ['mp3', 'adts', 'mp4-aac'], aac_packet_copy: true, capability_absences: [] };
}
