import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { editAudio, trimAudio, MAX_AUDIO_INPUT_BYTES } from '../src/audio.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-audio-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function wav({ frames = 80, channels = 1, rate = 8000, bits = 16, value = 0 } = {}) {
  const header = bits === 32 ? 58 : 44, bytes = Buffer.alloc(header + frames * channels * bits / 8);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(bits === 32 ? 18 : 16, 16); bytes.writeUInt16LE(bits === 32 ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * bits / 8, 28);
  bytes.writeUInt16LE(channels * bits / 8, 32); bytes.writeUInt16LE(bits, 34);
  if (bits === 32) { bytes.write('fact', 38); bytes.writeUInt32LE(4, 42); bytes.writeUInt32LE(frames, 46); }
  bytes.write('data', header - 8); bytes.writeUInt32LE(bytes.length - header, header - 4);
  if (value) for (let at = header; at < bytes.length; at += bits / 8) bits === 32 ? bytes.writeFloatLE(value, at) : bytes.writeInt16LE(value, at);
  return bytes;
}

test('audio settings refuse unsupported typed values and irrelevant volume fields before browser work', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'); await writeFile(input, wav());
  const bad = [{ bits: 24 }, { bits: null }, { reverse: null }, { keep_pitch: 'yes' }, { speed: 0.24 }, { speed: 4.01 },
    { gain_db: 25 }, { gain_db: null }, { normalize_db: -1 }, { volume_mode: 'normalize', gain_db: 0 },
    { volume_mode: 'normalize', normalize_db: 1 }, { volume_mode: null }];
  for (const [index, args] of bad.entries()) {
    const output = path.join(directory, `bad-${index}.wav`);
    await assert.rejects(editAudio({ input_path: input, output_path: output, ...args }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('trim settings refuse empty, malformed, clipped or sub-sample ranges without source changes', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), source = wav(); await writeFile(input, source);
  const cases = [
    [{ ranges: [] }, 'INVALID_ARGUMENTS'], [{ ranges: [{ start: 0, end: 0.01, private: true }] }, 'INVALID_ARGUMENTS'],
    [{ ranges: [{ start: -1, end: 0.001 }] }, 'INVALID_ARGUMENTS'], [{ ranges: [{ start: 0.01, end: 0 }] }, 'INVALID_ARGUMENTS'],
    [{ ranges: [{ start: 0, end: null }] }, 'INVALID_ARGUMENTS'], [{ ranges: [{ start: 0, end: 0.011 }] }, 'AUDIO_RANGE'],
    [{ ranges: [{ start: 0, end: 0.000001 }] }, 'AUDIO_RANGE'],
    [{ ranges: [{ start: 0, end: 0.01 }], mode: 'cut' }, 'AUDIO_RANGE'],
    [{ ranges: [{ start: 0, end: 0.01 }], mode: null }, 'INVALID_ARGUMENTS'],
    [{ ranges: [{ start: 0, end: 0.01 }], fade_ms: 51 }, 'INVALID_ARGUMENTS'],
    [{ ranges: Array.from({ length: 101 }, () => ({ start: 0, end: 0.001 })) }, 'INVALID_ARGUMENTS'],
  ];
  for (const [index, [args, code]] of cases.entries()) {
    const output = path.join(directory, `bad-${index}.wav`);
    await assert.rejects(trimAudio({ input_path: input, output_path: output, ...args }), { code });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
  }
});

test('WAV admission refuses compressed formats, inconsistent chunks and nonfinite samples without private errors', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav');
  const valid = wav(), wrongRiff = Buffer.from(valid), wrongAlign = Buffer.from(valid), compressed = Buffer.from(valid);
  wrongRiff.writeUInt32LE(0xffffffff, 4); wrongAlign.writeUInt16LE(4, 32); compressed.writeUInt16LE(85, 20);
  const nonfinite = wav({ bits: 32 }); nonfinite.writeFloatLE(Infinity, 58);
  const fact = wav({ bits: 32 }); fact.writeUInt32LE(1, 46);
  const metadata = Buffer.concat([valid.subarray(0, 36), Buffer.from('LIST\x04\x00\x00\x00INFO', 'binary'), valid.subarray(36)]);
  metadata.writeUInt32LE(metadata.length - 8, 4);
  const cases = [Buffer.from('private-secret MP3 contents'), Buffer.from('OggS private-secret contents'), wrongRiff, wrongAlign,
    compressed, valid.subarray(0, -1), nonfinite, fact, metadata];
  for (const [index, source] of cases.entries()) {
    await writeFile(input, source); const output = path.join(directory, `refused-${index}.wav`);
    await assert.rejects(editAudio({ input_path: input, output_path: output }), error => {
      assert.equal(error.code, 'UNSUPPORTED_AUDIO'); assert.ok(!String(error).includes('private-secret'));
      assert.ok(!JSON.stringify(error).includes('private-secret')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
  }
});

test('audio output duration and duplicated selection are bounded before native decoding or effect allocation', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav');
  const source = wav({ frames: 1_300_000 }); await writeFile(input, source);
  await assert.rejects(editAudio({ input_path: input, output_path: path.join(directory, 'slow.wav'), speed: 0.25 }), { code: 'AUDIO_LIMIT' });
  await assert.rejects(trimAudio({ input_path: input, output_path: path.join(directory, 'repeat.wav'),
    ranges: Array.from({ length: 100 }, () => ({ start: 0, end: 162.5 })) }), { code: 'AUDIO_LIMIT' });
  const badRate = wav({ rate: 7999 }); await writeFile(input, badRate);
  await assert.rejects(editAudio({ input_path: input, output_path: path.join(directory, 'rate.wav') }), { code: 'AUDIO_LIMIT' });
  for (const name of ['slow.wav', 'repeat.wav', 'rate.wav']) await assert.rejects(readFile(path.join(directory, name)), { code: 'ENOENT' });
});

test('audio operations enforce file size, local paths, exclusive WAV outputs and cancellation', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.wav'), output = path.join(directory, 'existing.wav');
  const source = wav(); await writeFile(input, source); await writeFile(output, 'keep-existing');
  for (const operation of [editAudio, trimAudio]) {
    const args = { input_path: input, output_path: output, ...(operation === trimAudio ? { ranges: [{ start: 0, end: 0.01 }] } : {}) };
    await assert.rejects(operation(args), { code: 'OUTPUT_EXISTS' }); assert.equal(await readFile(output, 'utf8'), 'keep-existing');
    await assert.rejects(operation({ ...args, output_path: path.join(directory, 'bad.mp3') }), { code: 'OUTPUT_EXTENSION' });
    await assert.rejects(operation({ ...args, input_path: 'https://example.invalid/audio', output_path: path.join(directory, 'remote.wav') }), { code: 'LOCAL_PATH_REQUIRED' });
    await assert.rejects(operation({ ...args, output_path: path.join(directory, 'cancel.wav') }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  }
  const file = await open(input, 'w'); await file.truncate(MAX_AUDIO_INPUT_BYTES + 1); await file.close();
  await assert.rejects(editAudio({ input_path: input, output_path: path.join(directory, 'large.wav') }), { code: 'INPUT_SIZE' });
});
