import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findBrowser, withBrowser } from '../src/browser.mjs';
import { editAudio, trimAudio, extractAudio } from '../src/audio.mjs';
import { installAudioPacketDecoder } from '../src/audio-browser-codec.mjs';
import { admitCompressedAudio, admitMp4Audio } from '../src/audio-headers.mjs';
import { silentMp3, loadAacFixture, aacContainer } from './audio-codec-fixtures.mjs';

const browser = await findBrowser(), browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-audio-compressed-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
export function readFloatWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); let format, data;
  for (let at = 12; at < bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), start = at + 8, type = bytes.toString('ascii', at, at + 4);
    if (type === 'fmt ') format = { channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14), code: bytes.readUInt16LE(start) };
    if (type === 'data') data = bytes.subarray(start, start + size); at = start + size + (size & 1);
  }
  assert.equal(format.bits, 32); assert.equal(format.code, 3); assert.ok(data);
  const frames = data.length / (format.channels * 4), planes = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let at = 0; at < frames; at++) for (let channel = 0; channel < planes.length; channel++) {
    const value = data.readFloatLE((at * planes.length + channel) * 4); assert.ok(Number.isFinite(value)); planes[channel][at] = value;
  }
  return { ...format, frames, planes };
}

test('real synthetic MP3 decodes under packet bounds and supports edit, trim and WAV extraction', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'silence.mp3'), bytes = silentMp3(); await writeFile(input, bytes);
  const output = path.join(directory, 'decoded.wav'), result = await extractAudio({ input_path: input, output_path: output, bits: 32 });
  const checked = readFloatWav(await readFile(output)); assert.equal(checked.rate, 44100); assert.equal(checked.channels, 2);
  assert.ok(checked.frames >= 1152 * 20); assert.ok(checked.frames <= 1152 * 24);
  for (const plane of checked.planes) assert.ok(plane.every(value => value === 0));
  assert.equal(result.input_format, 'mp3'); assert.equal(result.verification.decoder_output_bounds, true);
  const edited = path.join(directory, 'edited.wav'), change = await editAudio({ input_path: input, output_path: edited, speed: 2, keep_pitch: false, bits: 32 });
  const after = readFloatWav(await readFile(edited)); assert.ok(Math.abs(after.frames - change.input_frames / 2) <= 1);
  const trimmed = path.join(directory, 'trimmed.wav');
  await trimAudio({ input_path: input, output_path: trimmed, ranges: [{ start: 0.05, end: 0.1 }, { start: 0.1, end: 0.2 }], fade_ms: 0, bits: 32 });
  assert.equal(readFloatWav(await readFile(trimmed)).frames, Math.round(0.1 * 44100) - Math.round(0.05 * 44100) + Math.round(0.2 * 44100) - Math.round(0.1 * 44100));
  assert.equal(hash(await readFile(input)), hash(bytes)); assert.ok(!Object.hasOwn(result, 'data')); assert.ok(!Object.hasOwn(result, 'samples'));
});

test('AAC-LC loopback retains decoded stereo order and exact reverse/duplicate selected samples', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'tones.aac'), bytes = await loadAacFixture(); await writeFile(input, bytes);
  const baselinePath = path.join(directory, 'baseline.wav');
  const baselineResult = await extractAudio({ input_path: input, output_path: baselinePath, bits: 32 });
  const baseline = readFloatWav(await readFile(baselinePath)); assert.equal(baseline.channels, 2); assert.equal(baseline.rate, 48000);
  const power = baseline.planes.map(plane => plane.reduce((sum, value) => sum + value * value, 0));
  assert.ok(power[0] > 10); assert.ok(power[0] > power[1] * 2); assert.ok(power[1] > 1);
  assert.equal(baselineResult.input_format, 'adts'); assert.equal(baselineResult.verification.native_bitstream_validity, false);
  const reversePath = path.join(directory, 'reverse.wav'); await editAudio({ input_path: input, output_path: reversePath, reverse: true, bits: 32 });
  const reverse = readFloatWav(await readFile(reversePath)); assert.equal(reverse.frames, baseline.frames);
  for (let channel = 0; channel < 2; channel++) for (let at = 0; at < baseline.frames; at++) assert.equal(reverse.planes[channel][at], baseline.planes[channel][baseline.frames - at - 1]);
  const ranges = [{ start: 0.08, end: 0.1 }, { start: 0.04, end: 0.06 }, { start: 0.08, end: 0.1 }], selectedPath = path.join(directory, 'selected.wav');
  await trimAudio({ input_path: input, output_path: selectedPath, ranges, fade_ms: 0, bits: 32 });
  const selected = readFloatWav(await readFile(selectedPath));
  for (let channel = 0; channel < 2; channel++) {
    const expected = ranges.flatMap(range => Array.from(baseline.planes[channel].subarray(Math.round(range.start * 48000), Math.round(range.end * 48000))));
    assert.deepEqual(Array.from(selected.planes[channel]), expected);
  }
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('video AAC extraction never decodes picture packets and M4A copy retains every real AAC packet', browserOptions, async t => {
  const directory = await workspace(t), adts = await loadAacFixture(), bytes = await aacContainer(adts, { video: true });
  const input = path.join(directory, 'opaque-picture.mp4'), wav = path.join(directory, 'extracted.wav'), m4a = path.join(directory, 'copied.m4a'); await writeFile(input, bytes);
  const source = await admitMp4Audio(bytes); assert.equal(source.video_tracks, 1);
  const result = await extractAudio({ input_path: input, output_path: m4a, format: 'm4a' });
  assert.equal(result.reencoded, false); assert.equal(result.verification.decoding, false);
  const output = await readFile(m4a), checked = await admitMp4Audio(output); assert.equal(checked.video_tracks, 0);
  assert.equal(checked.packets.length, source.packets.length);
  for (let at = 0; at < checked.packets.length; at++) assert.deepEqual(output.subarray(checked.packets[at].offset, checked.packets[at].offset + checked.packets[at].size),
    bytes.subarray(source.packets[at].offset, source.packets[at].offset + source.packets[at].size));
  const decoded = await extractAudio({ input_path: input, output_path: wav, bits: 32 }); assert.equal(decoded.input_format, 'mp4-aac');
  const second = path.join(directory, 'copied.wav'); await extractAudio({ input_path: m4a, output_path: second, bits: 32 });
  assert.deepEqual(await readFile(second), await readFile(wav));
  const mono = path.join(directory, 'mono.wav'); await extractAudio({ input_path: input, output_path: mono, bits: 32, channels: 'mono' });
  const stereoPixels = readFloatWav(await readFile(wav)), monoPixels = readFloatWav(await readFile(mono)); assert.equal(monoPixels.channels, 1);
  for (let at = 0; at < monoPixels.frames; at++) assert.equal(monoPixels.planes[0][at], Math.fround(Math.fround(stereoPixels.planes[0][at] + stereoPixels.planes[1][at]) / 2));
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('packet decoder refuses native channel/frame changes before copying PCM and closes every block', browserOptions, async () => {
  const checked = await withBrowser(async page => {
    await page.evaluate(installAudioPacketDecoder);
    return page.evaluate(async () => {
      let copied = 0, blockClosed = 0, decoderClosed = 0, supportCalls = 0;
      globalThis.AudioDecoder = class {
        static async isConfigSupported() { supportCalls++; return { supported: true }; }
        constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
        configure() { this.state = 'configured'; }
        decode() { this.callbacks.output({ numberOfChannels: 64, sampleRate: 44100, numberOfFrames: 1_000_000_000, timestamp: 0,
          copyTo() { copied++; throw new Error('must not copy'); }, close() { blockClosed++; } }); }
        async flush() {}
        close() { this.state = 'closed'; decoderClosed++; }
      };
      const file = new Blob([new Uint8Array(417)]), plan = { codec: 'mp3', channels: 2, sample_rate: 44100,
        frames: 1152, packet_frames: 1152, packets: [{ offset: 0, size: 417, timestamp: 0 }] };
      const invalidErrors = [];
      for (const override of [{ frames: 0 }, { frames: 1153 }, { description: [1, 2] }, { packets: [{ offset: 0, size: 418, timestamp: 0 }] }]) {
        try { await globalThis.__aboxDecodeAudioPackets(file, { ...plan, ...override }); invalidErrors.push('accepted'); }
        catch (caught) { invalidErrors.push(caught.code); }
      }
      const supportCallsBeforeDecode = supportCalls; let error;
      try { await globalThis.__aboxDecodeAudioPackets(file, plan); }
      catch (caught) { error = caught.code; }
      return { error, copied, blockClosed, decoderClosed, invalidErrors, supportCallsBeforeDecode, supportCalls };
    });
  });
  assert.deepEqual(checked, { error: 'AUDIO_DECODE_MISMATCH', copied: 0, blockClosed: 1, decoderClosed: 1,
    invalidErrors: Array(4).fill('AUDIO_DECODE_MISMATCH'), supportCallsBeforeDecode: 0, supportCalls: 1 });
});

test('compressed audio cancellation and unsupported extraction settings leave source and outputs untouched', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'tones.aac'), output = path.join(directory, 'cancelled.wav');
  const bytes = Buffer.concat(Array.from({ length: 80 }, () => silentMp3())); await writeFile(input, bytes);
  const controller = new AbortController(), pending = extractAudio({ input_path: input, output_path: output, bits: 32 }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(bytes));
  await assert.rejects(extractAudio({ input_path: input, output_path: path.join(directory, 'bad.m4a'), format: 'm4a', bits: 16 }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(extractAudio({ input_path: input, output_path: path.join(directory, 'bad.txt') }), { code: 'OUTPUT_EXTENSION' });
  const plan = await admitCompressedAudio(silentMp3()); assert.equal(plan.kind, 'mp3');
});
