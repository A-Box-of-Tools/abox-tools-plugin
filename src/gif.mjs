import path from 'node:path';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseGif, frameData } from '../vendor/abox/tools/gif-analyzer/src/gif.js';
import { budget } from '../vendor/abox/tools/gif-analyzer/src/budget.js';
import { lzwDecode } from '../vendor/abox/tools/gif-analyzer/src/lzw.js';
import { playedDelay } from '../vendor/abox/shared/js/gif-decode.js';
import { frameName } from '../vendor/abox/tools/split-gif/src/frames.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_GIF_INPUT_BYTES = 32 * 2 ** 20;
export const MAX_GIF_FRAMES = 1000;
export const MAX_GIF_OUTPUTS = 200;
export const MAX_GIF_SIDE = 8192;
export const MAX_GIF_PIXELS = 32_000_000;
export const MAX_GIF_DECODED_PIXELS = 128 * 2 ** 20;
export const MAX_GIF_WALK_PIXELS = 300_000_000;
export const MAX_GIF_OUTPUT_BYTES = 32 * 2 ** 20;
export const MAX_GIF_TOTAL_OUTPUT_BYTES = 256 * 2 ** 20;
const TIMEOUT_MS = 120_000;

function dimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_GIF_SIDE)
      || width * height > MAX_GIF_PIXELS) {
    throw new AdapterError('GIF_DIMENSIONS', 'GIF screens and frame rectangles must fit within 8192 pixels per side and 32 megapixels.');
  }
}

function analyze(bytes, verifyLzw = false) {
  const signature = Buffer.from(bytes.subarray(0, 6));
  if (bytes.length < 13 || !['GIF87a', 'GIF89a'].some(value => signature.equals(Buffer.from(value)))) {
    throw new AdapterError('INVALID_GIF', 'The input must contain a GIF87a or GIF89a file with a readable header.');
  }
  const gif = parseGif(bytes);
  dimensions(gif.width, gif.height);
  if (gif.frames.length > MAX_GIF_FRAMES) throw new AdapterError('GIF_FRAME_LIMIT', 'At most 1000 source GIF frames are supported.');
  const frames = gif.frames.map(frame => {
    dimensions(frame.width, frame.height);
    return { frame_index: frame.index + 1, x: frame.left, y: frame.top, width: frame.width, height: frame.height,
      delay_cs: frame.delay, played_delay_seconds: playedDelay(frame.delay), disposal: frame.disposal,
      interlaced: frame.interlaced, local_palette: frame.localPalette,
      palette_entries: (frame.palette ?? gif.globalPalette)?.count ?? 0,
      transparent_index: frame.transparentIndex, min_code_size: frame.minCodeSize,
      compressed_bytes: frame.payloadBytes, control_well_formed: frame.control?.wellFormed ?? true,
      user_input: frame.control?.userInput ?? false };
  });
  const costs = budget(gif);
  const result = { format: 'gif', version: gif.version, width: gif.width, height: gif.height,
    frame_count: frames.length, frames, loop_count: gif.loop,
    global_palette_entries: gif.globalPalette?.count ?? 0, background_index: gif.backgroundIndex,
    nominal_duration_seconds: frames.reduce((sum, frame) => sum + frame.delay_cs, 0) / 100,
    played_duration_seconds: frames.reduce((sum, frame) => sum + Math.round(frame.played_delay_seconds * 100), 0) / 100,
    decoded_patch_pixels: frames.reduce((sum, frame) => sum + frame.width * frame.height, 0),
    extension_counts: { comment: gif.extensions.filter(item => item.kind === 'comment').length,
      application: gif.extensions.filter(item => item.kind === 'application').length,
      plain_text: gif.extensions.filter(item => item.kind === 'plain-text').length,
      other: gif.extensions.filter(item => !['comment', 'application', 'plain-text'].includes(item.kind)).length },
    container_complete: !gif.truncated && gif.trailerAt >= 0 && gif.problems.length === 0,
    problem_count: gif.problems.length, trailing_bytes: gif.trailingBytes,
    byte_budget: { total: costs.total, accounted: costs.accounted, matches: costs.total === costs.accounted,
      categories: Object.fromEntries(costs.rows.map(row => [row.key, row.bytes])) } };
  if (verifyLzw) {
    requireExtractable(result, { mode: 'stored', frames: [1] });
    for (const frame of gif.frames) {
      // The splitter's best-effort decoder stops once it fills the rectangle.
      // The independent analyzer continues through the end code and exposes
      // underflow/overrun, so complete extraction can refuse either tolerance.
      const data = frameData(bytes, frame), decoded = lzwDecode(data, frame.minCodeSize, frame.width * frame.height);
      if (!decoded.complete || decoded.truncated || decoded.corrupt || decoded.overrun
          || decoded.pixels !== frame.width * frame.height || decoded.bytesRead !== data.length) {
        throw new AdapterError('INVALID_GIF_PIXELS', 'A GIF frame has missing, corrupt, excess or incomplete LZW data. No output was written.');
      }
    }
  }
  return result;
}

function failure(error) {
  return error instanceof AdapterError ? { code: error.code, message: error.message }
    : { code: 'INVALID_GIF', message: 'The existing GIF reader could not read this file. No output was written.' };
}

async function analyzeWorker(bytes, options, verifyLzw = false) {
  const data = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'abox-gif', bytes: data, verifyLzw }, transferList: [data.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'GIF inspection exceeded the two-minute limit. Use a smaller input.')), TIMEOUT_MS);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('GIF_RESOURCE_LIMIT', 'GIF inspection could not finish within its isolated resource limit.')));
    worker.on('exit', () => finish(new AdapterError('GIF_RESOURCE_LIMIT', 'GIF inspection stopped before producing a result.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

export async function inspectGif(args, options = {}) {
  options.signal?.throwIfAborted();
  const offset = args.frame_offset ?? 0, limit = args.frame_limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_GIF_FRAMES
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AdapterError('INVALID_ARGUMENTS', 'frame_offset must be 0 to 999 and frame_limit must be 1 to 100.');
  }
  const input = await readInput(args.input_path, { max_bytes: MAX_GIF_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const analysis = await analyzeWorker(input.data, options);
  options.signal?.throwIfAborted();
  const next = Math.min(analysis.frame_count, offset + limit), more = next < analysis.frame_count;
  return { ok: true, operation: 'gif-inspect', input_path: input.path, input_bytes: input.data.length,
    ...analysis, frames: analysis.frames.slice(offset, next), frame_offset: offset, frame_limit: limit,
    frames_truncated: more, next_frame_offset: more ? next : null, header_only: true,
    verified: false, verification: { container_structure: analysis.container_complete && analysis.byte_budget.matches,
      lzw: false, pixels: false }, warnings: ['Header-only inspection does not decode or validate LZW streams or frame pixels. Embedded text, application identifiers and palette colors are omitted.'] };
}

function selection(args, analysis) {
  const mode = args.mode ?? 'composited';
  if (!['composited', 'stored'].includes(mode)) throw new AdapterError('INVALID_ARGUMENTS', 'mode must be composited or stored.');
  const frames = args.frames ?? Array.from({ length: analysis.frame_count }, (_, at) => at + 1);
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_GIF_OUTPUTS
      || frames.some(frame => !Number.isSafeInteger(frame) || frame < 1 || frame > analysis.frame_count)
      || new Set(frames).size !== frames.length) {
    throw new AdapterError('GIF_SELECTION', 'Select 1 to 200 distinct, existing, one-based GIF frame numbers. For longer GIFs, supply frames explicitly.');
  }
  return { mode, frames: [...frames].sort((a, b) => a - b) };
}

function requireExtractable(analysis, plan) {
  if (!analysis.frame_count || !analysis.container_complete || !analysis.byte_budget.matches || analysis.trailing_bytes) {
    throw new AdapterError('GIF_INCOMPLETE', 'Frame extraction requires a complete, accounted GIF container without trailing bytes. Inspection can report a damaged file.');
  }
  if (analysis.extension_counts.plain_text || analysis.frames.some(frame => !frame.control_well_formed || frame.user_input
      || frame.disposal > 3 || frame.min_code_size < 2 || frame.min_code_size > 8 || !frame.palette_entries
      || frame.transparent_index >= frame.palette_entries)) {
    throw new AdapterError('GIF_UNSUPPORTED', 'Plain-text graphics, interactive timing, reserved disposal, invalid palettes or nonstandard GIF control/code-size fields are unsupported for extraction.');
  }
  if (analysis.decoded_patch_pixels > MAX_GIF_DECODED_PIXELS) {
    throw new AdapterError('GIF_PIXEL_LIMIT', 'GIF extraction supports at most 128 Mi decoded patch pixels across all source frames.');
  }
  if (plan.mode === 'composited' && analysis.width * analysis.height * plan.frames.at(-1) > MAX_GIF_WALK_PIXELS) {
    throw new AdapterError('GIF_PIXEL_LIMIT', 'The composited frame walk exceeds 300 million logical-screen pixels. Select earlier frames or use stored mode.');
  }
}

async function startBrowser(page, input, analysis, plan) {
  await page.locator('#input').setInputFiles({ name: 'source.gif', mimeType: 'image/gif', buffer: input.data });
  return page.evaluate(async ({ expected, mode, maxPixels, maxPng }) => {
    const { decodeGif } = await import('/vendor/abox/shared/js/gif-decode.js');
    const { GifCanvas } = await import('/vendor/abox/shared/js/gif-compose.js');
    const { headerWorkingPlan, gifWorkingBase, withWorkingBytes } = await import('/vendor/abox/tools/split-gif/src/working.js');
    const bytes = new Uint8Array(await document.querySelector('#input').files[0].arrayBuffer());
    const initial = headerWorkingPlan(bytes);
    if (!initial?.fits) return { error: 'memory' };
    const expectedLargest = mode === 'stored' ? expected.frames.reduce((size, frame) => frame.width * frame.height > size.width * size.height ? frame : size, expected.frames[0]) : expected;
    const extraIndex = Math.max(0, ...expected.frames.filter(frame => frame.interlaced).map(frame => frame.width * frame.height));
    const extraData = Math.max(0, ...expected.frames.map(frame => frame.compressed_bytes));
    // Metadata is sufficient to reserve every retained index before decode.
    // The byte view below is only for the upstream unique-buffer accounting;
    // no palette or pixel arrays are invented or allocated for this estimate.
    const metadata = { width: expected.width, height: expected.height, globalPalette: bytes,
      frames: expected.frames.map(frame => ({ width: frame.width, height: frame.height, disposal: frame.disposal })) };
    const predecode = withWorkingBytes(gifWorkingBase(metadata, { stored: mode === 'stored' }), {
      thumbnailRgbaBytes: expected.decoded_patch_pixels + extraIndex + extraData
        + expectedLargest.width * expectedLargest.height * 4 + expectedLargest.width * 8,
      incomingBytes: maxPng,
    });
    if (!predecode.fits) return { error: 'memory' };
    let gif;
    try { gif = decodeGif(bytes, { maxPixels, strictMaxPixels: true }); }
    catch { return { error: 'decode' }; }
    if (gif.truncated || gif.width !== expected.width || gif.height !== expected.height || gif.frames.length !== expected.frame_count
        || gif.loopCount !== expected.loop_count || gif.frames.some((frame, at) => {
          const source = expected.frames[at];
          return frame.partial || frame.width !== source.width || frame.height !== source.height || frame.x !== source.x || frame.y !== source.y
            || frame.delay !== source.delay_cs || frame.disposal !== source.disposal || frame.interlaced !== source.interlaced
            || frame.transparentIndex !== source.transparent_index || frame.palette.length !== source.palette_entries * 3
            || frame.indices.length !== frame.width * frame.height || frame.indices.some(index => index >= source.palette_entries);
        })) return { error: 'decode' };
    const largest = mode === 'stored' ? gif.frames.reduce((size, frame) => frame.width * frame.height > size.width * size.height ? frame : size, gif.frames[0]) : gif;
    // Verification retains one native decoded bitmap and only one canvas row.
    // Native PNG/base64 ownership follows the upstream incoming-byte reserve.
    const base = gifWorkingBase(gif, { stored: mode === 'stored' });
    const memory = withWorkingBytes(base, { thumbnailRgbaBytes: largest.width * largest.height * 4 + largest.width * 8,
      incomingBytes: maxPng });
    if (!memory.fits) return { error: 'memory' };
    globalThis.__aboxGif = { gif, compositor: mode === 'composited' ? new GifCanvas(gif) : null, mode };
    return { ready: true, working_bytes: Math.max(predecode.bytes, memory.bytes) };
  }, { expected: analysis, mode: plan.mode, maxPixels: MAX_GIF_DECODED_PIXELS, maxPng: MAX_GIF_OUTPUT_BYTES });
}

async function browserFrame(page, frameIndex) {
  return page.evaluate(async ({ frameIndex, maxBytes }) => {
    const { patchPixels } = await import('/vendor/abox/shared/js/gif-compose.js');
    const { encodePng } = await import('/vendor/abox/tools/split-gif/src/frames.js');
    const state = globalThis.__aboxGif, frame = state.gif.frames[frameIndex - 1];
    let pixels, width, height, bitmap, canvas;
    try {
      if (state.mode === 'stored') { pixels = patchPixels(frame); width = frame.width; height = frame.height; }
      else {
        let drawn; while (state.compositor.at < frameIndex) drawn = state.compositor.next();
        pixels = drawn.pixels; width = state.gif.width; height = state.gif.height;
      }
      const blob = await encodePng(pixels, width, height);
      if (blob.type !== 'image/png' || !blob.size || blob.size > maxBytes) return { error: 'size' };
      bitmap = await createImageBitmap(blob);
      if (bitmap.width !== width || bitmap.height !== height) return { error: 'verify' };
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      for (let y = 0; y < height; y++) {
        context.clearRect(0, 0, width, 1); context.drawImage(bitmap, 0, y, width, 1, 0, 0, width, 1);
        const row = context.getImageData(0, 0, width, 1).data, offset = y * width * 4;
        for (let at = 0; at < row.length; at++) if (row[at] !== pixels[offset + at]) return { error: 'verify' };
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      return { data, width, height, verified_pixels: width * height };
    } catch { return { error: 'verify' }; }
    finally { bitmap?.close(); if (canvas) canvas.width = canvas.height = 0; }
  }, { frameIndex, maxBytes: MAX_GIF_OUTPUT_BYTES });
}

function verifyPng(data, width, height) {
  if (data.length < 33 || data.length > MAX_GIF_OUTPUT_BYTES
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
    throw new AdapterError('VERIFICATION_FAILED', 'An extracted PNG had an unexpected format or size. No output was retained.');
  }
}

export async function extractGifFrames(args, options = {}) {
  options.signal?.throwIfAborted();
  const outputDir = await newOutput(args.output_dir), input = await readInput(args.input_path, { max_bytes: MAX_GIF_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const analysis = await analyzeWorker(input.data, options, true), plan = selection(args, analysis);
  requireExtractable(analysis, plan); options.signal?.throwIfAborted();
  await mkdir(outputDir);
  const outputs = [], owned = []; let total = 0, workingBytes = 0;
  const manifestPath = path.join(outputDir, 'timing.json');
  try {
    await withBrowser(async page => {
      const started = await startBrowser(page, input, analysis, plan);
      if (started.error) throw new AdapterError(started.error === 'memory' ? 'GIF_WORKING_LIMIT' : 'INVALID_GIF_PIXELS',
        started.error === 'memory' ? 'The GIF exceeds the existing splitter’s 512 MiB estimated working-buffer policy.'
          : 'The GIF decoder did not produce complete, consistent frame pixels. No output was retained.');
      workingBytes = started.working_bytes;
      for (const number of plan.frames) {
        options.signal?.throwIfAborted();
        const made = await browserFrame(page, number);
        if (made.error) throw new AdapterError(made.error === 'size' ? 'OUTPUT_SIZE' : 'VERIFICATION_FAILED',
          made.error === 'size' ? 'An extracted PNG exceeds the 32 MiB output limit. No output was retained.'
            : 'An extracted PNG did not retain the source engine’s exact frame pixels. No output was retained.');
        const frame = analysis.frames[number - 1], width = plan.mode === 'stored' ? frame.width : analysis.width,
          height = plan.mode === 'stored' ? frame.height : analysis.height;
        if (made.width !== width || made.height !== height || made.verified_pixels !== width * height) {
          throw new AdapterError('VERIFICATION_FAILED', 'An extracted frame had unexpected verified dimensions. No output was retained.');
        }
        const data = Buffer.from(made.data, 'base64'); verifyPng(data, width, height); total += data.length;
        if (total > MAX_GIF_TOTAL_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'Extracted PNGs exceed the combined 256 MiB output limit. No output was retained.');
        const output = path.join(outputDir, frameName('frame.gif', number, analysis.frame_count));
        options.signal?.throwIfAborted(); await writeNew(output, data); owned.push(output);
        outputs.push({ frame_index: number, output_path: output, output_bytes: data.length, width, height,
          delay_cs: frame.delay_cs, played_delay_seconds: frame.played_delay_seconds, disposal: frame.disposal,
          source_rectangle: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, verified: true,
          verified_pixels: made.verified_pixels });
      }
    }, options);
    options.signal?.throwIfAborted();
    await writeNew(manifestPath, `${JSON.stringify({ input_path: input.path, mode: plan.mode, loop_count: analysis.loop_count,
      source_width: analysis.width, source_height: analysis.height, outputs }, null, 2)}\n`); owned.push(manifestPath);
    options.signal?.throwIfAborted();
  } catch (error) {
    // The new directory may contain files introduced by somebody else. Remove
    // only successful writes recorded by this call, then remove it if empty.
    for (const file of owned) await rm(file, { force: true }).catch(() => {});
    await rmdir(outputDir).catch(() => {});
    throw error;
  }
  return { ok: true, operation: 'gif-split', input_path: input.path, input_bytes: input.data.length,
    input_frames: analysis.frame_count, output_dir: outputDir, mode: plan.mode, output_count: outputs.length,
    output_bytes: total, outputs: outputs.slice(0, 20), outputs_truncated: outputs.length > 20, manifest_path: manifestPath,
    format: 'png', verified: true, verification: { container_structure: true, decoded_frames: analysis.frame_count,
      lzw_end_codes: true, png_pixels: outputs.reduce((sum, output) => sum + output.verified_pixels, 0) }, estimated_working_bytes: workingBytes,
    warnings: ['PNG frames do not carry animation timing; timing.json preserves the selected frame delays, rectangles and loop count.',
      'Disposal 2 clears to transparent. Composited mode replays preceding frames; stored mode exports each original patch. Out-of-screen patches follow the existing engine’s clipping behavior.'] };
}

if (!isMainThread && workerData?.kind === 'abox-gif') {
  try { parentPort.postMessage({ result: analyze(workerData.bytes, workerData.verifyLzw) }); }
  catch (error) { parentPort.postMessage({ error: failure(error) }); }
  finally { parentPort.close(); }
}
