import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectGif, extractGifFrames, MAX_GIF_INPUT_BYTES, MAX_GIF_FRAMES } from '../src/gif.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-gif-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const u16 = value => [value & 255, value >> 8];
const blocks = data => {
  const out = []; for (let at = 0; at < data.length; at += 255) out.push(Math.min(255, data.length - at), ...data.slice(at, at + 255));
  return [...out, 0];
};

// A clear before each literal keeps every code exactly three bits. These
// fixtures do not reuse the GIF writer or the reader's LZW implementation.
function literals(indices) {
  const codes = indices.flatMap(index => [4, index]); codes.push(5);
  const out = []; let bits = 0, used = 0;
  for (const code of codes) {
    bits |= code << used; used += 3;
    while (used >= 8) { out.push(bits & 255); bits >>= 8; used -= 8; }
  }
  if (used) out.push(bits & 255); return out;
}

function gif({ width = 2, height = 1, frames = [{ width, height, indices: Array(width * height).fill(0) }],
  comment = 'private-embedded-comment', plainText = false, trailer = true } = {}) {
  const out = [...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0x81, 0, 0,
    255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,
    0x21, 0xfe, ...blocks([...Buffer.from(comment)]),
    0x21, 0xff, 11, ...Buffer.from('PRIVATEX123'), ...blocks([...Buffer.from('private-application-data')])];
  if (plainText) out.push(0x21, 1, 12, ...Array(12).fill(0), ...blocks([...Buffer.from('private-text') ]));
  for (const frame of frames) {
    const transparent = frame.transparent ?? -1;
    out.push(0x21, 0xf9, 4, ((frame.disposal ?? 1) << 2) | (transparent >= 0 ? 1 : 0), ...u16(frame.delay ?? 1),
      Math.max(0, transparent), 0, 0x2c, ...u16(frame.x ?? 0), ...u16(frame.y ?? 0), ...u16(frame.width), ...u16(frame.height),
      frame.interlaced ? 0x40 : 0, frame.minCodeSize ?? 2, ...blocks(frame.data ?? literals(frame.indices)));
  }
  if (trailer) out.push(0x3b); return Buffer.from(out);
}

test('GIF inspection reports bounded timing, palette counts and byte accounting without embedded payloads', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif');
  const source = gif({ frames: [{ width: 2, height: 1, indices: [0, 1], delay: 1, disposal: 2 },
    { x: 1, width: 1, height: 1, indices: [2], delay: 5, disposal: 3, transparent: 3 }] });
  await writeFile(input, source); const result = await inspectGif({ input_path: input });
  assert.equal(result.width, 2); assert.equal(result.height, 1); assert.equal(result.frame_count, 2);
  assert.equal(result.loop_count, 0); assert.equal(result.global_palette_entries, 4);
  assert.equal(result.nominal_duration_seconds, 0.06); assert.equal(result.played_duration_seconds, 0.15);
  assert.equal(result.frames[0].played_delay_seconds, 0.1); assert.equal(result.frames[1].x, 1);
  assert.equal(result.frames[1].transparent_index, 3); assert.equal(result.frames[1].disposal, 3);
  assert.equal(result.byte_budget.total, source.length); assert.equal(result.byte_budget.accounted, source.length);
  assert.equal(result.byte_budget.matches, true); assert.equal(result.container_complete, true);
  assert.equal(result.header_only, true); assert.equal(result.verified, false);
  assert.deepEqual(result.verification, { container_structure: true, lzw: false, pixels: false });
  assert.deepEqual(result.extension_counts, { comment: 1, application: 2, plain_text: 0, other: 0 });
  for (const secret of ['private-embedded-comment', 'PRIVATEX123', 'private-application-data', 'NETSCAPE']) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(hash(await readFile(input)), hash(source));
});

test('GIF inspection paginates source frame numbers and identifies header-only damage without claiming LZW validity', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif');
  await writeFile(input, gif({ frames: Array.from({ length: 25 }, () => ({ width: 1, height: 1, indices: [0] })) }));
  const first = await inspectGif({ input_path: input }); assert.equal(first.frames.length, 20);
  assert.equal(first.next_frame_offset, 20); assert.equal(first.frames_truncated, true);
  const rest = await inspectGif({ input_path: input, frame_offset: 20, frame_limit: 3 });
  assert.deepEqual(rest.frames.map(frame => frame.frame_index), [21, 22, 23]); assert.equal(rest.next_frame_offset, 23);
  const end = await inspectGif({ input_path: input, frame_offset: 23, frame_limit: 100 });
  assert.deepEqual(end.frames.map(frame => frame.frame_index), [24, 25]); assert.equal(end.next_frame_offset, null);
  await writeFile(input, gif({ trailer: false })); const damaged = await inspectGif({ input_path: input });
  assert.equal(damaged.container_complete, false); assert.ok(damaged.problem_count > 0); assert.equal(damaged.verification.container_structure, false);
  await writeFile(input, gif({ frames: [{ width: 2, height: 1, indices: [], data: [0] }] }));
  const corruptPixels = await inspectGif({ input_path: input });
  assert.equal(corruptPixels.container_complete, true); assert.equal(corruptPixels.verification.lzw, false); assert.equal(corruptPixels.verified, false);
});

test('GIF extraction refuses unsafe headers, excessive plans and unsupported source features before opening a browser', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif');
  const cases = [
    [gif({ trailer: false }), 'GIF_INCOMPLETE'], [Buffer.concat([gif(), Buffer.from('private-tail')]), 'GIF_INCOMPLETE'],
    [gif({ plainText: true }), 'GIF_UNSUPPORTED'],
    [gif({ frames: [{ width: 1, height: 1, indices: [0], disposal: 7 }] }), 'GIF_UNSUPPORTED'],
    [gif({ frames: [{ width: 1, height: 1, indices: [0], minCodeSize: 1 }] }), 'GIF_UNSUPPORTED'],
    [gif({ width: 8193, height: 1, frames: [{ width: 1, height: 1, indices: [0] }] }), 'GIF_DIMENSIONS'],
    [gif({ frames: [{ width: 8192, height: 8192, indices: [0] }] }), 'GIF_DIMENSIONS'],
    [gif({ width: 4096, height: 4096, frames: Array.from({ length: 9 }, () => ({ width: 4096, height: 4096, indices: [0] })) }), 'GIF_PIXEL_LIMIT'],
    [gif({ width: 4096, height: 4096, frames: Array.from({ length: 20 }, () => ({ width: 1, height: 1, indices: [0] })) }), 'GIF_PIXEL_LIMIT'],
  ];
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `output-${index}`); await writeFile(input, source);
    await assert.rejects(extractGifFrames({ input_path: input, output_dir: output }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes('private-tail')); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
  }
  await writeFile(input, gif({ frames: Array.from({ length: MAX_GIF_FRAMES + 1 }, () => ({ width: 1, height: 1, indices: [0] })) }));
  await assert.rejects(inspectGif({ input_path: input }), { code: 'GIF_FRAME_LIMIT' });
});

test('GIF file, selection and pagination contracts preserve existing output directories', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif'); await writeFile(input, gif());
  for (const [index, fields] of [{ frames: [] }, { frames: [0] }, { frames: [2] }, { frames: [1, 1] }, { frames: [1.5] },
    { frames: '1' }, { frames: Array(201).fill(1) }].entries()) {
    await assert.rejects(extractGifFrames({ input_path: input, output_dir: path.join(directory, `invalid-${index}`), ...fields }), { code: 'GIF_SELECTION' });
  }
  await assert.rejects(extractGifFrames({ input_path: input, output_dir: path.join(directory, 'mode'), mode: 'patch' }), { code: 'INVALID_ARGUMENTS' });
  for (const fields of [{ frame_offset: -1 }, { frame_offset: 1000 }, { frame_offset: 0.5 }, { frame_limit: 0 }, { frame_limit: 101 }]) {
    await assert.rejects(inspectGif({ input_path: input, ...fields }), { code: 'INVALID_ARGUMENTS' });
  }
  const output = path.join(directory, 'existing'); await mkdir(output); const sentinel = path.join(output, 'keep.txt'); await writeFile(sentinel, 'keep');
  await assert.rejects(extractGifFrames({ input_path: input, output_dir: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  await assert.rejects(inspectGif({ input_path: 'relative.gif' }), { code: 'LOCAL_PATH_REQUIRED' });
  const file = await open(input, 'w'); await file.truncate(MAX_GIF_INPUT_BYTES + 1); await file.close();
  for (const operation of [inspectGif, args => extractGifFrames({ ...args, output_dir: path.join(directory, 'large') })]) {
    await assert.rejects(operation({ input_path: input }), { code: 'INPUT_SIZE' });
  }
  await writeFile(input, Buffer.from('private-not-a-GIF'));
  await assert.rejects(inspectGif({ input_path: input }), error => { assert.equal(error.code, 'INVALID_GIF'); assert.ok(!String(error).includes('private-not')); return true; });
  const nonAsciiVersion = gif(); nonAsciiVersion[3] |= 0x80; await writeFile(input, nonAsciiVersion);
  await assert.rejects(inspectGif({ input_path: input }), { code: 'INVALID_GIF' });
});

test('GIF extraction requires an end code and exact LZW cardinality instead of accepting a filled partial rectangle', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif');
  const streams = [[0x04], literals([0, 1]), literals([]), [0x3c], [...literals([0]), 0]];
  for (const [index, data] of streams.entries()) {
    const output = path.join(directory, `invalid-lzw-${index}`);
    await writeFile(input, gif({ width: 1, height: 1, frames: [{ width: 1, height: 1, indices: [], data }] }));
    const header = await inspectGif({ input_path: input }); assert.equal(header.container_complete, true);
    assert.equal(header.verification.lzw, false);
    await assert.rejects(extractGifFrames({ input_path: input, output_dir: output }), { code: 'INVALID_GIF_PIXELS' });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('GIF inspection workers honor cancellation without returning source bytes', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.gif');
  const source = Buffer.concat([gif(), Buffer.alloc(MAX_GIF_INPUT_BYTES - gif().length)]); await writeFile(input, source);
  const before = hash(source);
  await assert.rejects(inspectGif({ input_path: input }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(extractGifFrames({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), pending = inspectGif({ input_path: input }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  assert.equal(hash(await readFile(input)), before);
});
