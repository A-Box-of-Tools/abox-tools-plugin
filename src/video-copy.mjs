import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { demux, UnsupportedTimeline } from '../vendor/abox/shared/js/mp4-reader.js';
import { joinByCopy, copyRefusal } from '../vendor/abox/tools/trim-video/src/copy.js';
import { joinability } from '../vendor/abox/tools/trim-video/src/clips.js';
import { planRanges } from '../vendor/abox/tools/trim-video/src/ranges.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_VIDEO_INPUT_BYTES = 64 * 2 ** 20;
export const MAX_VIDEO_OUTPUT_BYTES = 128 * 2 ** 20;
export const MAX_VIDEO_SAMPLES = 100000;
export const MAX_VIDEO_BOXES = 10000;
export const MAX_VIDEO_CLIPS = 8;
export const MAX_VIDEO_RANGES = 20;
export const MAX_VIDEO_DURATION = 21600;
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);
const tableWidths = { stts: 8, ctts: 8, stss: 4, stsc: 12, stco: 4, co64: 8 };
const refuse = (code, message) => { throw new AdapterError(code, message); };

function insideMdat(offset, length, mdats) {
  let low = 0, high = mdats.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (mdats[middle].start <= offset) low = middle + 1;
    else high = middle;
  }
  const payload = mdats[low - 1];
  return Boolean(payload && offset >= payload.start && offset + length <= payload.end);
}

// The source demuxer trusts declared counts before allocating sample arrays.
// Bound those table declarations and prove the enclosing bytes first.
export function preflightMp4(bytes) {
  let boxes = 0, samples = 0, fragments = 0, fragmented = false;
  const edits = [], tracks = [], mdats = [];
  const tableFor = (track, parent, type, body, count) => {
    if (!track || parent !== 'stbl') return;
    if (track.tables[type]) refuse('INVALID_VIDEO', 'Duplicate MP4 sample tables are unsupported.');
    track.tables[type] = { body, count };
  };
  const walk = (start, end, depth = 0, track = null, parent = null) => {
    if (depth > 16) refuse('VIDEO_STRUCTURE_LIMIT', 'MP4 box nesting exceeds 16 containers.');
    let at = start;
    while (at < end) {
      if (++boxes > MAX_VIDEO_BOXES || end - at < 8) refuse('INVALID_VIDEO', 'The MP4 box structure is incomplete or too complex.');
      let size = bytes.readUInt32BE(at), head = 8;
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (size === 1) {
        if (end - at < 16) refuse('INVALID_VIDEO', 'An extended MP4 box header is incomplete.');
        const wide = bytes.readBigUInt64BE(at + 8);
        if (wide > BigInt(end - at)) refuse('INVALID_VIDEO', 'An MP4 box extends beyond its container.');
        size = Number(wide); head = 16;
      } else if (!size) size = end - at;
      if (size < head || size > end - at) refuse('INVALID_VIDEO', 'An MP4 box extends beyond its container.');
      const body = at + head, limit = at + size;
      const need = count => { if (body + count > limit) refuse('INVALID_VIDEO', 'An MP4 table header is incomplete.'); };
      if ((type === 'moof' && depth === 0) || (type === 'mvex' && parent === 'moov' && depth === 1)) fragmented = true;
      if (type === 'mdat' && depth === 0) mdats.push({ start: body, end: limit });
      if (type === 'trak') {
        const record = { kind: null, tables: Object.create(null), sample_tables: 0 };
        tracks.push(record); walk(body, limit, depth + 1, record, type);
      } else if (containers.has(type)) {
        if (type === 'stbl' && track) track.sample_tables++;
        walk(body, limit, depth + 1, track, type);
      } else if (type === 'hdlr' && track && parent === 'mdia') {
        need(12);
        if (track.kind !== null) refuse('INVALID_VIDEO', 'Duplicate MP4 track handlers are unsupported.');
        track.kind = bytes.toString('latin1', body + 8, body + 12);
      }
      else if (Object.hasOwn(tableWidths, type)) {
        need(8); const count = bytes.readUInt32BE(body + 4);
        if (count > MAX_VIDEO_SAMPLES || body + 8 + count * tableWidths[type] !== limit) {
          refuse('VIDEO_SAMPLE_LIMIT', 'MP4 table counts or lengths exceed the bounded supported layout.');
        }
        tableFor(track, parent, type, body, count);
      } else if (type === 'stsz') {
        need(12); const uniform = bytes.readUInt32BE(body + 4), count = bytes.readUInt32BE(body + 8);
        samples += count;
        if (samples > MAX_VIDEO_SAMPLES || body + 12 + (uniform ? 0 : count * 4) !== limit) {
          refuse('VIDEO_SAMPLE_LIMIT', 'MP4 input has excessive or incomplete declared samples.');
        }
        tableFor(track, parent, type, body, count);
      } else if (type === 'stz2') refuse('UNSUPPORTED_VIDEO', 'Compact MP4 sample-size tables are unsupported by the existing engine.');
      else if (type === 'trun') {
        need(8); fragments += bytes.readUInt32BE(body + 4);
        if (fragments > MAX_VIDEO_SAMPLES) refuse('VIDEO_SAMPLE_LIMIT', 'Fragmented MP4 sample counts exceed 100000.');
      } else if (type === 'stsd') {
        need(16);
        const entry = body + 8, entrySize = bytes.readUInt32BE(entry);
        if (bytes.readUInt32BE(body + 4) !== 1 || entrySize < 8 || entry + entrySize !== limit) {
          refuse('UNSUPPORTED_VIDEO', 'A selected MP4 track must contain exactly one complete ordinary sample description.');
        }
        if (++boxes > MAX_VIDEO_BOXES) refuse('VIDEO_STRUCTURE_LIMIT', 'MP4 box count exceeds 10000.');
        // Codec child boxes are walked by the source reader even though sample
        // descriptions are otherwise opaque bytes copied by its writer.
        const headerBytes = track?.kind === 'vide' ? 78 : track?.kind === 'soun' ? 28 : null;
        if (headerBytes === null || entry + 8 + headerBytes > limit) refuse('UNSUPPORTED_VIDEO', 'The MP4 sample description or track ordering is unsupported.');
        walk(entry + 8 + headerBytes, limit, depth + 1, null, 'sample-entry');
      } else if (type === 'elst') {
        need(8); const version = bytes[body], count = bytes.readUInt32BE(body + 4), width = version === 1 ? 20 : 12;
        if (version > 1 || count > MAX_VIDEO_RANGES * MAX_VIDEO_CLIPS || body + 8 + count * width !== limit) {
          refuse('UNSUPPORTED_VIDEO_TIMELINE', 'The MP4 edit-list layout is unsupported.');
        }
        const entries = [];
        for (let i = 0; i < count; i++) {
          const p = body + 8 + i * width;
          entries.push({ duration: version ? Number(bytes.readBigUInt64BE(p)) : bytes.readUInt32BE(p),
            mediaTime: version ? Number(bytes.readBigInt64BE(p + 8)) : bytes.readInt32BE(p + 4),
            rate: bytes.readUInt32BE(p + (version ? 16 : 8)) });
        }
        edits.push(entries);
      }
      at = limit;
    }
  };
  walk(0, bytes.length);
  if (samples + fragments > MAX_VIDEO_SAMPLES) refuse('VIDEO_SAMPLE_LIMIT', 'The combined MP4 sample declarations exceed 100000.');
  if (!fragmented) for (const track of tracks.filter(track => ['vide', 'soun'].includes(track.kind))) {
    const { stsz, stts, ctts, stsc, stco, co64, stss } = track.tables;
    if (track.sample_tables !== 1 || !stsz || !stts || !stsc || Boolean(stco) === Boolean(co64)) {
      refuse('INVALID_VIDEO', 'Each plain MP4 track needs one complete set of unambiguous sample tables.');
    }
    const count = stsz.count;
    const coverage = (table, composition) => {
      if (bytes.readUInt32BE(table.body) !== 0 && !(composition && bytes.readUInt32BE(table.body) === 0x01000000)) {
        refuse('VIDEO_TIMELINE', 'MP4 timing-table versions or flags are unsupported.');
      }
      let covered = 0, duration = 0;
      for (let row = 0; row < table.count; row++) {
        const at = table.body + 8 + row * 8, run = bytes.readUInt32BE(at);
        const delta = bytes.readUInt32BE(at + 4);
        if (!run || covered + run > count || (!composition && !delta)) {
          refuse('VIDEO_TIMELINE', 'MP4 timing runs do not describe the declared samples exactly.');
        }
        covered += run;
        if (!composition) duration += run * delta;
      }
      if (covered !== count) refuse('VIDEO_TIMELINE', 'MP4 timing runs do not cover every declared sample.');
      return duration;
    };
    track.decode_duration = coverage(stts, false);
    if (ctts) coverage(ctts, true);
    if (stss) {
      let previous = 0;
      for (let row = 0; row < stss.count; row++) {
        const index = bytes.readUInt32BE(stss.body + 8 + row * 4);
        if (index <= previous || index > count) refuse('INVALID_VIDEO', 'MP4 sync-sample indices must be unique, ordered and inside the sample table.');
        previous = index;
      }
    }
    const chunks = stco ?? co64, runs = [];
    let total = 0;
    for (let row = 0; row < stsc.count; row++) {
      const at = stsc.body + 8 + row * 12, first = bytes.readUInt32BE(at), perChunk = bytes.readUInt32BE(at + 4);
      if (!first || first > chunks.count || !perChunk || bytes.readUInt32BE(at + 8) !== 1
          || (row === 0 ? first !== 1 : first <= runs.at(-1).first)) {
        refuse('INVALID_VIDEO', 'MP4 chunk runs must be ordered, cover the first chunk and use the sole sample description.');
      }
      runs.push({ first, perChunk });
    }
    for (let row = 0; row < runs.length; row++) {
      total += ((runs[row + 1]?.first ?? chunks.count + 1) - runs[row].first) * runs[row].perChunk;
      if (total > count) refuse('VIDEO_SAMPLE_LIMIT', 'MP4 chunks claim more samples than the size table.');
    }
    if (total !== count || (count && !runs.length) || (!count && (runs.length || chunks.count))) {
      refuse('VIDEO_SAMPLE_LIMIT', 'MP4 chunks and size tables must describe exactly the same samples.');
    }
    let sample = 0, run = 0;
    const uniform = bytes.readUInt32BE(stsz.body + 4);
    for (let chunk = 0; chunk < chunks.count; chunk++) {
      while (run + 1 < runs.length && runs[run + 1].first <= chunk + 1) run++;
      const at = chunks.body + 8 + chunk * (co64 ? 8 : 4);
      const wide = co64 ? bytes.readBigUInt64BE(at) : BigInt(bytes.readUInt32BE(at));
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) refuse('INVALID_VIDEO', 'An MP4 chunk offset exceeds supported file bounds.');
      const offset = Number(wide);
      let length = 0;
      for (let index = 0; index < runs[run].perChunk; index++) {
        const size = uniform || bytes.readUInt32BE(stsz.body + 12 + sample * 4);
        if (!size) refuse('INVALID_VIDEO', 'Zero-byte MP4 samples are unsupported.');
        length += size; sample++;
      }
      if (!insideMdat(offset, length, mdats)) refuse('INVALID_VIDEO', 'Every MP4 chunk must stay wholly inside an mdat payload.');
    }
    track.declared_samples = count;
  }
  return { boxes, declared_samples: samples + fragments, edits, tracks, mdats, fragmented };
}

function validateMedia(media, size, structure) {
  let count = 0;
  for (const track of [media.video, media.audio].filter(Boolean)) {
    if (!Number.isSafeInteger(track.timescale) || track.timescale < 1 || !Number.isSafeInteger(track.duration)
        || track.duration < 1 || track.duration / track.timescale > MAX_VIDEO_DURATION) {
      refuse('VIDEO_TIMELINE', 'MP4 track clocks must describe a finite positive duration of at most six hours.');
    }
    count += track.samples.length;
    const declared = structure.tracks.find(item => item.kind === (track === media.video ? 'vide' : 'soun'));
    if (!structure.fragmented && (track.samples.length !== declared?.declared_samples || track.duration !== declared?.decode_duration)) {
      refuse('VIDEO_TIMELINE', 'MP4 decoded sample counts or media duration disagree with the complete timing tables.');
    }
    let previous = -1;
    for (const sample of track.samples) {
      if (![sample.offset, sample.size, sample.dts, sample.pts].every(Number.isSafeInteger)
          || sample.offset < 0 || sample.size < 1 || sample.offset + sample.size > size
          || !insideMdat(sample.offset, sample.size, structure.mdats)
          || sample.dts < 0 || sample.dts <= previous || sample.pts < 0 || sample.pts >= track.duration) {
        refuse('VIDEO_TIMELINE', 'MP4 sample bounds or timestamps are inconsistent with the declared track.');
      }
      previous = sample.dts;
    }
  }
  if (!media.video.samples.length || count > MAX_VIDEO_SAMPLES) refuse('VIDEO_SAMPLE_LIMIT', 'The MP4 has no readable video samples or exceeds 100000 combined samples.');
  const video = media.video;
  if (![video.codedWidth, video.codedHeight, video.displayWidth, video.displayHeight].every(value => Number.isInteger(value) && value > 0 && value <= 32768)) {
    refuse('VIDEO_DIMENSIONS', 'The MP4 video has unsupported declared dimensions.');
  }
}

async function parse(bytes, incoming = true) {
  const structure = preflightMp4(bytes), file = new File([bytes], 'local.mp4', { type: 'video/mp4' });
  let media;
  try { media = await demux(file, { timeline: incoming ? 'incoming' : 'media' }); }
  catch (error) {
    if (error instanceof UnsupportedTimeline) refuse('UNSUPPORTED_VIDEO_TIMELINE', 'Incoming MP4 edit lists are not a full-span identity. The existing engine refuses them rather than expose hidden media.');
    refuse('UNSUPPORTED_VIDEO', 'The existing MP4/MOV reader could not read this container, codec or track layout. No playback fallback is used.');
  }
  validateMedia(media, bytes.length, structure);
  if (structure.tracks.filter(track => track.kind === 'vide').length !== 1
      || structure.tracks.filter(track => track.kind === 'soun').length > 1
      || (structure.tracks.some(track => track.kind === 'soun') && !media.audio)) {
    refuse('UNSUPPORTED_VIDEO_TRACKS', 'Exactly one readable video and at most one readable unencrypted audio track are supported.');
  }
  return { file, media, structure };
}

function summary(media) {
  return { format: 'mp4/mov', duration_seconds: media.duration,
    video: { codec: media.video.codec, coded_width: media.video.codedWidth, coded_height: media.video.codedHeight,
      width: media.video.displayWidth, height: media.video.displayHeight, rotation: media.video.rotation,
      sample_count: media.video.samples.length, keyframe_count: media.video.samples.filter(sample => sample.isKey).length,
      timescale: media.video.timescale },
    audio: media.audio ? { sample_entry_type: media.audio.entryType, sample_count: media.audio.samples.length,
      sample_rate: media.audio.sampleRate, channels: media.audio.channels } : null,
    decoding_verified: false };
}

function checkedRanges(raw, duration) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_VIDEO_RANGES || raw.some(range => !range || typeof range !== 'object'
      || Object.keys(range).some(key => !['start', 'end'].includes(key)) || !Number.isFinite(range.start) || !Number.isFinite(range.end)
      || range.start < 0 || range.end - range.start < 0.02 || range.end > duration)) {
    refuse('VIDEO_RANGES', 'Provide 1 to 20 ranges in seconds, each at least 0.02 seconds and fully inside its source duration.');
  }
  return raw;
}

function equalBytes(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }
function packets(input, track, from, to) {
  return track.samples.slice(from, to + 1).map(sample => input.subarray(sample.offset, sample.offset + sample.size));
}

export function admitVideoOutput(payloadBytes, sampleCount, sampleEntryBytes) {
  const bytes = payloadBytes + sampleCount * 128 + sampleEntryBytes + 1024 * 1024;
  if (![payloadBytes, sampleCount, sampleEntryBytes, bytes].every(Number.isSafeInteger)
      || payloadBytes < 0 || sampleCount < 0 || sampleEntryBytes < 0 || bytes > MAX_VIDEO_OUTPUT_BYTES) {
    refuse('OUTPUT_SIZE', 'The planned MP4 packets, copied descriptions and tables exceed the conservative 128 MiB admission bound.');
  }
  return bytes;
}

async function work(kind, inputs, args) {
  const sourceBuffers = inputs.map(bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const parsed = [];
  for (const bytes of sourceBuffers) parsed.push(await parse(bytes));
  if (kind === 'inspect') return { result: { ...summary(parsed[0].media), header_only: true, verified: false,
    warnings: ['Container and sample tables were checked; video and audio packets were not decoded. Metadata text and packet contents are excluded.'] } };
  const keepAudio = args.keep_audio ?? true;
  if (typeof keepAudio !== 'boolean' || typeof (args.allow_preroll ?? false) !== 'boolean') refuse('INVALID_ARGUMENTS', 'Audio and preroll settings must be boolean.');
  const clips = parsed.map((item, i) => ({ ...item, name: `clip-${i + 1}`,
    ranges: kind === 'trim' ? checkedRanges(args.ranges, item.media.duration) : [{ start: 0, end: item.media.duration }] }));
  const compatible = joinability(clips, { keepAudio, t: () => 'incompatible' });
  if (!compatible.copy) refuse('VIDEO_JOIN_MISMATCH', 'Lossless joining requires matching codec descriptions, dimensions, orientation and compatible audio tracks. Re-encoding is not performed.');
  if (copyRefusal(clips)) refuse('VIDEO_INTERNAL_PREROLL', 'Later sections must start on source keyframes; the existing copy engine refuses hidden preroll at internal seams.');
  const videoExpected = [], audioExpected = [], videoEdits = [], audioEdits = [];
  const first = clips[0].media, outVideoTs = first.video.timescale, outAudioTs = first.audio?.timescale;
  let seamSeconds = 0, maxPreroll = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index], { video, audio } = clip.media;
    const useAudio = keepAudio && first.audio && clips.every(item => item.media.audio?.samples.length);
    const { plans } = planRanges({ video, audio: useAudio ? audio : null, ranges: clip.ranges, anchor: 'keyframe' });
    let span = 0;
    for (const plan of plans) {
      maxPreroll = Math.max(maxPreroll, plan.preRoll);
      const nextCount = videoExpected.length + audioExpected.length + plan.video.to - plan.video.from + 1
        + (plan.audio ? plan.audio.to - plan.audio.from + 1 : 0);
      if (nextCount > MAX_VIDEO_SAMPLES) refuse('VIDEO_SAMPLE_LIMIT', 'The output selection exceeds 100000 samples.');
      for (const packet of packets(sourceBuffers[index], video, plan.video.from, plan.video.to)) videoExpected.push(packet);
      if (plan.audio) for (const packet of packets(sourceBuffers[index], audio, plan.audio.from, plan.audio.to)) audioExpected.push(packet);
      const duration = Math.round(Math.max(0, Math.min(plan.end - plan.start,
        (plan.video.spanTs - plan.video.editStart) / video.timescale)) * 1000);
      videoEdits.push({ duration, mediaTime: Math.round(seamSeconds * outVideoTs)
        + Math.round((plan.video.offset + plan.video.editStart) * outVideoTs / video.timescale), rate: 65536 });
      if (plan.audio) audioEdits.push({ duration, mediaTime: Math.round(seamSeconds * outAudioTs)
        + Math.round((plan.audio.offset + plan.audio.editStart) * outAudioTs / audio.timescale), rate: 65536 });
      span += plan.video.spanTs / video.timescale;
    }
    seamSeconds += span;
  }
  if (maxPreroll > 1e-9 && !args.allow_preroll) refuse('VIDEO_PREROLL_REQUIRED', 'The first cut requires hidden keyframe preroll. Choose a keyframe start, or explicitly allow_preroll after accepting that earlier encoded footage remains in the file.');
  if (videoExpected.length + audioExpected.length > MAX_VIDEO_SAMPLES) refuse('VIDEO_SAMPLE_LIMIT', 'The output selection exceeds 100000 samples.');
  const payloadBytes = [...videoExpected, ...audioExpected].reduce((sum, bytes) => sum + bytes.length, 0);
  admitVideoOutput(payloadBytes, videoExpected.length + audioExpected.length,
    first.video.sampleEntry.byteLength + (audioExpected.length ? first.audio.sampleEntry.byteLength : 0));
  const made = await joinByCopy({ clips, keepAudio });
  if (made.blob.size > MAX_VIDEO_OUTPUT_BYTES) refuse('OUTPUT_SIZE', 'The MP4 output exceeds 128 MiB.');
  const bytes = Buffer.from(await made.blob.arrayBuffer()), checked = await parse(bytes, false);
  const actual = checked.media;
  const compareTrack = (track, expected) => {
    if (!track || track.samples.length !== expected.length) refuse('VERIFICATION_FAILED', 'The output MP4 sample count changed.');
    for (let i = 0; i < expected.length; i++) {
      const sample = track.samples[i];
      if (!bytes.subarray(sample.offset, sample.offset + sample.size).equals(expected[i])) refuse('VERIFICATION_FAILED', 'An output MP4 packet differs from its selected source packet.');
    }
  };
  compareTrack(actual.video, videoExpected);
  if (audioExpected.length) compareTrack(actual.audio, audioExpected);
  else if (actual.audio) refuse('VERIFICATION_FAILED', 'The output unexpectedly retained an audio track.');
  const actualEdits = checked.structure.edits;
  if (JSON.stringify(actualEdits) !== JSON.stringify(audioExpected.length ? [videoEdits, audioEdits] : [videoEdits])
      || !equalBytes(actual.video.sampleEntry, first.video.sampleEntry) || !equalBytes(actual.video.matrix, first.video.matrix)
      || (audioExpected.length && !equalBytes(actual.audio.sampleEntry, first.audio.sampleEntry))) {
    refuse('VERIFICATION_FAILED', 'The copied MP4 track descriptions, display matrix or edit lists changed.');
  }
  const data = Uint8Array.from(bytes);
  return { data, result: { format: 'mp4', output_bytes: bytes.length, clip_count: clips.length,
    range_count: videoEdits.length, displayed_duration_seconds: videoEdits.reduce((sum, edit) => sum + edit.duration, 0) / 1000,
    video_samples: videoExpected.length, audio_samples: audioExpected.length, preroll_seconds: maxPreroll,
    reencoded: false, verified: true, verification: { packet_bytes: true, edit_lists: true, track_descriptions: true,
      display_matrix: true, decoding: false }, warnings: [
      'Lossless sample copying can retain encoded preroll, audio boundary packets or presentation-tail frames outside the displayed edit. This is not redaction or a secure way to erase sensitive footage.',
      'Only the first supported video and audio tracks are exported; other tracks and document metadata are omitted. Playback depends on the player honoring edit lists. Incoming edited timelines are refused, including some outputs of this tool.'] } };
}

async function isolated(kind, inputs, args, options) {
  const data = inputs.map(bytes => Uint8Array.from(bytes));
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-video-copy', operation: kind, inputs: data, args },
    transferList: data.map(bytes => bytes.buffer), execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(value); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Video sample processing exceeded two minutes.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message));
    worker.on('error', () => finish(new AdapterError('VIDEO_RESOURCE_LIMIT', 'The isolated MP4 worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('VIDEO_RESOURCE_LIMIT', 'The isolated MP4 worker stopped before returning a result.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

async function invoke(kind, args, options) {
  options.signal?.throwIfAborted();
  const values = kind === 'join' ? args.input_paths : [args.input_path];
  if (!Array.isArray(values) || values.length < (kind === 'join' ? 2 : 1) || values.length > MAX_VIDEO_CLIPS) refuse('INVALID_ARGUMENTS', 'Video joining needs 2 to 8 local clips.');
  const output = kind === 'inspect' ? null : await newOutput(args.output_path);
  if (output && path.extname(output).toLowerCase() !== '.mp4') refuse('OUTPUT_EXTENSION', 'Lossless video output must end in .mp4.');
  const inputs = []; let total = 0;
  for (const value of values) {
    options.signal?.throwIfAborted(); const input = await readInput(value, { max_bytes: MAX_VIDEO_INPUT_BYTES });
    total += input.data.length; if (total > MAX_VIDEO_INPUT_BYTES) refuse('INPUT_SIZE', 'Combined video input is limited to 64 MiB.'); inputs.push(input);
  }
  const made = await isolated(kind, inputs.map(input => input.data), args, options);
  options.signal?.throwIfAborted();
  if (output) await writeNew(output, Buffer.from(made.data));
  return { ok: true, operation: `video-${kind}`, input_paths: inputs.map(input => input.path), input_bytes: total,
    ...(output ? { output_path: output } : {}), ...made.result };
}

export const inspectVideo = (args, options = {}) => invoke('inspect', args, options);
export const trimVideo = (args, options = {}) => invoke('trim', args, options);
export const joinVideos = (args, options = {}) => invoke('join', args, options);
export { parse as parseVideoCopy };

if (!isMainThread && workerData?.kind === 'abox-video-copy') {
  try {
    const result = await work(workerData.operation, workerData.inputs, workerData.args);
    parentPort.postMessage(result, result.data ? [result.data.buffer] : []);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'INVALID_VIDEO', message: 'The existing video engines could not process this file. No output was written.' } });
  } finally { parentPort.close(); }
}
