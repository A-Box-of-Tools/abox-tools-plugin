import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateQr, generateBarcode, MAX_QR_INPUT_BYTES, MAX_BARCODE_INPUT_BYTES } from '../src/codes.mjs';
import { decodeMatrix } from '../vendor/abox/tools/qr-barcode-reader/src/qr-decode.js';
import { readLinear } from '../vendor/abox/tools/qr-barcode-reader/src/linear.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => { assert.equal(error.code, code); return true; };

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-codes-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function qrModules(svg, result) {
  const modules = new Uint8Array(result.modules_per_side ** 2);
  for (const run of svg.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)) {
    const x = Number(run[1]) / result.scale - result.quiet;
    const y = Number(run[2]) / result.scale - result.quiet;
    const width = Number(run[3]) / result.scale;
    for (let at = 0; at < width; at++) modules[y * result.modules_per_side + x + at] = 1;
  }
  return modules;
}

function barcodeModules(svg, result) {
  const modules = new Uint8Array(result.width / result.scale);
  for (const bar of svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="\d+" fill="[^"]+"\/>/g)) {
    modules.fill(1, Number(bar[1]) / result.scale, (Number(bar[1]) + Number(bar[2])) / result.scale);
  }
  return modules;
}

function barcodeRead(modules) {
  const bits = new Uint8Array(modules.length * 4);
  for (let row = 0; row < 4; row++) bits.set(modules, row * modules.length);
  return readLinear(bits, modules.length, 4, 4);
}

test('QR SVG stores exact local payload text, decodes independently, and preserves standard finder geometry', async t => {
  const directory = await workspace(t);
  for (const [at, value] of ['HELLO WORLD', 'https://example.invalid/path?q=private\n', 'WIFI:T:WPA;S:Local test;P:synthetic-secret;;', '日本語 café 😀', '\ufeffexact BOM\r\n'].entries()) {
    const input = path.join(directory, `payload-${at}.txt`), output = path.join(directory, `qr-${at}.svg`);
    const bytes = Buffer.from(value); await writeFile(input, bytes);
    const result = await generateQr({ input_path: input, output_path: output });
    const svg = await readFile(output, 'utf8');
    const modules = qrModules(svg, result), decoded = decodeMatrix(result.modules_per_side, modules);
    assert.equal(decoded.text, value.startsWith('\ufeff') ? value.slice(1) : value);
    assert.equal(decoded.level, 'M'); assert.equal(decoded.corrections, 0);
    assert.equal(result.width, (result.modules_per_side + 8) * 4);
    assert.equal(result.height, result.width); assert.equal(result.format, 'svg');
    assert.equal(result.verified, true); assert.equal(result.verification.payload_decoded, true);
    assert.equal(result.verification.png_pixel_samples, 0);
    assert.equal(result.input_bytes, bytes.length); assert.equal(result.output_bytes, Buffer.byteLength(svg));
    assert.ok(!svg.includes(value)); assert.ok(!JSON.stringify(result).includes(value));
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    const finder = Array.from({ length: 7 }, (_, y) => Array.from(modules.subarray(y * result.modules_per_side, y * result.modules_per_side + 7)).join(''));
    assert.deepEqual(finder, ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']);
    assert.equal(hash(await readFile(input)), hash(bytes));
    if (at === 0) {
      assert.equal(result.version, 1); assert.equal(result.modules_per_side, 21);
      await assert.rejects(generateQr({ input_path: input, output_path: output }), hasCode('OUTPUT_EXISTS'));
      assert.equal(await readFile(output, 'utf8'), svg);
    }
  }
});

test('QR levels, integer scale, quiet margins and source contrast advisories remain explicit', async t => {
  const directory = await workspace(t), input = path.join(directory, 'payload.txt');
  await writeFile(input, 'qr options');
  for (const level of ['L', 'M', 'Q', 'H']) {
    const result = await generateQr({ input_path: input, output_path: path.join(directory, `${level}.svg`), level,
      scale: 1, quiet: 8, foreground: '#777777', background: '#888888' });
    assert.equal(result.level, level); assert.equal(result.scale, 1); assert.equal(result.quiet, 8);
    assert.ok(result.warnings.some(value => value.includes('low contrast')));
    assert.equal(decodeMatrix(result.modules_per_side, qrModules(await readFile(result.output_path, 'utf8'), result)).text, 'qr options');
  }
});

test('barcodes from all supported families decode from their actual SVG bars without returning label contents', async t => {
  const directory = await workspace(t);
  const cases = [
    ['code128', 'AB', 'AB'], ['ean13', '400638133393', '4006381333931'],
    ['upca', '03600029145', '036000291452'], ['ean8', '9638507', '96385074'],
    ['itf14', '1001234500001', '10012345000017'], ['itf', '12345678', '12345678'],
    ['code39', 'abc', 'ABC'],
  ];
  for (const [symbology, value, expected] of cases) {
    const input = path.join(directory, `${symbology}.txt`), output = path.join(directory, `${symbology}.svg`);
    await writeFile(input, value);
    const result = await generateBarcode({ input_path: input, output_path: output, symbology });
    const svg = await readFile(output, 'utf8'), modules = barcodeModules(svg, result);
    assert.equal(barcodeRead(modules).text, expected);
    assert.equal(result.symbology, symbology); assert.equal(result.verified, true);
    assert.equal(result.width, modules.length * 4); assert.equal(result.bar_height, 100);
    assert.ok(modules.subarray(0, result.quiet.left).every(value => value === 0));
    assert.ok(modules.subarray(modules.length - result.quiet.right).every(value => value === 0));
    assert.equal(result.check_digit_added, ['ean13', 'upca', 'ean8', 'itf14'].includes(symbology));
    assert.equal(result.text_normalized, symbology === 'code39');
    assert.ok(!JSON.stringify(result).includes(expected));
    assert.equal(hash(await readFile(input)), hash(Buffer.from(value)));
    if (symbology === 'code128') {
      const core = modules.subarray(result.quiet.left, modules.length - result.quiet.right);
      const widths = [];
      for (const value of core) {
        if (!widths.length || value !== core[widths.reduce((sum, width) => sum + width, 0) - 1]) widths.push(1);
        else widths[widths.length - 1]++;
      }
      // Start B, A, B, weighted checksum 102, stop: an independent fixed vector.
      assert.equal(widths.join(''), '2112141113231311234111312331112');
    }
  }
});

test('barcode labels escape XML, Code 39 checks are scanned, and UPC/EAN aliases retain their exact standard value', async t => {
  const directory = await workspace(t), input = path.join(directory, 'payload.txt');
  const value = '<&" onload=x href=y>';
  await writeFile(input, value);
  const escaped = await generateBarcode({ input_path: input, output_path: path.join(directory, 'escaped.svg'), scale: 2 });
  const svg = await readFile(escaped.output_path, 'utf8');
  assert.ok(svg.includes('&lt;&amp;&quot;')); assert.ok(!svg.includes('<&"'));
  assert.equal(barcodeRead(barcodeModules(svg, escaped)).text, value);
  assert.ok(!JSON.stringify(escaped).includes(value));
  await writeFile(input, 'abc');
  const checked = await generateBarcode({ input_path: input, output_path: path.join(directory, 'checked.svg'), symbology: 'code39', code39_check: true });
  assert.equal(barcodeRead(barcodeModules(await readFile(checked.output_path, 'utf8'), checked)).text, 'ABCX');
  await writeFile(input, '0036000291452');
  const alias = await generateBarcode({ input_path: input, output_path: path.join(directory, 'alias.svg'), symbology: 'ean13' });
  const read = barcodeRead(barcodeModules(await readFile(alias.output_path, 'utf8'), alias));
  assert.equal(read.format, 'upca'); assert.equal(read.text, '036000291452'); assert.equal(alias.check_digit_added, false);
  await writeFile(input, 'A\0B');
  await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'invalid-label.svg') }), hasCode('BARCODE_LABEL'));
  const noLabel = await generateBarcode({ input_path: input, output_path: path.join(directory, 'no-label.svg'), text: false });
  const noLabelSvg = await readFile(noLabel.output_path, 'utf8');
  assert.ok(!noLabelSvg.includes('<text')); assert.equal(barcodeRead(barcodeModules(noLabelSvg, noLabel)).text, 'A\0B');
});

test('code generation bounds payloads and geometry, preserves existing files, and sanitizes refusals', async t => {
  const directory = await workspace(t), input = path.join(directory, 'payload.txt');
  await writeFile(input, 'synthetic-private-😀');
  for (const args of [{ symbology: 'code128' }, { symbology: 'ean13' }]) {
    await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'invalid.svg'), ...args }), error => {
      assert.equal(error.code, 'BARCODE_PAYLOAD'); assert.ok(!error.message.includes('synthetic')); assert.ok(!error.message.includes('😀')); return true;
    });
  }
  await writeFile(input, '4006381333930');
  await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'bad-check.svg'), symbology: 'ean13' }), hasCode('BARCODE_PAYLOAD'));
  await writeFile(input, Buffer.from([0xff]));
  for (const operation of [generateQr, generateBarcode]) await assert.rejects(operation({ input_path: input, output_path: path.join(directory, 'encoding.svg') }), hasCode('INPUT_ENCODING'));
  for (const [operation, limit] of [[generateQr, MAX_QR_INPUT_BYTES], [generateBarcode, MAX_BARCODE_INPUT_BYTES]]) {
    await writeFile(input, 'x'.repeat(limit + 1));
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, 'large.svg') }), hasCode('INPUT_SIZE'));
  }
  await writeFile(input, 'x'.repeat(MAX_QR_INPUT_BYTES));
  await assert.rejects(generateQr({ input_path: input, output_path: path.join(directory, 'capacity.svg'), level: 'H' }), hasCode('QR_CAPACITY'));
  await writeFile(input, '0'.repeat(MAX_QR_INPUT_BYTES));
  await assert.rejects(generateQr({ input_path: input, output_path: path.join(directory, 'pixels.svg'), level: 'L', scale: 32, quiet: 32 }), hasCode('CODE_DIMENSIONS'));
  await writeFile(input, 'A'.repeat(64));
  await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'reader-limit.svg'), scale: 1 }), hasCode('CODE_VERIFICATION_LIMIT'));
  await writeFile(input, '12');
  await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'itf-short.svg'), symbology: 'itf' }), hasCode('CODE_VERIFICATION_LIMIT'));
  await writeFile(input, 'A'.repeat(30));
  await assert.rejects(generateBarcode({ input_path: input, output_path: path.join(directory, 'side.svg'), symbology: 'code39', scale: 32 }), hasCode('CODE_DIMENSIONS'));
  const before = hash(await readFile(input));
  for (const operation of [generateQr, generateBarcode]) {
    await assert.rejects(operation({ input_path: input, output_path: input }), hasCode('OUTPUT_EXISTS'));
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, 'wrong.png') }), hasCode('OUTPUT_EXTENSION'));
    await assert.rejects(operation({ input_path: 'https://example.invalid/payload', output_path: path.join(directory, 'remote.svg') }), hasCode('LOCAL_PATH_REQUIRED'));
    await assert.rejects(operation({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  }
  assert.equal(hash(await readFile(input)), before);
  await assert.rejects(stat(path.join(directory, 'reader-limit.svg')), { code: 'ENOENT' });
});

test('code settings reject injection, noninteger modules, reduced margins and unsupported options before reading payloads', async () => {
  for (const settings of [{ scale: 0 }, { scale: 33 }, { scale: 1.5 }, { format: 'jpeg' },
    { foreground: '#000000" onload="x' }, { background: 'none' }, { foreground: '#ffffff' }]) {
    for (const operation of [generateQr, generateBarcode]) {
      await assert.rejects(operation(settings), error => ['INVALID_ARGUMENTS', 'CODE_COLORS'].includes(error.code));
    }
  }
  for (const settings of [{ level: 'Z' }, { quiet: 3 }, { quiet: 33 }, { quiet: 4.5 }]) await assert.rejects(generateQr(settings), hasCode('INVALID_ARGUMENTS'));
  for (const settings of [{ symbology: 'upce' }, { height: 0 }, { height: 4097 }, { text: 'yes' }, { code39_check: true }]) {
    await assert.rejects(generateBarcode(settings), hasCode('INVALID_ARGUMENTS'));
  }
});
