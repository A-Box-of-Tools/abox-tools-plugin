import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diffText, MAX_DIFF_INPUT_BYTES, MAX_DIFF_LINES } from '../src/text-diff.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-text-diff-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function inputs(directory, left, right, name = '') {
  const a = path.join(directory, `left${name}.txt`), b = path.join(directory, `right${name}.txt`);
  await writeFile(a, left); await writeFile(b, right);
  return { left_path: a, right_path: b, output_path: path.join(directory, `comparison${name}.diff`) };
}

test('text diff writes an exact unified patch while returning only metadata and preserving both sources', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const left = 'top\nold confidential content\nbottom\n';
  const right = 'top\nnew unreleased content\nbottom\n';
  const args = await inputs(directory, left, right);
  const result = await diffText({ ...args, context_lines: 1 });
  const expected = '--- a\n+++ b\n@@ -1,3 +1,3 @@\n top\n-old confidential content\n+new unreleased content\n bottom\n';
  assert.equal(await readFile(args.output_path, 'utf8'), expected);
  assert.equal(result.operation, 'text-diff');
  assert.equal(result.format, 'unified-diff');
  assert.equal(result.left_lines, 3); assert.equal(result.right_lines, 3);
  assert.equal(result.added_lines, 1); assert.equal(result.removed_lines, 1); assert.equal(result.unchanged_lines, 2);
  assert.equal(result.hunk_count, 1); assert.equal(result.identical, false);
  assert.equal(result.ending_changes, 0);
  assert.equal(result.source_reconstruction_verified, true);
  assert.equal(result.patch_application_verified, true); assert.equal(result.verified, true);
  assert.equal(result.minimality_guaranteed, false); assert.equal(result.coarse_rewrite_detected, false);
  assert.equal(result.output_bytes, Buffer.byteLength(expected));
  assert.ok(!JSON.stringify(result).includes('confidential'));
  assert.ok(!JSON.stringify(result).includes('unreleased'));
  const actual = await readFile(args.output_path);
  await assert.rejects(diffText(args), hasCode('OUTPUT_EXISTS'));
  assert.equal(hash(await readFile(args.output_path)), hash(actual));
  assert.equal(await readFile(args.left_path, 'utf8'), left);
  assert.equal(await readFile(args.right_path, 'utf8'), right);
});

test('unified output preserves CRLF, standalone CR, a UTF-8 BOM and missing final newline bytes', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const cases = [
    ['one\r\ntwo\r\n', 'one\ntwo\n', '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-one\r\n-two\r\n+one\n+two\n'],
    ['one', 'one\n', '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+one\n'],
    ['one\rtwo\r', 'one\tchanged\rtwo\r', '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-one\rtwo\r\n\\ No newline at end of file\n+one\tchanged\rtwo\r\n\\ No newline at end of file\n'],
    ['\ufeffsame\n', 'same\n', '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-\ufeffsame\n+same\n'],
  ];
  for (const [index, [left, right, expected]] of cases.entries()) {
    const args = await inputs(directory, left, right, String(index));
    const result = await diffText(args);
    assert.deepEqual(await readFile(args.output_path), Buffer.from(expected, 'utf8'));
    assert.equal(result.patch_application_verified, true);
    assert.deepEqual(await readFile(args.left_path), Buffer.from(left, 'utf8'));
    assert.deepEqual(await readFile(args.right_path), Buffer.from(right, 'utf8'));
  }
});

test('empty and identical inputs produce correct zero-byte patches or creation/deletion ranges', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  for (const [index, [left, right, expected]] of [
    ['', '', ''], ['unchanged\n', 'unchanged\n', ''],
    ['', 'created\n', '--- a\n+++ b\n@@ -0,0 +1,1 @@\n+created\n'],
    ['removed\n', '', '--- a\n+++ b\n@@ -1,1 +0,0 @@\n-removed\n'],
  ].entries()) {
    const args = await inputs(directory, left, right, String(index));
    const result = await diffText(args);
    assert.equal(await readFile(args.output_path, 'utf8'), expected);
    assert.equal(result.identical, left === right);
    assert.equal(result.output_bytes, Buffer.byteLength(expected));
    assert.equal(result.patch_application_verified, true);
  }
});

test('ignore settings change only comparison summaries and zero context can produce separate verified hunks', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const args = await inputs(directory, 'Alpha   beta\n\n', 'alpha beta\n');
  const result = await diffText({ ...args, ignore_case: true, ignore_whitespace: true, ignore_blank_lines: true });
  const patch = await readFile(args.output_path, 'utf8');
  assert.equal(result.added_lines, 1); assert.equal(result.removed_lines, 2);
  assert.equal(result.comparison_stats.added_lines, 0); assert.equal(result.comparison_stats.removed_lines, 0);
  assert.equal(result.comparison_stats.unchanged_lines, 1);
  assert.equal(result.identical, false);
  assert.ok(patch.includes('-Alpha   beta\n-\n+alpha beta\n'));
  assert.ok(result.warnings.some(message => message.includes('original unfiltered')));
  const separated = await inputs(directory, 'keep0\nold1\nkeep2\nold3\nkeep4\n', 'keep0\nnew1\nkeep2\nnew3\nkeep4\n', 'separate');
  const split = await diffText({ ...separated, context_lines: 0 });
  assert.equal(split.hunk_count, 2);
  assert.equal(await readFile(separated.output_path, 'utf8'), '--- a\n+++ b\n@@ -2,1 +2,1 @@\n-old1\n+new1\n@@ -4,1 +4,1 @@\n-old3\n+new3\n');
});

test('large full-middle rewrites remain reconstructable and are reported without a minimality claim', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const original = Array.from({ length: 1100 }, (_, index) => `line ${index}`);
  for (const [index, right] of [[...original].reverse(), original.map(value => `new ${value}`)].entries()) {
    const args = await inputs(directory, `${original.join('\n')}\n`, `${right.join('\n')}\n`, String(index));
    const result = await diffText(args);
    assert.equal(result.coarse_rewrite_detected, true);
    assert.equal(result.minimality_guaranteed, false);
    assert.equal(result.removed_lines, original.length);
    assert.equal(result.added_lines, right.length);
    assert.equal(result.patch_application_verified, true);
    assert.ok(result.warnings.some(message => message.includes('full-middle rewrite')));
    assert.equal(result.hunk_count, 1);
  }
});

test('text diff bounds settings, combined bytes and lines, UTF-8, local paths and exclusive outputs', { timeout: 30000 }, async t => {
  for (const settings of [{ ignore_case: 1 }, { ignore_whitespace: 'yes' }, { ignore_blank_lines: 1 },
    { context_lines: -1 }, { context_lines: 101 }, { context_lines: 1.5 }]) {
    await assert.rejects(diffText(settings), hasCode('INVALID_ARGUMENTS'));
  }
  const directory = await workspace(t);
  const args = await inputs(directory, 'left\n', 'right\n');
  await assert.rejects(diffText({ ...args, left_path: 'https://example.com/private.txt' }), hasCode('LOCAL_PATH_REQUIRED'));
  await assert.rejects(diffText({ ...args, output_path: args.left_path }), hasCode('OUTPUT_EXISTS'));
  await assert.rejects(diffText({ ...args, output_path: path.join(directory, 'wrong.html') }), hasCode('OUTPUT_EXTENSION'));
  const invalid = await inputs(directory, Buffer.from([0xff]), '', 'utf8');
  await assert.rejects(diffText(invalid), hasCode('INVALID_UTF8'));
  const binary = await inputs(directory, 'private\0binary', '', 'binary');
  await assert.rejects(diffText(binary), error => {
    assert.equal(error.code, 'BINARY_TEXT_INPUT'); assert.ok(!error.message.includes('private')); return true;
  });
  const many = await inputs(directory, 'row\n'.repeat(MAX_DIFF_LINES + 1), '', 'lines');
  await assert.rejects(diffText(many), hasCode('TEXT_DIFF_LIMIT'));
  const large = await inputs(directory, '', '', 'large');
  for (const filename of [large.left_path, large.right_path]) {
    const file = await open(filename, 'r+');
    try { await file.truncate(MAX_DIFF_INPUT_BYTES / 2 + 1); } finally { await file.close(); }
  }
  await assert.rejects(diffText(large), hasCode('INPUT_SIZE'));
  for (const output of [args.output_path, invalid.output_path, binary.output_path, many.output_path, large.output_path]) {
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  assert.equal(await readFile(args.left_path, 'utf8'), 'left\n');
  assert.equal(await readFile(args.right_path, 'utf8'), 'right\n');
});

test('a cancelled text comparison cannot publish a new patch', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const lines = Array.from({ length: 9000 }, (_, index) => `line ${index}`);
  const args = await inputs(directory, lines.join('\n'), [...lines].reverse().join('\n'));
  const originalHashes = await Promise.all([args.left_path, args.right_path].map(async filename => hash(await readFile(filename))));
  await assert.rejects(diffText(args, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController();
  const pending = diffText(args, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  await assert.rejects(stat(args.output_path), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all([args.left_path, args.right_path].map(async filename => hash(await readFile(filename)))), originalHashes);
});
