import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { rotate } from '../vendor/abox/tools/rotate-video/src/rotate.js';
import { rotationMatrix, turned, shownSize } from '../vendor/abox/tools/rotate-video/src/plan.js';
import { convert } from '../vendor/abox/tools/convert-to-mp4/src/convert.js';
import { describeSound } from '../vendor/abox/shared/js/reencode-sound.js';
import { parseVideoCopy, admitVideoOutput, MAX_VIDEO_INPUT_BYTES, MAX_VIDEO_OUTPUT_BYTES } from './video-copy.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

const fail = (code, message) => { throw new AdapterError(code, message); };
const equal = (one, two) => Buffer.from(one).equals(Buffer.from(two));
const verify = () => fail('VERIFICATION_FAILED', 'The copied MP4 packets, descriptions, display matrix or complete frame timeline changed. No output was written.');

function settingsFor(kind, args) {
  const degrees = args.degrees === undefined ? 90 : args.degrees, keepAudio = args.keep_audio === undefined ? true : args.keep_audio;
  if (typeof keepAudio !== 'boolean' || kind === 'rotate' && ![90, 180, 270].includes(degrees)) {
    fail('INVALID_ARGUMENTS', 'Use boolean keep_audio and a clockwise turn of 90, 180 or 270 degrees.');
  }
  return { degrees, keepAudio };
}

function simplePicture(video, structure) {
  if (structure.fragmented) fail('UNSUPPORTED_VIDEO', 'This copy-only route requires complete ordinary MP4 sample tables; fragmented media is unsupported.');
  if (video.codedWidth > 32767 || video.codedHeight > 32767) fail('VIDEO_DIMENSIONS', 'Copy-only matrix geometry must fit the signed 16.16 translation range.');
  const standard = rotationMatrix(video.rotation, video.codedWidth, video.codedHeight), untranslated = Uint8Array.from(standard);
  untranslated.fill(0, 24, 32);
  if (!equal(video.matrix, standard) && !equal(video.matrix, untranslated)
      || video.trackWidth !== video.codedWidth * 65536 || video.trackHeight !== video.codedHeight * 65536) {
    fail('UNSUPPORTED_VIDEO_MATRIX', 'Only ordinary quarter-turn matrices with unstretched coded track dimensions are supported. Complex transforms, scaling and offsets are refused.');
  }
  const entry = Buffer.from(video.sampleEntry);
  for (let at = 86; at + 8 <= entry.length;) {
    const size = entry.readUInt32BE(at), type = entry.toString('latin1', at + 4, at + 8);
    if (size < 8 || at + size > entry.length) fail('UNSUPPORTED_VIDEO', 'The visual sample description is incomplete.');
    if (type === 'clap' || type === 'pasp' && (size !== 16 || !entry.readUInt32BE(at + 8) || entry.readUInt32BE(at + 8) !== entry.readUInt32BE(at + 12))) {
      fail('UNSUPPORTED_VIDEO_MATRIX', 'Clean-aperture cropping and non-square pixel-aspect descriptions are unsupported by this copy-only route.');
    }
    at += size;
  }
}

function simpleClock(track) {
  let firstShown = Infinity;
  for (const sample of track.samples) firstShown = Math.min(firstShown, sample.pts);
  if (track.samples[0].dts !== 0 || firstShown !== 0) {
    fail('UNSUPPORTED_VIDEO_TIMELINE', 'Copy-only rotation/remux requires tracks starting at decode and presentation time zero. Composition preroll or delayed starts are refused rather than silently normalized.');
  }
}

function checkTrack(originalBytes, original, outputBytes, actual) {
  if (!actual || !equal(original.sampleEntry, actual.sampleEntry) || original.timescale !== actual.timescale
      || original.duration !== actual.duration || original.samples.length !== actual.samples.length) verify();
  for (let index = 0; index < original.samples.length; index++) {
    const before = original.samples[index], after = actual.samples[index];
    const beforeDuration = (original.samples[index + 1]?.dts ?? original.duration) - before.dts;
    const afterDuration = (actual.samples[index + 1]?.dts ?? actual.duration) - after.dts;
    if (before.dts !== after.dts || before.pts !== after.pts || before.isKey !== after.isKey || beforeDuration !== afterDuration
        || !equal(originalBytes.subarray(before.offset, before.offset + before.size), outputBytes.subarray(after.offset, after.offset + after.size))) verify();
  }
}

async function processVideo(kind, input, settings) {
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength), parsed = await parseVideoCopy(source), { media, file, structure } = parsed;
  const { video, audio } = media; simplePicture(video, structure); simpleClock(video);
  if (kind === 'remux' && (!/^avc[13]\./.test(video.codec) || !['avc1', 'avc3'].includes(video.entryType))) {
    fail('VIDEO_REMUX_CODEC', 'Copy-only MP4 remux accepts H.264 avc1/avc3 tracks. Other codecs would need decoding and are refused.');
  }
  const sound = settings.keepAudio && audio ? describeSound(audio) : null;
  if (settings.keepAudio && audio && !sound?.copyable) {
    fail('VIDEO_AUDIO_COPY_UNSUPPORTED', 'This source audio cannot be copied as supported AAC. Explicitly choose keep_audio:false to omit it; no audio encoder is invoked.');
  }
  if (sound) simpleClock(audio);
  const tracks = [video, ...(sound ? [audio] : [])], count = tracks.reduce((sum, track) => sum + track.samples.length, 0),
    payload = tracks.reduce((sum, track) => sum + track.samples.reduce((total, sample) => total + sample.size, 0), 0);
  admitVideoOutput(payload, count, tracks.reduce((sum, track) => sum + track.sampleEntry.length, 0));
  const made = kind === 'rotate' ? await rotate({ file, media, sound, turn: settings.degrees, bake: false, soundJob: sound ? 'copy' : 'none', fps: 30 })
    : await convert({ file, media, sound, jobs: { picture: 'copy', sound: sound ? 'copy' : 'none' }, fps: 30 });
  if (!made.blob.size || made.blob.size > MAX_VIDEO_OUTPUT_BYTES) fail('OUTPUT_SIZE', 'The copy-only MP4 output exceeds 128 MiB.');
  const bytes = Buffer.from(await made.blob.arrayBuffer()), checked = await parseVideoCopy(bytes, false), actual = checked.media;
  checkTrack(source, video, bytes, actual.video);
  if (sound) checkTrack(source, audio, bytes, actual.audio); else if (actual.audio) verify();
  const rotation = kind === 'rotate' ? turned(video.rotation, settings.degrees) : video.rotation;
  const matrix = kind === 'rotate' ? rotationMatrix(rotation, video.codedWidth, video.codedHeight) : video.matrix;
  const dimensions = shownSize(video, rotation);
  if (!equal(actual.video.matrix, matrix) || actual.video.rotation !== rotation || actual.video.codedWidth !== video.codedWidth
      || actual.video.codedHeight !== video.codedHeight || actual.video.trackWidth !== video.trackWidth || actual.video.trackHeight !== video.trackHeight
      || actual.video.displayWidth !== dimensions.width || actual.video.displayHeight !== dimensions.height
      || actual.duration !== media.duration || checked.structure.edits.length || made.frames !== video.samples.length) verify();
  return { data: Uint8Array.from(bytes), result: { format: 'mp4', rotation, width: dimensions.width, height: dimensions.height,
    coded_width: video.codedWidth, coded_height: video.codedHeight, duration_seconds: actual.duration, video_samples: actual.video.samples.length,
    audio_samples: actual.audio?.samples.length ?? 0, audio_copied: Boolean(sound), reencoded: false, verified: true,
    verification: { packet_bytes: true, track_descriptions: true, display_matrix: true, frame_timing: true, edit_lists: true, decoding: false },
    warnings: ['Compressed packets are copied without decoding. Verification establishes the exact copy and header/timing behavior, not playback validity or content safety.',
      ...(kind === 'rotate' ? ['Rotation is written as a track display matrix. Players that ignore that matrix may show the original orientation; no pixels are baked or re-encoded.'] : []),
      'Only the supported video and requested AAC track are exported. Other tracks and container metadata are omitted; this is not anonymization or redaction.',
      'Incoming edited timelines, composition preroll, delayed tracks, fragmented media, complex transforms and unsupported audio-copy requests are refused.'] } };
}

async function isolated(kind, bytes, settings, { signal } = {}) {
  const input = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-video-transform', operation: kind, input, settings },
    transferList: [input.buffer], execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Copy-only video processing exceeded two minutes.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('VIDEO_RESOURCE_LIMIT', 'The isolated MP4 worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('VIDEO_RESOURCE_LIMIT', 'The isolated MP4 worker stopped before returning a verified result.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

async function invoke(kind, args, options) {
  options.signal?.throwIfAborted(); const settings = settingsFor(kind, args), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.mp4') fail('OUTPUT_EXTENSION', 'Copy-only video output must use a new .mp4 file.');
  const input = await readInput(args.input_path, { max_bytes: MAX_VIDEO_INPUT_BYTES }); options.signal?.throwIfAborted();
  const made = await isolated(kind, input.data, settings, options), data = Buffer.from(made.data);
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: `video-${kind}`, input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, ...(kind === 'rotate' ? { degrees: settings.degrees } : {}), ...made.result };
}

export const rotateVideo = (args, options = {}) => invoke('rotate', args, options);
export const remuxVideo = (args, options = {}) => invoke('remux', args, options);

if (!isMainThread && workerData?.kind === 'abox-video-transform') {
  try {
    const result = await processVideo(workerData.operation, workerData.input, workerData.settings);
    parentPort.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'INVALID_VIDEO', message: 'The existing copy-only video engine could not process this file. No output was written.' } });
  } finally { parentPort.close(); }
}
