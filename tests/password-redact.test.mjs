import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { generatePasswords, redactImage, MAX_PASSWORD_CONFIG_BYTES, MAX_PASSWORD_COUNT,
  MAX_PASSWORD_OUTPUT_BYTES, MAX_REDACTION_CONFIG_BYTES } from '../src/password-redact.mjs';
import { wordlist } from '../vendor/abox/tools/password-generator/src/wordlist.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-password-redact-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const secrets = text => { assert.ok(text.endsWith('\n')); return text.slice(0, -1).split('\n'); };

test('password defaults write a private new file and return settings without generated values or hashes', async t => {
  const directory = await workspace(t), output = path.join(directory, 'secrets.txt');
  const result = await generatePasswords({ output_path: output }), text = await readFile(output, 'utf8');
  const [secret] = secrets(text);
  assert.equal(secret.length, 24); assert.match(secret, /[a-z]/); assert.match(secret, /[A-Z]/);
  assert.match(secret, /[0-9]/); assert.ok([...secret].some(char => '!#$%&()*+,-./:;<=>?@[]^_{|}~'.includes(char)));
  assert.doesNotMatch(secret, /[\s'"`\\]/);
  assert.equal(result.operation, 'generate-passwords'); assert.equal(result.mode, 'password');
  assert.equal(result.count, 1); assert.equal(result.length, 24); assert.equal(result.verified, true);
  assert.equal(result.random_source, 'crypto.getRandomValues'); assert.equal(result.final_newline, true);
  assert.equal(result.output_bytes, Buffer.byteLength(text)); assert.equal(result.config_path, null);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(hash(Buffer.from(secret))));
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(generatePasswords({ output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), text);
});

test('password local settings enforce exact classes, look-alike exclusions, lengths and bounded batches', async t => {
  const directory = await workspace(t), config = path.join(directory, 'options.json'), output = path.join(directory, 'batch.txt');
  const source = JSON.stringify({ count: MAX_PASSWORD_COUNT, length: 8, lowercase: true, uppercase: false,
    digits: true, symbols: false, symbol_set: 'safe', avoid_lookalikes: true, require_each: true });
  await writeFile(config, source);
  const result = await generatePasswords({ config_path: config, output_path: output }), text = await readFile(output, 'utf8');
  const generated = secrets(text); assert.equal(generated.length, MAX_PASSWORD_COUNT);
  for (const secret of generated) {
    assert.equal(secret.length, 8); assert.match(secret, /^[a-km-z2-9]+$/); assert.match(secret, /[a-z]/); assert.match(secret, /[2-9]/);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.ok(result.output_bytes < MAX_PASSWORD_OUTPUT_BYTES); assert.equal(result.count, MAX_PASSWORD_COUNT);
  assert.equal(await readFile(config, 'utf8'), source);
});

test('passphrases use bundled words and exact casing, separator and suffix settings without leaking words', async t => {
  const directory = await workspace(t), config = path.join(directory, 'options.json'), output = path.join(directory, 'phrases.txt');
  const source = JSON.stringify({ mode: 'passphrase', count: 4, words: 4, wordlist: 'short',
    separator: 'underscore', capitalization: 'upper', add_digit: true, add_symbol: true });
  await writeFile(config, source); const before = hash(await readFile(config));
  const result = await generatePasswords({ config_path: config, output_path: output });
  const generated = secrets(await readFile(output, 'utf8')), list = new Set(wordlist('short'));
  assert.equal(generated.length, 4);
  for (const phrase of generated) {
    assert.match(phrase, /[0-9][!@#$%^&*]$/);
    const words = phrase.slice(0, -2).split('_'); assert.equal(words.length, 4);
    for (const word of words) { assert.equal(word, word.toUpperCase()); assert.ok(list.has(word.toLowerCase())); }
    assert.ok(!JSON.stringify(result).includes(phrase));
  }
  assert.equal(result.word_count, 4); assert.equal(result.wordlist, 'short'); assert.equal(result.mode, 'passphrase');
  assert.equal(hash(await readFile(config)), before);
  for (const separator of ['hyphen', 'space', 'dot', 'none', 'digit']) {
    await writeFile(config, JSON.stringify({ mode: 'passphrase', separator }));
    const target = path.join(directory, `${separator}.txt`);
    const made = await generatePasswords({ config_path: config, output_path: target });
    assert.equal(made.word_count, 6); assert.equal(made.wordlist, 'long');
    assert.equal(secrets(await readFile(target, 'utf8')).length, 1); assert.equal(made.verified, true);
  }
});

test('password config rejects unsupported shapes, duplicate fields and private parser content', async t => {
  const directory = await workspace(t), config = path.join(directory, 'options.json');
  const cases = ['{"private-secret":1}', '{"length":7}', '{"length":129}', '{"count":101}',
    '{"length":24,"length":25}', '{"mode":"private-secret"}', '{"symbols":"private-secret"}',
    '{"lowercase":false,"uppercase":false,"digits":false,"symbols":false}',
    '{"mode":"passphrase","words":3}', '{"mode":"passphrase","words":13}',
    '{"mode":"passphrase","wordlist":"private-secret"}', '{"mode":"passphrase","length":20}',
    '{"private-secret":', '[]', 'null', '['.repeat(9) + '0' + ']'.repeat(9),
    ...['mode', 'count', 'length', 'lowercase', 'uppercase', 'digits', 'symbols', 'symbol_set', 'avoid_lookalikes', 'require_each']
      .map(key => JSON.stringify({ [key]: null })),
    ...['count', 'words', 'wordlist', 'separator', 'capitalization', 'add_digit', 'add_symbol']
      .map(key => JSON.stringify({ mode: 'passphrase', [key]: null }))];
  for (const [index, source] of cases.entries()) {
    await writeFile(config, source); const output = path.join(directory, `bad-${index}.txt`);
    await assert.rejects(generatePasswords({ config_path: config, output_path: output }), error => {
      assert.equal(error.code, 'INVALID_CONFIG'); assert.ok(!String(error).includes('private-secret'));
      assert.ok(!JSON.stringify(error).includes('private-secret')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(config, 'utf8'), source);
  }
  await writeFile(config, Buffer.from([0xff]));
  await assert.rejects(generatePasswords({ config_path: config, output_path: path.join(directory, 'utf8.txt') }), { code: 'INVALID_UTF8' });
  await writeFile(config, ' '.repeat(MAX_PASSWORD_CONFIG_BYTES + 1));
  await assert.rejects(generatePasswords({ config_path: config, output_path: path.join(directory, 'large.txt') }), { code: 'INPUT_SIZE' });
});

test('password generation honors local paths, extension and cancellation without leaving output', async t => {
  const directory = await workspace(t), output = path.join(directory, 'cancelled.txt');
  await assert.rejects(generatePasswords({ output_path: 'relative.txt' }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(generatePasswords({ output_path: path.join(directory, 'secret.json') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(generatePasswords({ config_path: 'https://example.invalid/private-secret', output_path: output }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(generatePasswords({ output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), pending = generatePasswords({ output_path: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('redaction requires declared image dimensions and exact fully in-bounds solid-fill regions', async t => {
  const directory = await workspace(t), config = path.join(directory, 'regions.json'), input = path.join(directory, 'missing.png');
  const cases = [[], {}, { regions: [] }, { image_width: 10, image_height: 10, regions: [] },
    { image_width: 10, image_height: 10, regions: [{ x: 0, y: 0, width: 1, height: 1, style: 'blur' }] },
    ...[{ x: -1, y: 0, width: 2, height: 2 }, { x: 9, y: 0, width: 2, height: 2 },
      { x: 0.5, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 2 }].map(region => ({ image_width: 10, image_height: 10, regions: [region] })),
    { image_width: 1, image_height: 1, regions: Array.from({ length: 101 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    { image_width: 16000, image_height: 10000, regions: [{ x: 0, y: 0, width: 1, height: 1 }] },
    { image_width: 8000, image_height: 4000, regions: Array.from({ length: 5 }, () => ({ x: 0, y: 0, width: 8000, height: 4000 })) }];
  for (const [index, value] of cases.entries()) {
    await writeFile(config, JSON.stringify(value)); const output = path.join(directory, `bad-${index}.png`);
    await assert.rejects(redactImage({ input_path: input, output_path: output, regions_path: config }), { code: 'INVALID_CONFIG' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  await writeFile(config, ' '.repeat(MAX_REDACTION_CONFIG_BYTES + 1));
  await assert.rejects(redactImage({ input_path: input, output_path: path.join(directory, 'large.png'), regions_path: config }), { code: 'INPUT_SIZE' });
});

function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const value of out.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png(width, height, animated = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(animated ? [chunk('acTL', animation)] : []),
    chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]);
}

test('redaction refuses animation and oversized declarations before browser decoding', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.png'), config = path.join(directory, 'regions.json');
  await writeFile(config, JSON.stringify({ image_width: 1, image_height: 1, regions: [{ x: 0, y: 0, width: 1, height: 1 }] }));
  for (const [index, bytes, code] of [[0, png(1, 1, true), 'ANIMATED_IMAGE'], [1, png(20000, 1), 'IMAGE_DIMENSIONS'],
    [2, png(8000, 8000), 'IMAGE_DIMENSIONS']]) {
    await writeFile(input, bytes); const before = hash(bytes), output = path.join(directory, `refused-${index}.png`);
    await assert.rejects(redactImage({ input_path: input, output_path: output, regions_path: config }), { code });
    assert.equal(hash(await readFile(input)), before); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  await assert.rejects(redactImage({ input_path: input, output_path: path.join(directory, 'output.jpg'), regions_path: config }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(redactImage({ input_path: input, output_path: path.join(directory, 'cancelled.png'), regions_path: config },
    { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
