import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { protectPdf, unlockPdf, MAX_PDF_SECURITY_INPUT_BYTES, MAX_PDF_SECURITY_PAGES,
  MAX_PDF_SECURITY_STREAM_BYTES, MAX_PDF_PASSWORD_FILE_BYTES } from '../src/pdf-security-redact.mjs';
import { PdfWriter } from '../vendor/abox/shared/js/pdf-page-writer.js';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { standardSecurity, WrongPasswordError } from '../vendor/abox/shared/js/pdf-crypt.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { PdfStream } from '../vendor/abox/shared/js/pdf-objects.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-pdf-security-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

async function fixture(directory, { pages = 2, info = true, extraStream = null, extraDict = '', trailer = '', tinyNumber = false } = {}) {
  const writer = new PdfWriter(), catalog = writer.reserve(), tree = writer.reserve(), font = writer.reserve(), image = writer.reserve(), metadata = writer.reserve();
  writer.object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  writer.stream(image, '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB', new Uint8Array([7, 8, 9]));
  writer.stream(metadata, '/Type /Metadata /Subtype /XML', encoder.encode('<private>Private XMP metadata</private>'));
  const children = [];
  for (let index = 0; index < pages; index++) {
    const page = writer.reserve(), contents = writer.reserve();
    writer.stream(contents, '', encoder.encode(`BT /F1 12 Tf 20 40 Td (Private page content ${index + 1}) Tj ET\nq 10 0 0 10 50 50 cm /Im0 Do Q\n`));
    writer.object(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 200 300] /Rotate ${index ? 90 : 0}
      /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`);
    children.push(`${page} 0 R`);
  }
  if (extraStream) { const stream = writer.reserve(); writer.stream(stream, extraStream.dict, extraStream.bytes); }
  writer.object(tree, `<< /Type /Pages /Count ${pages} /Kids [${children.join(' ')}] >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${tree} 0 R /Metadata ${metadata} 0 R ${extraDict} ${tinyNumber ? '/PrivateCoordinate 0.00000001' : ''} >>`);
  let details = trailer;
  if (info) { const entry = writer.reserve(); writer.object(entry, '<< /Title (Private metadata title) /Author (Private document author) >>'); details += ` /Info ${entry} 0 R`; }
  const input = path.join(directory, `source-${pages}-${info}-${tinyNumber}.pdf`), blob = writer.finish({ root: catalog, extra: details });
  await writeFile(input, new Uint8Array(await blob.arrayBuffer())); return input;
}

async function opened(filename, value = null) {
  const bytes = new Uint8Array(await readFile(filename));
  if (value === null) return { doc: await PdfDocument.open(bytes) };
  const auth = standardSecurity(value), doc = await PdfDocument.open(bytes, { unlock: auth.unlock }); return { doc, report: auth.report };
}

async function pageContents(doc) {
  const root = doc.get(doc.catalog, 'Pages'), kids = doc.get(root, 'Kids'), values = [];
  for (const kid of kids) {
    const page = doc.resolve(kid), stream = doc.get(page, 'Contents'); assert.ok(stream instanceof PdfStream);
    values.push(Buffer.from((await decodeStream(stream, value => doc.resolve(value))).bytes).toString('latin1'));
  }
  return values;
}

test('PDF protection writes both supported revisions and verifies passwords, permission bits and complete content', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = await fixture(directory), original = await readFile(input);
  const before = await opened(input), expectedContents = await pageContents(before.doc);
  for (const revision of [4, 6]) {
    const user = revision === 4 ? ' Latin-1 café secret\n' : ' UTF-8 日本語 😀 secret\n', owner = `Private owner ${revision}`;
    const userFile = path.join(directory, `open-${revision}.txt`), ownerFile = path.join(directory, `owner-${revision}.txt`);
    await writeFile(userFile, user); await writeFile(ownerFile, owner);
    const output = path.join(directory, `protected-${revision}.pdf`);
    const result = await protectPdf({ input_path: input, output_path: output, open_password_file: userFile,
      owner_password_file: ownerFile, revision, restrict_print: true, restrict_copy: true, restrict_change: true });
    assert.equal(result.pages, 2); assert.equal(result.revision, revision); assert.equal(result.bits, revision === 6 ? 256 : 128);
    assert.equal(result.open_password, true); assert.equal(result.owner_password_source, 'provided-file'); assert.equal(result.verified, true);
    assert.equal(result.verification.reachable_graph, true); assert.equal(result.verification.stream_bytes, true);
    assert.equal(result.verification.blank_password_refused, true); assert.equal(result.verification.owner_password_checked, true);
    for (const secret of [user, owner, 'Private page content', 'Private metadata title', userFile, ownerFile]) assert.ok(!JSON.stringify(result).includes(secret));
    await assert.rejects(opened(output), EncryptedPdfError); await assert.rejects(opened(output, ''), WrongPasswordError);
    await assert.rejects(opened(output, 'incorrect synthetic password'), WrongPasswordError);
    for (const value of [user, owner]) {
      const after = await opened(output, value);
      assert.equal(after.doc.countPages(), 2); assert.deepEqual(await pageContents(after.doc), expectedContents);
      assert.equal(Buffer.from(after.doc.get(after.doc.info, 'Title').bytes).toString('latin1'), 'Private metadata title');
      const denied = after.report.restrictions.filter(entry => !entry.allowed).map(entry => entry.bit).sort((a, b) => a - b);
      assert.deepEqual(denied, [3, 4, 5, 6, 9, 11, 12]);
      const pages = after.doc.get(after.doc.get(after.doc.catalog, 'Pages'), 'Kids');
      const page = after.doc.resolve(pages[0]), image = after.doc.get(after.doc.get(after.doc.get(page, 'Resources'), 'XObject'), 'Im0');
      assert.deepEqual(Array.from(image.raw), [7, 8, 9]);
    }
    assert.equal(await readFile(userFile, 'utf8'), user); assert.equal(await readFile(ownerFile, 'utf8'), owner);
    assert.equal(hash(await readFile(input)), hash(original));
  }
});

test('unlock removes encryption and optionally metadata while preserving exact local document data', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = await fixture(directory), passwordFile = path.join(directory, 'password.txt');
  const secret = '\ufeff exact password with spaces \n'; await writeFile(passwordFile, secret);
  const encrypted = path.join(directory, 'encrypted.pdf');
  await protectPdf({ input_path: input, output_path: encrypted, open_password_file: passwordFile });
  const encryptedBytes = await readFile(encrypted), expected = await pageContents((await opened(input)).doc);
  for (const remove_metadata of [false, true]) {
    const output = path.join(directory, `unlocked-${remove_metadata}.pdf`);
    const result = await unlockPdf({ input_path: encrypted, output_path: output, password_file: passwordFile, remove_metadata });
    assert.equal(result.pages, 2); assert.equal(result.input_revision, 6); assert.equal(result.input_bits, 256);
    assert.equal(result.verification.opens_without_password, true); assert.equal(result.verification.encryption_removed, true);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(passwordFile));
    const after = await opened(output); assert.equal(after.doc.trailer.has('Encrypt'), false);
    assert.deepEqual(await pageContents(after.doc), expected);
    assert.equal(Boolean(after.doc.info), !remove_metadata); assert.equal(Boolean(after.doc.get(after.doc.catalog, 'Metadata')), !remove_metadata);
    if (remove_metadata) assert.ok(result.metadata_entries_removed >= 2); else assert.equal(result.metadata_entries_removed, 0);
    assert.equal(hash(await readFile(encrypted)), hash(encryptedBytes));
  }
  const trimmed = path.join(directory, 'trimmed.txt'); await writeFile(trimmed, secret.trim());
  await assert.rejects(unlockPdf({ input_path: encrypted, output_path: path.join(directory, 'wrong.pdf'), password_file: trimmed }), error => {
    assert.equal(error.code, 'PDF_PASSWORD_INVALID'); assert.ok(!String(error).includes(secret)); return true;
  });
});

test('restrictions-only protection requires a retained owner secret and supports re-protection without losing it', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = await fixture(directory), ownerFile = path.join(directory, 'owner.txt'); await writeFile(ownerFile, 'retained private owner');
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'missing-owner.pdf'), restrict_copy: true }), { code: 'OWNER_PASSWORD_REQUIRED' });
  const output = path.join(directory, 'restricted.pdf');
  const protectedResult = await protectPdf({ input_path: input, output_path: output, owner_password_file: ownerFile, restrict_copy: true, revision: 4 });
  assert.equal(protectedResult.open_password, false); assert.equal(protectedResult.owner_password_source, 'provided-file');
  assert.equal(protectedResult.verification.blank_password_refused, false);
  const auth = await opened(output, ''); assert.equal(auth.report.opened, 'blank');
  const unlocked = path.join(directory, 'plain.pdf'); await unlockPdf({ input_path: output, output_path: unlocked });
  assert.deepEqual(await pageContents((await opened(unlocked)).doc), await pageContents((await opened(input)).doc));
  const stronger = path.join(directory, 'reprotected.pdf');
  const reprotected = await protectPdf({ input_path: output, output_path: stronger, owner_password_file: ownerFile, restrict_print: true });
  assert.equal(reprotected.input_encrypted, true); assert.equal(reprotected.revision, 6);
  await assert.rejects(unlockPdf({ input_path: input, output_path: path.join(directory, 'already-plain.pdf') }), { code: 'PDF_NOT_ENCRYPTED' });
});

test('password file validation never truncates or echoes sensitive contents and preserves all existing files', async t => {
  const directory = await workspace(t), input = await fixture(directory), secretFile = path.join(directory, 'private-password-file.txt');
  const cases = [[4, 'Private 日本語 secret'], [4, 'x'.repeat(33)], [6, 'x'.repeat(128)]];
  for (const [index, [revision, value]] of cases.entries()) {
    await writeFile(secretFile, value); const output = path.join(directory, `bad-${index}.pdf`);
    await assert.rejects(protectPdf({ input_path: input, output_path: output, open_password_file: secretFile, revision }), error => {
      assert.equal(error.code, 'PASSWORD_LIMIT'); assert.ok(!String(error).includes(value)); assert.ok(!JSON.stringify(error).includes(value)); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(await readFile(secretFile, 'utf8'), value);
  }
  await writeFile(secretFile, Buffer.from([0xff]));
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'utf8.pdf'), open_password_file: secretFile }), { code: 'PASSWORD_ENCODING' });
  await writeFile(secretFile, 'x'.repeat(MAX_PDF_PASSWORD_FILE_BYTES + 1));
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'large-secret.pdf'), open_password_file: secretFile }), { code: 'PASSWORD_FILE' });
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'missing-secret.pdf'), open_password_file: path.join(directory, 'missing private secret') }), error => {
    assert.equal(error.code, 'PASSWORD_FILE'); assert.ok(!String(error).includes('missing private secret')); return true;
  });
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'nothing.pdf') }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'revision.pdf'), revision: 5 }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(unlockPdf({ input_path: input, output_path: path.join(directory, 'settings.pdf'), remove_metadata: 'yes' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(protectPdf({ input_path: input, output_path: path.join(directory, 'extension.txt') }), { code: 'OUTPUT_EXTENSION' });
  const original = await readFile(input);
  await assert.rejects(protectPdf({ input_path: input, output_path: input }), { code: 'OUTPUT_EXISTS' });
  await assert.rejects(unlockPdf({ input_path: input, output_path: input }), { code: 'OUTPUT_EXISTS' });
  assert.equal(hash(await readFile(input)), hash(original));
});

test('PDF security rejects unsupported handlers, repaired sources, lossy graph rewrites and bounded stream expansion', { timeout: 120000 }, async t => {
  const directory = await workspace(t), passwordFile = path.join(directory, 'password.txt'); await writeFile(passwordFile, 'private synthetic password');
  const unsupported = await fixture(directory, { trailer: ' /Encrypt << /Filter /Adobe.PubSec /V 4 /R 4 >>' });
  await assert.rejects(unlockPdf({ input_path: unsupported, output_path: path.join(directory, 'unsupported.pdf') }), { code: 'PDF_ENCRYPTION_UNSUPPORTED' });
  const precise = await fixture(directory, { tinyNumber: true });
  await assert.rejects(protectPdf({ input_path: precise, output_path: path.join(directory, 'precision.pdf'), open_password_file: passwordFile }), { code: 'VERIFICATION_FAILED' });
  const legacy = await fixture(directory, { extraStream: { dict: '/Filter /L#5aWDecode', bytes: new Uint8Array([0]) } });
  await assert.rejects(protectPdf({ input_path: legacy, output_path: path.join(directory, 'legacy.pdf'), open_password_file: passwordFile }), { code: 'PDF_SECURITY_FILTER' });
  const expanded = Buffer.alloc(MAX_PDF_SECURITY_STREAM_BYTES + 1, 32);
  const bomb = await fixture(directory, { extraStream: { dict: '/Type /XRef /Size 1 /W [1 4 2] /Filter /FlateDecode', bytes: deflateSync(expanded) } });
  const raw = await readFile(bomb, 'latin1'), marker = raw.indexOf('/Type /XRef'), objectHeader = raw.lastIndexOf(' 0 obj', marker);
  const xrefOffset = raw.lastIndexOf('\n', objectHeader) + 1;
  assert.ok(marker > 0 && objectHeader > 0 && xrefOffset > 0);
  await writeFile(bomb, Buffer.from(raw.replace(/startxref\s+\d+/, `startxref\n${xrefOffset}`), 'latin1'));
  await assert.rejects(protectPdf({ input_path: bomb, output_path: path.join(directory, 'expanded.pdf'), open_password_file: passwordFile }), { code: 'PDF_SECURITY_LIMIT' });
  const pages = await fixture(directory, { pages: MAX_PDF_SECURITY_PAGES + 1 });
  await assert.rejects(protectPdf({ input_path: pages, output_path: path.join(directory, 'pages.pdf'), open_password_file: passwordFile }), { code: 'PDF_PAGE_LIMIT' });
  const plain = await fixture(directory, { info: false }); const repaired = path.join(directory, 'broken-xref.pdf');
  await writeFile(repaired, Buffer.from((await readFile(plain, 'latin1')).replace(/startxref\s+\d+/, 'startxref\n0'), 'latin1'));
  await assert.rejects(protectPdf({ input_path: repaired, output_path: path.join(directory, 'repaired.pdf'), open_password_file: passwordFile }), { code: 'PDF_REPAIR_REQUIRED' });
});

test('PDF security respects input caps and cancellation without writing or changing documents and password files', { timeout: 120000 }, async t => {
  const directory = await workspace(t), passwordFile = path.join(directory, 'password.txt'); await writeFile(passwordFile, 'unchanged private password');
  const input = await fixture(directory), original = hash(await readFile(input));
  for (const operation of [protectPdf, unlockPdf]) await assert.rejects(operation({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), output = path.join(directory, 'cancelled.pdf');
  const pending = protectPdf({ input_path: input, output_path: output, open_password_file: passwordFile }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(output), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), original);
  assert.equal(await readFile(passwordFile, 'utf8'), 'unchanged private password');
  const large = path.join(directory, 'large.pdf'), file = await open(large, 'w'); await file.truncate(MAX_PDF_SECURITY_INPUT_BYTES + 1); await file.close();
  for (const operation of [protectPdf, unlockPdf]) await assert.rejects(operation({ input_path: large, output_path: output }), { code: 'INPUT_SIZE' });
});

test('unlock agrees with independent pypdf fixtures for standard security revisions R2 through R6', { timeout: 120000 }, async t => {
  const directory = await workspace(t), passwordFile = path.join(directory, 'password.txt'); await writeFile(passwordFile, 'letmein');
  for (const [name, revision] of [['rc4_40_user', 2], ['rc4_128_user', 3], ['aes_128_user', 4], ['aes_256_r5_user', 5], ['aes_256_user', 6], ['rc4_40_blank', 2]]) {
    const input = path.join(directory, `${name}.pdf`), output = path.join(directory, `${name}-unlocked.pdf`), source = Buffer.from(INDEPENDENT_PDFS[name], 'base64');
    await writeFile(input, source);
    const result = await unlockPdf({ input_path: input, output_path: output, ...(name.endsWith('_blank') ? {} : { password_file: passwordFile }), remove_metadata: false });
    assert.equal(result.input_revision, revision); assert.equal(result.pages, 2); assert.equal(result.verified, true);
    const after = (await opened(output)).doc, contents = await pageContents(after);
    assert.ok(contents[0].includes('SORT CODE 40-11-60 ACCOUNT 71829304 BALANCE 1,284.55'));
    assert.ok(contents[1].includes('PAGE TWO 992134 / REF QX-8871'));
    assert.equal(Buffer.from(after.get(after.info, 'Title').bytes).toString('latin1'), 'Quarterly statement 2026');
    assert.equal(hash(await readFile(input)), hash(source)); assert.ok(!JSON.stringify(result).includes('letmein'));
  }
  const input = path.join(directory, 'aes_256_user.pdf'), ownerFile = path.join(directory, 'owner.txt'); await writeFile(ownerFile, 'ownersecret');
  await unlockPdf({ input_path: input, output_path: path.join(directory, 'owner-unlocked.pdf'), password_file: ownerFile });
});

// These immutable synthetic fixtures are copied from the website's
// tests/js/unlock-pdf-fixtures.js, produced by pypdf 6.18.0 rather than this
// security engine. They exercise every supported standard security revision.
const INDEPENDENT_PDFS = {
  "rc4_40_user": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDgzCj4+CnN0cmVhbQqMO+AYq0EMwBt0Z9X+q3/6BcicXCHTcfDhF+vR4oVZu6zhUB5n+agTsckI7YusZw1ROdllpwDFngQhnjjLoxeK2Lh5ojm5tEm1XM7xbpNo9poXDAplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDYwCj4+CnN0cmVhbQpjT6jAwe/DTcKRy2ZbPS8BSGVJLpRJ+QZfrEcO7aIaUaT77rUyLLl0weJy5yfuJut0EH0b/At+A4N0OWEKZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8Ci9UaXRsZSA8MzBiNWFiNWI3ZjZhOTE0MmE0MzI1MWEwMzg0MDU2MDM5MjMyMzVkNDM0NGJjNTI2PgovQXV0aG9yIDwyMGUwODg0ODY1NjQ+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDEKL1IgMgovTGVuZ3RoIDQwCi9QIDQyOTQ5NjcyOTUKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDZjZGNlZWQ5ZTBkOWM2NTBjZDEyZmViYTg3NjU3NmZkMjFhNjEwZTUwODVlZGFjZTQ4MmU3NTEyOGFmZTFkZTQ+Ci9VIDw4ZjAyYWY5ZjE1OTExMTI4MzE1OTUwM2Y0MmE0M2M3ZGI4ZGZlYWVmNTg4Y2Q0Mzc1Mjc0MjIxOTA4NTQxOGZiPgo+PgplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjkgMDAwMDAgbiAKMDAwMDAwMDI2OSAwMDAwMCBuIAowMDAwMDAwMzM5IDAwMDAwIG4gCjAwMDAwMDA0NzIgMDAwMDAgbiAKMDAwMDAwMDYxMiAwMDAwMCBuIAowMDAwMDAwNzIyIDAwMDAwIG4gCjAwMDAwMDA4MjQgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxMAovUm9vdCAxIDAgUgovSW5mbyA4IDAgUgovSUQgWyA8MzEzMjY0Mzg2MTM0MzA2MTMyMzQ2NjM5MzQzNzMxMzM2NTM4NjM2MjM1NjE2NDMzNjQ2NTYxMzk2NjYzNjYzNT4gPDMxMzI2NDM4NjEzNDMwNjEzMjM0NjYzOTM0MzczMTMzNjUzODYzNjIzNTYxNjQzMzY0NjU2MTM5NjY2MzY2MzU+IF0KL0VuY3J5cHQgOSAwIFIKPj4Kc3RhcnR4cmVmCjEwMzgKJSVFT0YK",
  "rc4_128_user": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDgzCj4+CnN0cmVhbQoRP6/kJ9WVrRbcQCEroIUP5+xjZZj24SRelL6XDWICXgc9QkrnuTecPOMEaxGnn5XVe6eOHvQn4DqyG8VH2Wftmf1cry3Zek3ExZGRYNy8i30HtwplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDYwCj4+CnN0cmVhbQp3VBCxT0nj0XsFvPzyspnHWhfMaxPWx+ZB9PLC6oDXvcc/9tr1NpOLGYlyj4pERCZa4eft3pUmkT1UJREKZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8Ci9UaXRsZSA8NTg1YjE4MGVkMGM2MjMxMGRjMzQwN2RhNTYwOGM2YTRmMDAwY2VkNDc1OWUyMzU3PgovQXV0aG9yIDw0ODBlM2IxZGNhYzg+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3Mjk1Ci9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw0OTRlZjc4Y2Q4MTU4ZTJjNDYzMTEwMzE1YjY2ZDFkMTExMDMxN2QwZTYxMWQ1NzRlOTVjMmZjZmJhMzliNWRjPgovVSA8OTZkMjQzZGU0MjBjNjIyN2E4NzBmNTUyNjg5YjE2ZWYyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCAxMAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTI5IDAwMDAwIG4gCjAwMDAwMDAyNjkgMDAwMDAgbiAKMDAwMDAwMDMzOSAwMDAwMCBuIAowMDAwMDAwNDcyIDAwMDAwIG4gCjAwMDAwMDA2MTIgMDAwMDAgbiAKMDAwMDAwMDcyMiAwMDAwMCBuIAowMDAwMDAwODI0IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgMTAKL1Jvb3QgMSAwIFIKL0luZm8gOCAwIFIKL0lEIFsgPDMxMzI2NDM4NjEzNDMwNjEzMjM0NjYzOTM0MzczMTMzNjUzODYzNjIzNTYxNjQzMzY0NjU2MTM5NjY2MzY2MzU+IDwzMTMyNjQzODYxMzQzMDYxMzIzNDY2MzkzNDM3MzEzMzY1Mzg2MzYyMzU2MTY0MzM2NDY1NjEzOTY2NjM2NjM1PiBdCi9FbmNyeXB0IDkgMCBSCj4+CnN0YXJ0eHJlZgoxMDM5CiUlRU9GCg==",
  "aes_128_user": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDExMgo+PgpzdHJlYW0KrfV8XjBBkKULRwelmeWpWvOxll1Lt40nFax/R0f9RKqfVLKrLmd7lnCvrRxDWAHe5uBp4o3uIhlg7OMCgDmuZ/L+wOGD6sMHNsM6JhXUsfS0JVGAYYxU7Or866KvJeM3ka80i8w5jUMFbIiEL7hg/QplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDgwCj4+CnN0cmVhbQrjS0InzrvEscgQTlTBIGtmfuHdGDt4tBlIwEiS08x/269rp0L/q53UutSvauu0mKxtcxSI3/ukgZMjliFvdnfeyrhGoyl+Eh03APmaHpZM2AplbmRzdHJlYW0KZW5kb2JqCjggMCBvYmoKPDwKL1RpdGxlIDw4NWEwYTkyYWE4MGQ2YTcwZWI0YzIxOTE5N2JjYjQwOWYyNDcyZmMzMGVjMDU5NWFiMTQ4YjI0NWFlOTU0N2RkYjM5MjIzZGJhNjNjMzg0MDlkYjhlZDhhZWM1M2VkY2Y+Ci9BdXRob3IgPDdlOTNjMWU2NzczMTQ2NDkyZWJkMTM1OGZlZTI4YTVkNTM5NDRjYjVhNTgzNTc5ZWJlZDc5ODMwOTBjNDUwNmE+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDQKL1IgNAovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3Mjk1Ci9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw0OTRlZjc4Y2Q4MTU4ZTJjNDYzMTEwMzE1YjY2ZDFkMTExMDMxN2QwZTYxMWQ1NzRlOTVjMmZjZmJhMzliNWRjPgovVSA8OTZkMjQzZGU0MjBjNjIyN2E4NzBmNTUyNjg5YjE2ZWYyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KL0NGIDw8Ci9TdGRDRiA8PAovQXV0aEV2ZW50IC9Eb2NPcGVuCi9DRk0gL0FFU1YyCi9MZW5ndGggMTYKPj4KPj4KL1N0bUYgL1N0ZENGCi9TdHJGIC9TdGRDRgo+PgplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjkgMDAwMDAgbiAKMDAwMDAwMDI2OSAwMDAwMCBuIAowMDAwMDAwMzM5IDAwMDAwIG4gCjAwMDAwMDA1MDIgMDAwMDAgbiAKMDAwMDAwMDY0MiAwMDAwMCBuIAowMDAwMDAwNzcyIDAwMDAwIG4gCjAwMDAwMDA5NzQgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxMAovUm9vdCAxIDAgUgovSW5mbyA4IDAgUgovSUQgWyA8MzEzMjY0Mzg2MTM0MzA2MTMyMzQ2NjM5MzQzNzMxMzM2NTM4NjM2MjM1NjE2NDMzNjQ2NTYxMzk2NjYzNjYzNT4gPDMxMzI2NDM4NjEzNDMwNjEzMjM0NjYzOTM0MzczMTMzNjUzODYzNjIzNTYxNjQzMzY0NjU2MTM5NjY2MzY2MzU+IF0KL0VuY3J5cHQgOSAwIFIKPj4Kc3RhcnR4cmVmCjEyODEKJSVFT0YK",
  "aes_256_r5_user": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDExMgo+PgpzdHJlYW0K34Zrprh3QIM+cIBH5MahcPTIKky9KmuyItXUi3XmximHC/DQ3zuuEPPJrybymCCNAfD/GxTAuoFksttI8ev6m22yVevkxS++klWSIik83hA/j8nLx5L5wcTiwsRrR3Jidqf+aAiEuIGDIoDeYC/QDwplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDgwCj4+CnN0cmVhbQqVaokFihivpLCnhboPFMvN1pjJUJ9K23cEcQAskQJxAhGyc2xWV92LjbW1fyzGNc/y72ZBUj3wEbG7hW+KALZqolKkMB94HdaDOb0N+Kv45AplbmRzdHJlYW0KZW5kb2JqCjggMCBvYmoKPDwKL1RpdGxlIDw1ZmQ1ZGI5MjUzMjEwYjA2NWQyNjQ4ODdlNWYzOGVhYzQ5OTY0ZTJiYjBkOTFjMzk4ZjdlNmE4OGVkNmZiMTlkMTJlMjhhMzUwOWVjYTkwNzk3YmQ1ZmQzOTE1ZTFjNTQ+Ci9BdXRob3IgPDQzN2MyOTFkMWZmZjdjMjI1ODU2MzBjNGQ2Y2ExMzY1ZWIyMDYyZmUxMjZlMzUyOWFkZDIyY2ZjMjAxZjBkOWU+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDUKL1IgNQovTGVuZ3RoIDI1NgovUCA0Mjk0OTY3Mjk1Ci9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw2OTZlYjUzOGIxYTc4NzRlMTc1NDFjOWQ2Zjg1NWNiOWM2NTNiOTRiOWQ5NTZlZTk2MTg0NzE0ZTQxNWY0NzkwZTUwNDJiNDA1YTc5OWIzMGI3OTM0YTc3NjlmOTY2YmE+Ci9VIDw3YTZjZmE4ZWMwNmZiN2U2ZjI5NDZkYzZmZmNkYjk1NTY5YjJiZDlkY2RiYzNjZWUyM2M2YTU5N2I0NWMxZWNmYWRkMjdlMDZlYTMzNmFiNzIwMGI2MmQ0NWYwZDk0M2I+Ci9DRiA8PAovU3RkQ0YgPDwKL0F1dGhFdmVudCAvRG9jT3BlbgovQ0ZNIC9BRVNWMwovTGVuZ3RoIDMyCj4+Cj4+Ci9TdG1GIC9TdGRDRgovU3RyRiAvU3RkQ0YKL09FIDxjMTk0NDE2ZWY4ODQ0M2RmYTBhNGZkZWI0NGE1YzhjZjI2OTQ0Y2YxOTQwODhmZjY0ZWViY2MwMmVjMTdiYmExPgovVUUgPDcxMGYxYjU5YTI5ZTk3NzkzMjExYTg5NjNiMGYyOTBkNDcyYWExNDM2YjE5N2FiNTY4MGZiMjA2NzY1YzA5MDk+Ci9QZXJtcyA8NGIzMDUxNDQ4ZGQ3YWI3ZmM2NzhjYjQxZTJjNWI5NmY+Cj4+CmVuZG9iagp4cmVmCjAgMTAKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyOSAwMDAwMCBuIAowMDAwMDAwMjY5IDAwMDAwIG4gCjAwMDAwMDAzMzkgMDAwMDAgbiAKMDAwMDAwMDUwMiAwMDAwMCBuIAowMDAwMDAwNjQyIDAwMDAwIG4gCjAwMDAwMDA3NzIgMDAwMDAgbiAKMDAwMDAwMDk3NCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEwCi9Sb290IDEgMCBSCi9JbmZvIDggMCBSCi9JRCBbIDwzMTMyNjQzODYxMzQzMDYxMzIzNDY2MzkzNDM3MzEzMzY1Mzg2MzYyMzU2MTY0MzM2NDY1NjEzOTY2NjM2NjM1PiA8MzEzMjY0Mzg2MTM0MzA2MTMyMzQ2NjM5MzQzNzMxMzM2NTM4NjM2MjM1NjE2NDMzNjQ2NTYxMzk2NjYzNjYzNT4gXQovRW5jcnlwdCA5IDAgUgo+PgpzdGFydHhyZWYKMTUyOQolJUVPRgo=",
  "aes_256_user": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDExMgo+PgpzdHJlYW0Kam6GCiLyO8VdxnEAOmhYtJe/CIvUipfnFkpZwtnmRJhceFbXyFL5C9ExOWHdaXZSN1qcG6nu9UzDOhxtyak9uCVmEtBJNclW058dc6WGaOIjX+Cw5TPvSWnbIHqdzPzvufPxy8wP6BSp6bqeP2n37gplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDgwCj4+CnN0cmVhbQo16A659NT4ynus+gm3OCiTUMaYs9VmM+a2e5k309yhMHHsWqO0yxG/NNfT75UU7bAcfR1Rn9zYn+kp74Hq9I1eHw8ljuJyZ3/qyUTbOcZrjgplbmRzdHJlYW0KZW5kb2JqCjggMCBvYmoKPDwKL1RpdGxlIDw1MTU4NTM5YWM3NTc5Mzg4NjY3ZWQ0ZDcxNWQzMzM5NDU1ZDgwMTU4ZTRjNDZkNWJkNTQwMDhjMmQyNTZkMGJhNjg2Nzc4Yzg3Njg4M2FkOGNjZjhiMGY3ZjVjMDM4YzY+Ci9BdXRob3IgPDQ1ZGQyNDdlODRkMDZmNTllMWE5OWQxYzE4NWI5ODYyYjMxMTYyN2VlZjQ1ZjA0YWI5MDU1Njk0MzhhYjAzYWE+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDUKL1IgNgovTGVuZ3RoIDI1NgovUCA0Mjk0OTY3Mjk1Ci9GaWx0ZXIgL1N0YW5kYXJkCi9PIDwxY2I4ZDRhYmVlMTNiZGUyMTYzNWQ1NGRlYmZhMjgzZjVkZTAzMDZjMjJkYWE4M2Y4Yjg5YWRjOTI1ZGVjODVmMDI1ZWVmMzJmYTExNzcxOWI3ZDM4NmY4MTkwYWUxYzE+Ci9VIDwzYjIzMjg3NmYwN2YxMjZjYjA2NGE5ZDE5M2E0MDA5MjNlODU0MGNmNDQ0ZTJhZTAxMTFmZGJkOTZhMWQyNDljYmYzMjlkZDE2ODY3ZGM0ZWQwMGNiMjBhNzFlNDUzY2U+Ci9DRiA8PAovU3RkQ0YgPDwKL0F1dGhFdmVudCAvRG9jT3BlbgovQ0ZNIC9BRVNWMwovTGVuZ3RoIDMyCj4+Cj4+Ci9TdG1GIC9TdGRDRgovU3RyRiAvU3RkQ0YKL09FIDwwN2FlYWUyNzM3OWJjMGU5ZGE5NmE3ZTEwNjk5NjI3MmNlYTY3NDI3NDYxNmEyM2I0ZjViMDVmZmZmNzcwODU4PgovVUUgPGJiYmRiNmZiYWI1ZTZlZmEyYjJjYTUzNDMyYTQyZmZkMTBlZWNiNDViNTlkMmQxYWZjYWU4NTZlZDg1YjY4YjA+Ci9QZXJtcyA8YjE2NTEzNzg4NTg0MDlmNjBhYzhmYWQ0YmUyMWYwMmQ+Cj4+CmVuZG9iagp4cmVmCjAgMTAKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyOSAwMDAwMCBuIAowMDAwMDAwMjY5IDAwMDAwIG4gCjAwMDAwMDAzMzkgMDAwMDAgbiAKMDAwMDAwMDUwMiAwMDAwMCBuIAowMDAwMDAwNjQyIDAwMDAwIG4gCjAwMDAwMDA3NzIgMDAwMDAgbiAKMDAwMDAwMDk3NCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEwCi9Sb290IDEgMCBSCi9JbmZvIDggMCBSCi9JRCBbIDwzMTMyNjQzODYxMzQzMDYxMzIzNDY2MzkzNDM3MzEzMzY1Mzg2MzYyMzU2MTY0MzM2NDY1NjEzOTY2NjM2NjM1PiA8MzEzMjY0Mzg2MTM0MzA2MTMyMzQ2NjM5MzQzNzMxMzM2NTM4NjM2MjM1NjE2NDMzNjQ2NTYxMzk2NjYzNjYzNT4gXQovRW5jcnlwdCA5IDAgUgo+PgpzdGFydHhyZWYKMTUyOQolJUVPRgo=",
  "rc4_40_blank": "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgNiAwIFIgXQovQ291bnQgMgo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNCAwIFIKPj4KPj4KL0NvbnRlbnRzIDUgMCBSCi9Bbm5vdHMgWyBdCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDgzCj4+CnN0cmVhbQrfM2capJMprOzSuIAnffdxJQFuQsagabMPzWVoVJoBpCJw0FEvUd5YdUMDlKHLLtLHSBcHdL4RxO9wMP6MZISqCfmyXImuotwI5gn726Pfu717nQplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0YxIDQgMCBSCj4+Cj4+Ci9Db250ZW50cyA3IDAgUgovQW5ub3RzIFsgXQo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDYwCj4+CnN0cmVhbQoshKh3aOV+2cwxO69b716F/ybiSBlyWWUsIJUzbFE5roEe7bxDD/yO2kCCDRPjinMjboIWXQTNlwABg+cKZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8Ci9UaXRsZSA8MjUzM2EwZjJkNDNiZTQ2Zjc5MDY4YWY4OTc0MmQzN2U4ODQ4NGM3YTBkNTNkNzdiPgovQXV0aG9yIDwzNTY2ODNlMWNlMzU+Cj4+CmVuZG9iago5IDAgb2JqCjw8Ci9WIDEKL1IgMgovTGVuZ3RoIDQwCi9QIDQyOTQ5NjcyNzUKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDI4MDZkNGVhY2JjNTIyMzkxNjVjZWVhMjBkMTUzNjkxMGZjNjQ2YWMyMjM3ZWM2MDQ5MjI2YTNjODY5M2Y0YjE+Ci9VIDwzNjJjZTljOThmODhhZTA0NTQzZDBlZmYwNDc4YjAyMmI0ZTk1ODE4ZGY5NjYzZDFkNjMzMTVmOWYwOTYxNmYwPgo+PgplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjkgMDAwMDAgbiAKMDAwMDAwMDI2OSAwMDAwMCBuIAowMDAwMDAwMzM5IDAwMDAwIG4gCjAwMDAwMDA0NzIgMDAwMDAgbiAKMDAwMDAwMDYxMiAwMDAwMCBuIAowMDAwMDAwNzIyIDAwMDAwIG4gCjAwMDAwMDA4MjQgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxMAovUm9vdCAxIDAgUgovSW5mbyA4IDAgUgovSUQgWyA8MzEzMjY0Mzg2MTM0MzA2MTMyMzQ2NjM5MzQzNzMxMzM2NTM4NjM2MjM1NjE2NDMzNjQ2NTYxMzk2NjYzNjYzNT4gPDMxMzI2NDM4NjEzNDMwNjEzMjM0NjYzOTM0MzczMTMzNjUzODYzNjIzNTYxNjQzMzY0NjU2MTM5NjY2MzY2MzU+IF0KL0VuY3J5cHQgOSAwIFIKPj4Kc3RhcnR4cmVmCjEwMzgKJSVFT0YK"
};
