import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { base64File, formatJson, MAX_TEXT_INPUT_BYTES, MAX_TEXT_OUTPUT_BYTES, MAX_JSON_DEPTH, MAX_JSON_NODES } from '../src/text.mjs';
import { readInput, MAX_INPUT_BYTES } from '../src/files.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-local-text-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const digest = data => createHash('sha256').update(data).digest('hex');

test('JSON formatting preserves exact large numbers, integer-key order, duplicate keys and escape tokens', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json'), output = path.join(directory, 'formatted.json');
  const source = String.raw`{ "10":123456789012345678901234567890,"2":1e999,"10":-0,"escaped":"\u0061\/\n","pair":"\uD83D\uDE00" }`;
  await writeFile(input, source);
  const result = await formatJson({ input_path: input, output_path: output });
  const expected = ['{', '  "10": 123456789012345678901234567890,', '  "2": 1e999,', '  "10": -0,',
    String.raw`  "escaped": "\u0061\/\n",`, String.raw`  "pair": "\uD83D\uDE00"`, '}', ''].join('\n');
  assert.equal(await readFile(output, 'utf8'), expected);
  assert.equal(result.verified, true); assert.equal(result.format, 'json'); assert.equal(result.encoding, 'utf-8');
  assert.equal(result.output_bytes, Buffer.byteLength(expected)); assert.equal(result.max_depth, 1);
  assert.equal(await readFile(input, 'utf8'), source);
  assert.ok(!JSON.stringify(result).includes('123456789012345678901234567890'));
  await assert.rejects(formatJson({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
});

test('JSON natural sorting is stable for duplicate decoded keys and preserves their spelling', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json');
  const source = String.raw`{"item10":10,"2":2,"item2":2,"10":10,"item1":1,"\u0069tem2":3}`;
  await writeFile(input, source);
  const sorted = path.join(directory, 'sorted.json');
  await formatJson({ input_path: input, output_path: sorted, sort_keys: true, minify: true });
  assert.equal(await readFile(sorted, 'utf8'), String.raw`{"2":2,"10":10,"item1":1,"item2":2,"\u0069tem2":3,"item10":10}` + '\n');
  const nested = path.join(directory, 'nested.json'); await writeFile(nested, '{"a":["é",{"b":true}],"empty":{}}');
  for (const indent of ['4', 'tab']) {
    const output = path.join(directory, `indent-${indent}.json`);
    await formatJson({ input_path: nested, output_path: output, indent });
    const unit = indent === 'tab' ? '\t' : '    ';
    const expected = ['{', `${unit}"a": [`, `${unit.repeat(2)}"é",`, `${unit.repeat(2)}{`,
      `${unit.repeat(3)}"b": true`, `${unit.repeat(2)}}`, `${unit}],`, `${unit}"empty": {}`, '}', ''].join('\n');
    assert.equal(await readFile(output, 'utf8'), expected);
  }
});

test('JSON checks nesting, syntax-node and exact output expansion bounds before recursive printing', { timeout: 120000 }, async t => {
  const directory = await workspace(t);
  const boundary = path.join(directory, 'boundary.json'), boundaryOutput = path.join(directory, 'boundary-output.json');
  await writeFile(boundary, '['.repeat(MAX_JSON_DEPTH) + '0' + ']'.repeat(MAX_JSON_DEPTH));
  const result = await formatJson({ input_path: boundary, output_path: boundaryOutput, minify: true });
  assert.equal(result.max_depth, MAX_JSON_DEPTH);
  const deep = path.join(directory, 'deep.json'), deepOutput = path.join(directory, 'deep-output.json');
  await writeFile(deep, '['.repeat(MAX_JSON_DEPTH + 1) + '0' + ']'.repeat(MAX_JSON_DEPTH + 1));
  await assert.rejects(formatJson({ input_path: deep, output_path: deepOutput }), { code: 'JSON_LIMIT' });
  await assert.rejects(readFile(deepOutput), { code: 'ENOENT' });
  const wide = path.join(directory, 'wide.json'), wideOutput = path.join(directory, 'wide-output.json');
  await writeFile(wide, '[' + Array(MAX_JSON_NODES).fill('0').join(',') + ']');
  await assert.rejects(formatJson({ input_path: wide, output_path: wideOutput, minify: true }), { code: 'JSON_LIMIT' });
  const expanding = path.join(directory, 'expanding.json'), expandingOutput = path.join(directory, 'expanding-output.json');
  const compact = '['.repeat(255) + '[' + Array(40000).fill('0').join(',') + ']' + ']'.repeat(255);
  await writeFile(expanding, compact);
  await assert.rejects(formatJson({ input_path: expanding, output_path: expandingOutput, indent: '4' }), { code: 'OUTPUT_SIZE' });
  await assert.rejects(readFile(expandingOutput), { code: 'ENOENT' });
  const minified = path.join(directory, 'small-output.json');
  const recovered = await formatJson({ input_path: expanding, output_path: minified, minify: true });
  assert.equal(await readFile(minified, 'utf8'), compact + '\n'); assert.ok(recovered.output_bytes < MAX_TEXT_OUTPUT_BYTES);
});

test('JSON syntax and UTF-8 errors expose positions without source contents', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json'), output = path.join(directory, 'output.json');
  await writeFile(input, '{\n  "private-secret-value": ]\n}');
  await assert.rejects(formatJson({ input_path: input, output_path: output }), error => {
    assert.equal(error.code, 'INVALID_JSON'); assert.equal(error.line, 2); assert.ok(error.column > 1);
    assert.ok(!String(error).includes('private-secret-value')); assert.ok(!JSON.stringify(error).includes('private-secret-value')); return true;
  });
  await writeFile(input, Buffer.from([0x22, 0xff, 0x22]));
  await assert.rejects(formatJson({ input_path: input, output_path: output }), { code: 'INVALID_UTF8' });
  await writeFile(input, '');
  await assert.rejects(formatJson({ input_path: input, output_path: output }), { code: 'INVALID_JSON' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(input, Buffer.from('\ufeff{"a":1}', 'utf8'));
  await formatJson({ input_path: input, output_path: output });
  assert.equal(await readFile(output, 'utf8'), '{\n  "a": 1\n}\n');
  await assert.rejects(formatJson({ input_path: input, output_path: path.join(directory, 'wrong.txt') }), { code: 'OUTPUT_EXTENSION' });
});

test('Base64 matches independent RFC4648 vectors, all byte values and URL-safe spelling', async t => {
  const directory = await workspace(t);
  const vectors = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
  for (const [index, [text, encoded]] of vectors.entries()) {
    const input = path.join(directory, `source-${index}.bin`), output = path.join(directory, `encoded-${index}.txt`), decoded = path.join(directory, `decoded-${index}.bin`);
    await writeFile(input, text);
    const result = await base64File({ input_path: input, output_path: output, mode: 'encode' });
    assert.equal(await readFile(output, 'utf8'), encoded); assert.equal(result.output_bytes, encoded.length); assert.equal(result.verified, true);
    await base64File({ input_path: output, output_path: decoded, mode: 'decode', canonical: true });
    assert.equal(await readFile(decoded, 'utf8'), text); assert.equal(await readFile(input, 'utf8'), text);
  }
  const all = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const input = path.join(directory, 'all-bytes.bin'); await writeFile(input, all);
  for (const url_safe of [false, true]) {
    const output = path.join(directory, `all-${url_safe}.txt`), decoded = path.join(directory, `all-${url_safe}.bin`);
    await base64File({ input_path: input, output_path: output, mode: 'encode', url_safe });
    const encoded = await readFile(output, 'utf8');
    assert.equal(encoded, all.toString(url_safe ? 'base64url' : 'base64')); assert.ok(!encoded.includes('\n'));
    await base64File({ input_path: output, output_path: decoded, mode: 'decode', url_safe, canonical: true });
    assert.deepEqual(await readFile(decoded), all);
  }
  assert.deepEqual(await readFile(input), all);
});

test('Base64 relaxed and canonical profiles retain upstream whitespace, padding and alphabet rules', async t => {
  const directory = await workspace(t);
  const cases = [
    ['Zg', false, Buffer.from('f')], [' Zg==\n', false, Buffer.from('f')], ['Zh==', false, Buffer.from('f')],
    ['+_/_', false, Buffer.from([251, 255, 255])], ['+_/_', true, Buffer.from([251, 255, 255])],
    ['Zg==', true, Buffer.from('f')],
  ];
  for (const [index, [text, url_safe, expected]] of cases.entries()) {
    const input = path.join(directory, `relaxed-${index}.txt`), output = path.join(directory, `relaxed-${index}.bin`);
    await writeFile(input, text); await base64File({ input_path: input, output_path: output, mode: 'decode', url_safe });
    assert.deepEqual(await readFile(output), expected);
  }
  for (const [index, [text, url_safe, canonical]] of [
    ['Zg', false, true], [' Zg==\n', false, true], ['Zh==', false, true], ['Zg==', true, true],
    ['+_/_', false, true], ['+_/_', true, true], ['Zg=', false, false], ['A', false, false], ['Z===', false, false], ['private-secret?', false, false],
  ].entries()) {
    const input = path.join(directory, `invalid-${index}.txt`), output = path.join(directory, `invalid-${index}.bin`);
    await writeFile(input, text);
    await assert.rejects(base64File({ input_path: input, output_path: output, mode: 'decode', url_safe, canonical }), error => {
      assert.equal(error.code, 'INVALID_BASE64'); assert.ok(!String(error).includes('private-secret')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  const input = path.join(directory, 'invalid-utf8.txt'), output = path.join(directory, 'invalid-utf8.bin');
  await writeFile(input, Buffer.from([0xff]));
  await assert.rejects(base64File({ input_path: input, output_path: output, mode: 'decode' }), { code: 'INVALID_UTF8' });
  await assert.rejects(base64File({ input_path: input, output_path: output, mode: 'encode', canonical: true }), { code: 'INVALID_ARGUMENTS' });
  await writeFile(input, '\ufeffZg==');
  await assert.rejects(base64File({ input_path: input, output_path: output, mode: 'decode', canonical: true }), { code: 'INVALID_BASE64' });
});

test('readInput preserves old defaults while bounded text operations support empty binary files', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input'); await writeFile(input, '');
  await assert.rejects(readInput(input), { code: 'INPUT_SIZE' });
  assert.equal((await readInput(input, { allow_empty: true, max_bytes: 1 })).data.length, 0);
  await assert.rejects(readInput(input, { allow_empty: 'yes' }), { code: 'INVALID_ARGUMENTS' });
  for (const max_bytes of [0, -1, MAX_INPUT_BYTES + 1]) await assert.rejects(readInput(input, { max_bytes }), { code: 'INVALID_ARGUMENTS' });
  await writeFile(input, 'ab');
  assert.equal((await readInput(input)).data.length, 2);
  await assert.rejects(readInput(input, { max_bytes: 1 }), { code: 'INPUT_SIZE' });
  const large = path.join(directory, 'large'), file = await open(large, 'w');
  await file.truncate(MAX_TEXT_INPUT_BYTES + 1); await file.close();
  for (const operation of [formatJson, args => base64File({ ...args, mode: 'encode' })]) {
    await assert.rejects(operation({ input_path: large, output_path: path.join(directory, 'too-large.json') }), { code: 'INPUT_SIZE' });
  }
  const output = path.join(directory, 'exists'); await writeFile(output, 'preserve this');
  for (const operation of [formatJson, args => base64File({ ...args, mode: 'encode' })]) {
    await assert.rejects(operation({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  }
  assert.equal(await readFile(output, 'utf8'), 'preserve this');
});

test('text workers respect cancellation and never publish a cancelled result', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json');
  await writeFile(input, '"' + 'x'.repeat(2 * 1024 * 1024) + '"');
  const original = digest(await readFile(input));
  for (const [index, operation] of [formatJson, (args, options) => base64File({ ...args, mode: 'encode' }, options)].entries()) {
    const output = path.join(directory, `cancelled-${index}.json`);
    await assert.rejects(operation({ input_path: input, output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    const controller = new AbortController();
    const pending = operation({ input_path: input, output_path: output }, { signal: controller.signal });
    assert.equal(controller.signal.aborted, false);
    const timer = setTimeout(() => controller.abort(), 10);
    try { await assert.rejects(pending, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  assert.equal(digest(await readFile(input)), original);
});
