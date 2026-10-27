import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { extractReceipt } from '../src/receipt-ocr.mjs';

test('receipt OCR validates paths, formats and cancellation without opening private files', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-receipt-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'source.txt'), output = path.join(directory, 'out.json');
  await writeFile(input, 'private receipt note');
  await assert.rejects(extractReceipt({ input_path: input, output_path: output, format: 'txt' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(extractReceipt({ input_path: input, output_path: path.join(directory, 'out.csv') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(extractReceipt({ input_path: input, output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(extractReceipt({ input_path: 'https://example.com/private.png', output_path: output }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(output, 'existing');
  await assert.rejects(extractReceipt({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'existing');
});
