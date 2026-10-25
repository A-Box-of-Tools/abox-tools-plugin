import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execute } from '../src/tools.mjs';
import { MAX_HASH_BYTES } from '../src/hash.mjs';

async function workspace(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-hash-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('all website checksum engines match independent digests, including empty and multi-chunk files', async t => {
  const dir = await workspace(t);
  const algorithms = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
  for (const size of [0, 55, 64, 128, 4 * 1024 * 1024 + 137]) {
    const bytes = Buffer.alloc(size);
    for (let at = 0; at < size; at++) bytes[at] = at * 37 % 251;
    const input = path.join(dir, `file-${size}`);
    await writeFile(input, bytes);
    const result = await execute('abox_file_hash', { input_path: input, algorithms });
    assert.equal(result.input_bytes, size);
    assert.deepEqual(result.hashes, Object.fromEntries(algorithms.map(id => [id, createHash(id).update(bytes).digest('hex')])));
    assert.deepEqual(await readFile(input), bytes);
  }
});

test('hash defaults, local paths, cancellation, and streaming bound are enforced', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'input');
  await writeFile(input, 'abc');
  assert.deepEqual((await execute('abox_file_hash', { input_path: input })).hashes, {
    sha256: createHash('sha256').update('abc').digest('hex'),
  });
  for (const algorithms of [[], ['sha256', 'sha256'], ['sha3']]) {
    await assert.rejects(execute('abox_file_hash', { input_path: input, algorithms }), { name: 'ZodError' });
  }
  await assert.rejects(execute('abox_file_hash', { input_path: 'https://example.com/file' }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(execute('abox_file_hash', { input_path: dir }), { code: 'INPUT_NOT_FILE' });
  await assert.rejects(execute('abox_file_hash', { input_path: input }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const large = path.join(dir, 'large');
  const file = await open(large, 'w');
  await file.truncate(MAX_HASH_BYTES + 1);
  await file.close();
  await assert.rejects(execute('abox_file_hash', { input_path: large }), { code: 'INPUT_SIZE' });
});

test('a streaming checksum can be cancelled after the request starts', async t => {
  const dir = await workspace(t);
  const input = path.join(dir, 'cancel-during-stream');
  const file = await open(input, 'w');
  await file.truncate(64 * 1024 * 1024);
  await file.close();
  const controller = new AbortController();
  const pending = execute('abox_file_hash', {
    input_path: input, algorithms: ['md5', 'sha1', 'sha256', 'sha384', 'sha512'],
  }, { signal: controller.signal });
  assert.equal(controller.signal.aborted, false);
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
});
