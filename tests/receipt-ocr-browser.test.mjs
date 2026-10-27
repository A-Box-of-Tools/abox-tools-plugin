import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { extractReceipt } from '../src/receipt-ocr.mjs';
import { withBrowser, findBrowser } from '../src/browser.mjs';

const browserOptions = { timeout: 180000, skip: !(await findBrowser()) };

test('bundled OCR reads a real printed receipt offline and keeps all text and values in local reports', browserOptions, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-receipt-browser-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'receipt.png');
  const base64 = await withBrowser(page => page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 750;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1000, 750);
    context.fillStyle = '#000'; context.font = '42px monospace';
    ['ABOX TEST STORE', 'RECEIPT 12345', 'Date: 2026-10-27', 'Item A       10.00', 'Tax           1.50', 'TOTAL USD    11.50'].forEach((line, index) => context.fillText(line, 70, 100 + index * 95));
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const bytes = Buffer.from(base64, 'base64'); await writeFile(input, bytes);
  const output = path.join(directory, 'receipt.json'), result = await extractReceipt({ input_path: input, output_path: output });
  assert.equal(result.verified, true); assert.equal(result.review_required, true); assert.equal(result.confirmed, false);
  assert.equal(result.verification.extraction_accuracy, false); assert.ok(result.recognized_characters > 50);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.match(report.text, /ABOX TEST STORE/); assert.match(report.text, /11\.50/);
  assert.equal(report.receipt.amount, '11.50'); assert.equal(report.receipt.currency, 'USD');
  for (const secret of ['ABOX TEST STORE', '12345', '11.50', '2026-10-27']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(await readFile(input), bytes);
  const csvOutput = path.join(directory, 'receipt.csv');
  const csv = await extractReceipt({ input_path: input, output_path: csvOutput, format: 'csv' });
  assert.equal(csv.verified, true);
  const contents = await readFile(csvOutput, 'utf8');
  assert.ok(contents.startsWith('\ufeff"filename","merchant"')); assert.ok(contents.includes('"11.50"')); assert.ok(contents.endsWith('"false"\r\n'));
});

test('browser worker and WebAssembly permissions are scoped to explicitly selected offline jobs', browserOptions, async () => {
  const inspect = page => page.evaluate(async () => {
    let wasm = false;
    try { await WebAssembly.compile(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])); wasm = true; } catch { /* CSP refuses it. */ }
    const worker = await new Promise(resolve => {
      const url = URL.createObjectURL(new Blob(['postMessage(42)'], { type: 'text/javascript' }));
      let instance;
      const finish = value => { clearTimeout(timer); instance?.terminate(); URL.revokeObjectURL(url); resolve(value); };
      const timer = setTimeout(() => finish(false), 1000);
      try { instance = new Worker(url); instance.onmessage = event => finish(event.data === 42); instance.onerror = event => { event.preventDefault(); finish(false); }; }
      catch { finish(false); }
    });
    let network = true;
    try { await fetch('https://example.com/not-a-file'); } catch { network = false; }
    return { wasm, worker, network };
  });
  assert.deepEqual(await withBrowser(inspect), { wasm: false, worker: false, network: false });
  assert.deepEqual(await withBrowser(inspect, { workers: true, wasm: true }), { wasm: true, worker: true, network: false });
});
