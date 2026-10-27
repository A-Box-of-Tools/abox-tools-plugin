import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { lengthAfter } from '../vendor/abox/tools/edit-audio/src/edit.js';
import { invertRanges, planSections, sectionFrames } from '../vendor/abox/tools/trim-audio/src/trim.js';
import { withBrowser } from './browser.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_AUDIO_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MAX_AUDIO_FRAMES = 12_000_000;
export const MAX_AUDIO_SAMPLES = 24_000_000;
export const MAX_AUDIO_DURATION = 600;
export const MAX_AUDIO_RANGES = 100;
const setting = (args, key, fallback) => args[key] === undefined ? fallback : args[key];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const numberIn = (value, low, high) => finite(value) && value >= low && value <= high;
const fail = message => { throw new AdapterError('UNSUPPORTED_AUDIO', message); };

function boundedAudio(frames, channels, sampleRate, bits) {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_AUDIO_FRAMES
      || ![1, 2].includes(channels) || frames * channels > MAX_AUDIO_SAMPLES
      || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
      || frames / sampleRate > MAX_AUDIO_DURATION) {
    throw new AdapterError('AUDIO_LIMIT', 'Audio must fit within mono/stereo, 8–96 kHz, 600 seconds, 12 million frames and 24 million channel samples, including output.');
  }
  const bytes = (bits === 32 ? 58 : 44) + frames * channels * bits / 8;
  if (bytes > MAX_AUDIO_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The planned WAV exceeds the 128 MiB output limit.');
  return bytes;
}

async function wavInfo(bytes, signal, output = false) {
  const tag = at => bytes.toString('latin1', at, at + 4);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    fail('This bounded audio adapter accepts uncompressed little-endian PCM16 or Float32 WAV files. Compressed audio and video require a separate pre-decode admission layer.');
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) fail('The WAV RIFF size must match the complete local file.');
  let format, data, fact, chunks = 0;
  for (let at = 12; at < bytes.length;) {
    signal?.throwIfAborted();
    if (++chunks > 4096 || at + 8 > bytes.length) fail('The WAV chunk structure is unsupported or incomplete.');
    const type = tag(at), size = bytes.readUInt32LE(at + 4), start = at + 8, end = start + size;
    if (end + (size & 1) > bytes.length) fail('The WAV contains an incomplete chunk.');
    if (type === 'fmt ') {
      if (format || data || ![16, 18].includes(size)) fail('Use one ordinary PCM16 or Float32 WAV format chunk before its audio data.');
      const code = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), sampleRate = bytes.readUInt32LE(start + 4);
      const byteRate = bytes.readUInt32LE(start + 8), align = bytes.readUInt16LE(start + 12), bits = bytes.readUInt16LE(start + 14);
      if (!(code === 1 && bits === 16 || code === 3 && bits === 32)
          || size === 18 && bytes.readUInt16LE(start + 16) !== 0
          || ![1, 2].includes(channels) || align !== channels * bits / 8 || byteRate !== sampleRate * align) {
        fail('Only mono/stereo PCM16 or IEEE Float32 WAV with consistent frame and byte rates is supported.');
      }
      format = { code, channels, sample_rate: sampleRate, bits, align };
    } else if (type === 'data') {
      if (!format || data || !size || size % format.align) fail('Use one nonempty WAV data chunk containing complete uncompressed frames.');
      data = { start, size };
    } else if (type === 'fact') {
      if (fact !== undefined || size !== 4) fail('The WAV fact chunk is unsupported.');
      fact = bytes.readUInt32LE(start);
    } else if (type !== 'JUNK' || output) {
      fail('This WAV subset accepts fmt, data, fact and optional JUNK chunks; nested audio, metadata chunks and extensible/compressed formats are refused.');
    }
    at = end + (size & 1);
  }
  if (!format || !data) fail('The WAV has no supported format or sample data.');
  const frames = data.size / format.align;
  boundedAudio(frames, format.channels, format.sample_rate, format.bits);
  if (fact !== undefined && fact !== frames) fail('The WAV fact frame count disagrees with its sample data.');
  if (format.code === 3) {
    for (let at = data.start; at < data.start + data.size; at += 4) {
      if (!Number.isFinite(bytes.readFloatLE(at))) fail('Nonfinite Float32 audio samples are unsupported.');
      if (((at - data.start) & 0xfffff) === 0) { signal?.throwIfAborted(); await yieldTurn(); }
    }
  }
  return { ...format, frames, duration_seconds: frames / format.sample_rate, data_start: data.start, data_bytes: data.size };
}

function settingsFor(args, kind) {
  const bits = setting(args, 'bits', 16);
  if (![16, 32].includes(bits)) throw new AdapterError('INVALID_ARGUMENTS', 'WAV bits must be 16 for PCM or 32 for IEEE Float32.');
  if (kind === 'trim') {
    const mode = setting(args, 'mode', 'keep'), fade = setting(args, 'fade_ms', 5);
    if (!['keep', 'cut'].includes(mode) || !numberIn(fade, 0, 50)
        || !Array.isArray(args.ranges) || args.ranges.length < 1 || args.ranges.length > MAX_AUDIO_RANGES
        || args.ranges.some(range => !range || typeof range !== 'object' || Array.isArray(range)
          || Object.keys(range).some(key => !['start', 'end'].includes(key))
          || !finite(range.start) || !finite(range.end) || range.start < 0 || range.end <= range.start)) {
      throw new AdapterError('INVALID_ARGUMENTS', 'Choose 1–100 finite start/end ranges in seconds, keep or cut mode, and fade_ms from 0 to 50.');
    }
    return { bits, mode, fade_ms: fade, ranges: args.ranges.map(range => ({ start: range.start, end: range.end })) };
  }
  const result = { bits, reverse: setting(args, 'reverse', false), speed: setting(args, 'speed', 1),
    keep_pitch: setting(args, 'keep_pitch', true), volume_mode: setting(args, 'volume_mode', 'gain'),
    gain_db: setting(args, 'gain_db', 0), normalize_db: setting(args, 'normalize_db', -1) };
  if (typeof result.reverse !== 'boolean' || typeof result.keep_pitch !== 'boolean' || !numberIn(result.speed, 0.25, 4)
      || !['gain', 'normalize'].includes(result.volume_mode) || !numberIn(result.gain_db, -60, 24)
      || !numberIn(result.normalize_db, -60, 0)
      || result.volume_mode === 'gain' && args.normalize_db !== undefined
      || result.volume_mode === 'normalize' && args.gain_db !== undefined) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose boolean reverse/keep_pitch, speed 0.25–4, and either gain_db -60–24 or normalize_db -60–0 for the selected volume_mode.');
  }
  return result;
}

async function processAudio(args, options, kind) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args, kind), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.wav') throw new AdapterError('OUTPUT_EXTENSION', 'Audio operations write a new .wav file.');
  const input = await readInput(args.input_path, { max_bytes: MAX_AUDIO_INPUT_BYTES });
  const info = await wavInfo(input.data, options.signal);
  let sections, frames;
  if (kind === 'trim') {
    if (settings.ranges.some(range => range.end > info.duration_seconds)) {
      throw new AdapterError('AUDIO_RANGE', 'Every audio range must fit within the source duration; ranges are never silently clipped.');
    }
    const ranges = settings.mode === 'cut' ? invertRanges(settings.ranges, info.duration_seconds) : settings.ranges;
    sections = planSections(ranges, { sampleRate: info.sample_rate, totalFrames: info.frames, fadeSeconds: settings.fade_ms / 1000 });
    if (settings.mode === 'keep' && sections.length !== ranges.length) throw new AdapterError('AUDIO_RANGE', 'Each kept range must contain at least one source sample after rounding.');
    frames = sectionFrames(sections);
    if (!frames) throw new AdapterError('AUDIO_RANGE', 'The selection leaves no audio samples to write.');
  } else frames = lengthAfter(info.frames, settings.speed, settings.keep_pitch);
  const expectedBytes = boundedAudio(frames, info.channels, info.sample_rate, settings.bits);
  options.signal?.throwIfAborted();
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'source.wav', mimeType: 'audio/wav', buffer: input.data });
    return page.evaluate(async ({ kind, settings, sourceInfo, sections, frames, expectedBytes }) => {
      const { decodeAudio } = await import('/vendor/abox/shared/js/audio-decode.js');
      const { writeWavAsync } = await import('/vendor/abox/shared/js/wav-async.js');
      const refuse = (code, message) => ({ error: { code, message } });
      try {
        const source = await decodeAudio(document.querySelector('#input').files[0]);
        if (source.guessedRate || source.frames !== sourceInfo.frames || source.sampleRate !== sourceInfo.sample_rate
            || source.channels.length !== sourceInfo.channels || source.channels.some(channel => channel.length !== sourceInfo.frames)) {
          return refuse('VERIFICATION_FAILED', 'The native WAV decoder disagreed with the bounded source header.');
        }
        let rendered;
        if (kind === 'trim') {
          const { trim } = await import('/vendor/abox/tools/trim-audio/src/trim.js');
          rendered = await trim(source, sections, { t: key => key });
        } else {
          const { render } = await import('/vendor/abox/tools/edit-audio/src/edit.js');
          rendered = await render(source, { reverse: settings.reverse, speed: settings.speed, keepPitch: settings.keep_pitch,
            volume: { mode: settings.volume_mode, db: settings.volume_mode === 'normalize' ? settings.normalize_db : settings.gain_db } });
        }
        const channels = rendered.channels;
        if (channels.length !== sourceInfo.channels || channels.some(channel => channel.length !== frames)) return refuse('VERIFICATION_FAILED', 'The audio engine produced an unexpected channel or frame count.');
        const blob = await writeWavAsync(channels, source.sampleRate, { bits: settings.bits });
        if (blob.size !== expectedBytes || blob.type !== 'audio/wav') return refuse('VERIFICATION_FAILED', 'The WAV writer disagreed with the bounded output plan.');
        const headerBytes = settings.bits === 32 ? 58 : 44, header = new DataView(await blob.slice(0, headerBytes).arrayBuffer());
        const tag = at => String.fromCharCode(...new Uint8Array(header.buffer, at, 4));
        if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt '
            || header.getUint32(4, true) !== expectedBytes - 8 || header.getUint16(20, true) !== (settings.bits === 32 ? 3 : 1)
            || header.getUint16(22, true) !== channels.length || header.getUint32(24, true) !== source.sampleRate
            || header.getUint32(28, true) !== source.sampleRate * channels.length * settings.bits / 8
            || header.getUint16(32, true) !== channels.length * settings.bits / 8 || header.getUint16(34, true) !== settings.bits
            || tag(headerBytes - 8) !== 'data' || header.getUint32(headerBytes - 4, true) !== frames * channels.length * settings.bits / 8
            || settings.bits === 32 && (tag(38) !== 'fact' || header.getUint32(46, true) !== frames)) {
          return refuse('VERIFICATION_FAILED', 'The encoded WAV header did not retain the planned sample structure.');
        }
        let clipped = 0, blocks = 0;
        const blockFrames = 8192, bytesPerFrame = channels.length * settings.bits / 8;
        for (let from = 0; from < frames; from += blockFrames) {
          const to = Math.min(frames, from + blockFrames);
          const actual = new DataView(await blob.slice(headerBytes + from * bytesPerFrame, headerBytes + to * bytesPerFrame).arrayBuffer());
          for (let frame = from; frame < to; frame++) for (let channel = 0; channel < channels.length; channel++) {
            const sample = channels[channel][frame], at = ((frame - from) * channels.length + channel) * settings.bits / 8;
            if (!Number.isFinite(sample)) return refuse('VERIFICATION_FAILED', 'The audio engine produced nonfinite samples. No output was written.');
            if (Math.abs(sample) > 1) clipped++;
            if (settings.bits === 32) {
              if (!Object.is(actual.getFloat32(at, true), sample)) return refuse('VERIFICATION_FAILED', 'Float32 WAV samples did not retain the processed samples.');
            } else {
              const expected = sample >= 1 ? 32767 : sample <= -1 ? -32768 : Math.round(sample * (sample < 0 ? 32768 : 32767));
              if (actual.getInt16(at, true) !== expected) return refuse('VERIFICATION_FAILED', 'PCM16 WAV samples did not match the processed samples.');
            }
          }
          if (++blocks % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('read failed')); reader.readAsDataURL(blob);
        });
        return { data, clipped_samples: clipped, verification: { header: true, all_encoded_samples: true, samples_checked: frames * channels.length } };
      } catch { return refuse('AUDIO_PROCESSING_FAILED', 'The installed browser could not decode, process or verify this WAV. No output was written.'); }
    }, { kind, settings, sourceInfo: info, sections, frames, expectedBytes });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64'); delete made.data;
  if (data.length !== expectedBytes) throw new AdapterError('VERIFICATION_FAILED', 'The returned WAV did not match its bounded output size.');
  const checked = await wavInfo(data, options.signal, true);
  if (checked.frames !== frames || checked.channels !== info.channels || checked.sample_rate !== info.sample_rate || checked.bits !== settings.bits) {
    throw new AdapterError('VERIFICATION_FAILED', 'The returned WAV structure did not match its processing plan.');
  }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: kind === 'trim' ? 'trim-audio' : 'edit-audio', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: 'wav', bits: settings.bits,
    channels: checked.channels, sample_rate: checked.sample_rate, frames, duration_seconds: checked.duration_seconds,
    input_frames: info.frames, input_duration_seconds: info.duration_seconds, source_metadata_copied: false,
    ...(kind === 'trim' ? { mode: settings.mode, section_count: sections.length, fade_ms: settings.fade_ms }
      : { reverse: settings.reverse, speed: settings.speed, keep_pitch: settings.keep_pitch, volume_mode: settings.volume_mode,
        ...(settings.volume_mode === 'gain' ? { gain_db: settings.gain_db } : { normalize_db: settings.normalize_db }) }),
    verified: true, ...made, warnings: ['Only the bounded PCM16/Float32 WAV subset is accepted. Source metadata is not copied.',
      settings.bits === 16 ? 'PCM16 rounds and clamps processed decoded samples; it does not preserve original compressed or higher-precision audio.'
        : 'Float32 retains the processed decoded samples, including finite values beyond full scale; it cannot recover prior source losses.',
      ...(made.clipped_samples ? [settings.bits === 16 ? 'Samples beyond full scale were clipped when writing PCM16.'
        : 'Some Float32 samples exceed full scale and may distort in a player.'] : []),
      ...(kind === 'trim' && settings.mode === 'cut' ? ['The existing cut-selection engine omits leftover gaps of one millisecond or less.'] : []),
      ...(kind === 'edit' && settings.speed !== 1 ? [settings.keep_pitch ? 'Pitch-preserving time stretch can smear transients.' : 'Resampling changes pitch with speed.'] : [])] };
}

export function editAudio(args, options = {}) { return processAudio(args, options, 'edit'); }
export function trimAudio(args, options = {}) { return processAudio(args, options, 'trim'); }
