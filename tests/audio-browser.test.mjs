import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findBrowser } from '../src/browser.mjs';
import { editAudio, trimAudio } from '../src/audio.mjs';

const browser = await findBrowser(), browserOptions = { skip: !browser, timeout: 120000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-audio-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function wav(channels, rate = 8000, bits = 32) {
  const frames = channels[0].length, header = bits === 32 ? 58 : 44, bytes = Buffer.alloc(header + frames * channels.length * bits / 8);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(bits === 32 ? 18 : 16, 16); bytes.writeUInt16LE(bits === 32 ? 3 : 1, 20);
  bytes.writeUInt16LE(channels.length, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels.length * bits / 8, 28);
  bytes.writeUInt16LE(channels.length * bits / 8, 32); bytes.writeUInt16LE(bits, 34);
  if (bits === 32) { bytes.write('fact', 38); bytes.writeUInt32LE(4, 42); bytes.writeUInt32LE(frames, 46); }
  bytes.write('data', header - 8); bytes.writeUInt32LE(bytes.length - header, header - 4);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels.length; channel++) {
    const at = header + (frame * channels.length + channel) * bits / 8;
    if (bits === 32) bytes.writeFloatLE(channels[channel][frame], at); else bytes.writeInt16LE(channels[channel][frame], at);
  }
  return bytes;
}
function readWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format, data, fact;
  for (let at = 12; at < bytes.length;) {
    const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), from = at + 8;
    if (type === 'fmt ') format = { code: bytes.readUInt16LE(from), channels: bytes.readUInt16LE(from + 2), rate: bytes.readUInt32LE(from + 4), bits: bytes.readUInt16LE(from + 14) };
    else if (type === 'data') data = bytes.subarray(from, from + size);
    else if (type === 'fact') fact = bytes.readUInt32LE(from);
    else assert.fail('Unexpected output chunk');
    at += 8 + size + (size & 1);
  }
  assert.equal(format.code, format.bits === 32 ? 3 : 1);
  const frames = data.length / (format.channels * format.bits / 8);
  if (format.bits === 32) assert.equal(fact, frames);
  const channels = Array.from({ length: format.channels }, () => []);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels.length; channel++) {
    const at = (frame * channels.length + channel) * format.bits / 8;
    channels[channel].push(format.bits === 32 ? data.readFloatLE(at) : data.readInt16LE(at));
  }
  return { ...format, frames, samples: channels };
}

test('audio reverse and gain produce independently read Float32 samples without touching the stereo source', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), output = path.join(directory, 'edited.wav');
  const samples = [Float32Array.from({ length: 400 }, (_, at) => at % 8 / 8 - 0.5),
    Float32Array.from({ length: 400 }, (_, at) => (at % 13 - 6) / 16)];
  const bytes = wav(samples); await writeFile(input, bytes);
  const result = await editAudio({ input_path: input, output_path: output, reverse: true, gain_db: 6, bits: 32 });
  const checked = readWav(await readFile(output)), gain = 10 ** (6 / 20);
  assert.equal(checked.frames, 400); assert.equal(checked.channels, 2); assert.equal(checked.rate, 8000);
  for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < 400; frame++) {
    assert.equal(checked.samples[channel][frame], Math.fround(samples[channel][399 - frame] * gain));
  }
  assert.equal(result.verified, true); assert.equal(result.verification.samples_checked, 800);
  assert.equal(result.verification.all_encoded_samples, true); assert.equal(result.source_metadata_copied, false);
  assert.equal(result.reverse, true); assert.equal(result.gain_db, 6); assert.ok(!Object.hasOwn(result, 'samples'));
  assert.equal(hash(await readFile(input)), hash(bytes));
  await assert.rejects(editAudio({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
});

test('audio keep selection retains requested order, duplicate ranges and sample-rate precision with fades disabled', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), output = path.join(directory, 'kept.wav');
  const raw = Float32Array.from({ length: 400 }, (_, at) => at / 400 - 0.5);
  raw[0] = -1; raw[240] = 1; raw[319] = 0.25;
  const bytes = wav([raw], 8000, 32); await writeFile(input, bytes);
  const result = await trimAudio({ input_path: input, output_path: output, ranges: [{ start: 0.03, end: 0.04 },
    { start: 0, end: 0.01 }, { start: 0.03, end: 0.04 }], fade_ms: 0, bits: 32 });
  const checked = readWav(await readFile(output)), indices = [...Array.from({ length: 80 }, (_, at) => 240 + at),
    ...Array.from({ length: 80 }, (_, at) => at), ...Array.from({ length: 80 }, (_, at) => 240 + at)];
  assert.equal(checked.frames, 240); assert.equal(result.section_count, 3); assert.equal(result.duration_seconds, 0.03);
  assert.deepEqual(checked.samples[0], indices.map(at => raw[at]));
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('native PCM16 decoding retains signed full-scale endpoints and its sign-specific normalization within one Float32 ULP', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'pcm.wav'), output = path.join(directory, 'float.wav');
  const raw = Int16Array.from({ length: 400 }, (_, at) => at * 160 - 32000);
  raw[0] = -32768; raw[1] = 0; raw[2] = 32767;
  const bytes = wav([raw], 8000, 16); await writeFile(input, bytes);
  await editAudio({ input_path: input, output_path: output, bits: 32 });
  const checked = readWav(await readFile(output));
  assert.deepEqual(checked.samples[0].slice(0, 3), [-1, 0, 1]);
  const view = new DataView(new ArrayBuffer(4));
  const bits = value => { view.setFloat32(0, value); return view.getUint32(0); };
  for (let at = 0; at < raw.length; at++) {
    const expected = Math.fround(raw[at] / (raw[at] < 0 ? 32768 : 32767)), actual = checked.samples[0][at];
    assert.ok(Math.abs(bits(actual) - bits(expected)) <= 1);
  }
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('audio cut merges overlapping marks and uses exact source-boundary and join fade rules', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), output = path.join(directory, 'cut.wav');
  const bytes = wav([Float32Array.from({ length: 320 }, () => 0.5)]); await writeFile(input, bytes);
  const result = await trimAudio({ input_path: input, output_path: output, mode: 'cut',
    ranges: [{ start: 0.01, end: 0.02 }, { start: 0.015, end: 0.03 }], fade_ms: 5, bits: 32 });
  const checked = readWav(await readFile(output)); assert.equal(checked.frames, 160); assert.equal(result.section_count, 2);
  const expected = Array(160).fill(0.5);
  for (let at = 0; at < 40; at++) { expected[79 - at] = Math.fround(0.5 * at / 40); expected[80 + at] = Math.fround(0.5 * at / 40); }
  assert.deepEqual(checked.samples[0], expected); assert.equal(checked.samples[0][0], 0.5); assert.equal(checked.samples[0].at(-1), 0.5);
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('PCM16 clipping is reported and peak normalization writes the independently expected level', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav');
  const raw = Float32Array.from({ length: 400 }, (_, at) => [0.25, -0.5, 0.125, -0.25][at % 4]), bytes = wav([raw]); await writeFile(input, bytes);
  const output = path.join(directory, 'clipped.wav'), result = await editAudio({ input_path: input, output_path: output, gain_db: 12 });
  const checked = readWav(await readFile(output)), gain = 10 ** (12 / 20);
  const expected = [...raw].map(value => {
    const sample = Math.fround(value * gain); return sample >= 1 ? 32767 : sample <= -1 ? -32768 : Math.round(sample * (sample < 0 ? 32768 : 32767));
  });
  assert.deepEqual(checked.samples[0], expected); assert.ok(result.clipped_samples > 0); assert.ok(result.warnings.some(text => text.includes('clipped')));
  const normalized = path.join(directory, 'normalized.wav');
  const made = await editAudio({ input_path: input, output_path: normalized, volume_mode: 'normalize', normalize_db: -6, bits: 32 });
  const samples = readWav(await readFile(normalized)).samples[0], target = 10 ** (-6 / 20);
  for (let at = 0; at < raw.length; at++) assert.equal(samples[at], Math.fround(raw[at] * target / 0.5));
  assert.equal(made.clipped_samples, 0); assert.equal(hash(await readFile(input)), hash(bytes));
});

function magnitude(samples, frequency, rate) {
  let real = 0, imaginary = 0;
  for (let at = 100; at < samples.length - 100; at++) {
    const angle = 2 * Math.PI * frequency * at / rate; real += samples[at] * Math.cos(angle); imaginary -= samples[at] * Math.sin(angle);
  }
  return Math.hypot(real, imaginary) / samples.length;
}
test('speed modes change duration and distinguish pitch-preserving stretch from pitched resampling', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'tone.wav');
  const samples = Float32Array.from({ length: 8000 }, (_, at) => Math.sin(2 * Math.PI * 440 * at / 8000) * 0.5), bytes = wav([samples]); await writeFile(input, bytes);
  for (const keepPitch of [false, true]) {
    const output = path.join(directory, `speed-${keepPitch}.wav`);
    const result = await editAudio({ input_path: input, output_path: output, speed: 2, keep_pitch: keepPitch, bits: 32 });
    const checked = readWav(await readFile(output)); assert.equal(checked.frames, 4000); assert.equal(result.duration_seconds, 0.5);
    const wanted = magnitude(checked.samples[0], keepPitch ? 440 : 880, 8000), unwanted = magnitude(checked.samples[0], keepPitch ? 880 : 440, 8000);
    assert.ok(wanted > 0.05); assert.ok(wanted > unwanted * 5);
  }
  assert.equal(hash(await readFile(input)), hash(bytes));
});

test('audio cancellation closes processing before any output and preserves the source', browserOptions, async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), output = path.join(directory, 'cancelled.wav');
  const bytes = wav([new Float32Array(8000)]); await writeFile(input, bytes);
  const controller = new AbortController(), pending = editAudio({ input_path: input, output_path: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(bytes));
});
