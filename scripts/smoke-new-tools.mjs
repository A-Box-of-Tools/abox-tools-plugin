import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { withBrowser } from '../src/browser.mjs';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { standardSecurity, WrongPasswordError } from '../vendor/abox/shared/js/pdf-crypt.js';
import { decodeStream } from '../vendor/abox/shared/js/pdf-filters.js';
import { readSource } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { demux } from '../vendor/abox/shared/js/mp4-reader.js';
import { parseGif, frameData, paletteFor } from '../vendor/abox/tools/gif-analyzer/src/gif.js';
import { lzwDecode } from '../vendor/abox/tools/gif-analyzer/src/lzw.js';
import { parseYaml } from '../vendor/abox/shared/js/parse-yaml.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const privateSummary = (result, secrets) => {
  const json = JSON.stringify(result);
  for (const secret of secrets) assert.ok(!json.includes(secret), 'A private fixture value reached an MCP result.');
};
const pngSize = bytes => {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function solidPng(width, height, rgb) {
  const header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([...rgb, 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function wavFixture() {
  const frames = 400, bytes = Buffer.alloc(58 + frames * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(18, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('fact', 38); bytes.writeUInt32LE(4, 42);
  bytes.writeUInt32LE(frames, 46); bytes.write('data', 50); bytes.writeUInt32LE(frames * 4, 54);
  for (let at = 0; at < frames; at++) bytes.writeFloatLE((at % 13 - 6) / 16, 58 + at * 4);
  return bytes;
}
function wavSamples(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); let data, frames;
  for (let at = 12; at < bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), from = at + 8, type = bytes.toString('ascii', at, at + 4);
    assert.ok(from + size <= bytes.length);
    if (type === 'fmt ') { assert.equal(bytes.readUInt16LE(from), 3); assert.equal(bytes.readUInt16LE(from + 2), 1); assert.equal(bytes.readUInt32LE(from + 4), 8000); assert.equal(bytes.readUInt16LE(from + 14), 32); }
    if (type === 'fact') frames = bytes.readUInt32LE(from);
    if (type === 'data') data = bytes.subarray(from, from + size);
    at = from + size + (size & 1);
  }
  assert.ok(data); assert.equal(data.length, frames * 4);
  return Array.from({ length: frames }, (_, at) => data.readFloatLE(at * 4));
}
function dicomFixture(rle = false) {
  const element = (group, tag, vr, value) => {
    let data = Buffer.isBuffer(value) ? value : Buffer.from(value); if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
    const long = vr === 'OW', bytes = Buffer.alloc(long ? 12 : 8); bytes.writeUInt16LE(group); bytes.writeUInt16LE(tag, 2); bytes.write(vr, 4);
    long ? bytes.writeUInt32LE(data.length, 8) : bytes.writeUInt16LE(data.length, 6); return Buffer.concat([bytes, data]);
  };
  const us = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
  const meta = element(2, 0x10, 'UI', rle ? '1.2.840.10008.1.2.5' : '1.2.840.10008.1.2.1'), length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const pixels = Buffer.alloc(8); [0, 100, 200, 300].forEach((value, at) => pixels.writeUInt16LE(value, at * 2));
  let pixelData = element(0x7fe0, 0x10, 'OW', pixels);
  if (rle) {
    const header = Buffer.alloc(64); header.writeUInt32LE(2); header.writeUInt32LE(64, 4); header.writeUInt32LE(68, 8);
    const compressed = Buffer.concat([header, Buffer.from([254, 0, 0, 1, 3, 0, 100, 200, 44, 0])]);
    const item = (tag, data) => { const bytes = Buffer.alloc(8); bytes.writeUInt16LE(0xfffe); bytes.writeUInt16LE(tag, 2); bytes.writeUInt32LE(data.length, 4); return Buffer.concat([bytes, data]); };
    const pixel = Buffer.alloc(12); pixel.writeUInt16LE(0x7fe0); pixel.writeUInt16LE(0x10, 2); pixel.write('OB', 4); pixel.writeUInt32LE(0xffffffff, 8);
    pixelData = Buffer.concat([pixel, item(0xe000, Buffer.alloc(0)), item(0xe000, compressed), item(0xe0dd, Buffer.alloc(0))]);
  }
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', length), meta,
    element(0x10, 0x10, 'PN', 'PRIVATE^DICOM^PERSON'), element(0x10, 0x20, 'LO', 'PRIVATE-DICOM-ID'),
    ...[[0x10, 2], [0x11, 2], [2, 1], [0x100, 16], [0x101, 16], [0x102, 15], [0x103, 0]].map(([tag, value]) => element(0x28, tag, 'US', us(value))),
    element(0x28, 4, 'CS', 'MONOCHROME2'), pixelData]);
}
async function packetFixture(marker) {
  // These are identifiable copy-only packets, deliberately not a video codec
  // fixture. Native encoding and decoding are exercised separately below.
  const writer = new Mp4Writer(), track = writer.addTrack({ kind: 'vide', timescale: 1000, width: 16 << 16, height: 24 << 16,
    sampleEntry: avcSampleEntry(16, 24, Uint8Array.from([1, 66, 0, 30, 255])) });
  for (let at = 0; at < 4; at++) track.addSample({ data: Uint8Array.from([marker, at, 55]), dts: at * 1000, pts: at * 1000, duration: 1000, isKey: true });
  return Buffer.from(await writer.finalize().arrayBuffer());
}
async function mp4(bytes) { return demux(new File([bytes], 'smoke.mp4'), { timeline: 'media' }); }
const packets = (bytes, media) => media.video.samples.map(sample => [...bytes.subarray(sample.offset, sample.offset + sample.size)]);
async function renderedPixels(filename, video = false) {
  return withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: video ? 'created.mp4' : 'preview.png', mimeType: video ? 'video/mp4' : 'image/png', buffer: await readFile(filename) });
    return page.evaluate(async video => {
      const file = document.querySelector('#input').files[0];
      if (!video) {
        const bitmap = await createImageBitmap(file), canvas = document.createElement('canvas');
        try { canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data); }
        finally { bitmap.close(); canvas.width = canvas.height = 0; }
      }
      const { demux } = await import('/vendor/abox/shared/js/mp4-reader.js'), { decoderConfig, micros } = await import('/vendor/abox/shared/js/webcodecs.js');
      const { video: track } = await demux(file), frames = []; let failed = false;
      const decoder = new VideoDecoder({ output: frame => {
        const canvas = document.createElement('canvas');
        try { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; const context = canvas.getContext('2d'); context.drawImage(frame, 0, 0);
          frames.push({ timestamp: frame.timestamp, color: Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data) });
        } finally { frame.close(); canvas.width = canvas.height = 0; }
      }, error: () => { failed = true; } });
      try {
        decoder.configure(decoderConfig(track));
        for (const sample of track.samples) decoder.decode(new EncodedVideoChunk({ type: sample.isKey ? 'key' : 'delta', timestamp: micros(sample.pts, track.timescale), data: await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer() }));
        await decoder.flush(); if (failed) throw new Error('Generated smoke video failed independent native decoding.');
        return frames.sort((a, b) => a.timestamp - b.timestamp).map(frame => frame.color);
      } finally { if (decoder.state !== 'closed') decoder.close(); }
    }, video);
  });
}
async function pdfFingerprints(bytes, password) {
  const options = password === undefined ? {} : { unlock: standardSecurity(password).unlock };
  const document = await PdfDocument.open(new Uint8Array(bytes), options), source = readSource(document, 'Smoke fixture');
  const fingerprints = [];
  for (const page of source.pages) {
    const contents = document.resolve(page.dict.get('Contents')), streams = Array.isArray(contents) ? contents.map(item => document.resolve(item)) : [contents];
    const decoded = [];
    for (const stream of streams) { assert.ok(stream?.raw); const value = await decodeStream(stream, item => document.resolve(item)); assert.deepEqual(value.remaining, []); decoded.push(Buffer.from(value.bytes)); }
    fingerprints.push(hash(Buffer.concat(decoded)));
  }
  return { pages: document.countPages(), fingerprints, encrypted: document.trailer.has('Encrypt') };
}
function imagePayload(bytes) {
  const kept = []; let exif = null;
  if (bytes[0] === 255 && bytes[1] === 216) {
    kept.push(bytes.subarray(0, 2));
    for (let at = 2; at < bytes.length;) {
      assert.equal(bytes[at], 255); const marker = bytes[at + 1];
      if (marker === 218) { kept.push(bytes.subarray(at)); return { picture: Buffer.concat(kept), exif }; }
      const end = at + 2 + bytes.readUInt16BE(at + 2); assert.ok(end <= bytes.length);
      if (marker === 225 && bytes.toString('latin1', at + 4, at + 10) === 'Exif\0\0') { assert.equal(exif, null); exif = bytes.subarray(at + 10, end); }
      else kept.push(bytes.subarray(at, end)); at = end;
    }
    assert.fail('The synthetic JPEG has no complete scan.');
  }
  pngSize(bytes); kept.push(bytes.subarray(0, 8));
  for (let at = 8; at < bytes.length;) {
    const end = at + 12 + bytes.readUInt32BE(at); assert.ok(end <= bytes.length);
    if (bytes.toString('ascii', at + 4, at + 8) === 'eXIf') { assert.equal(exif, null); exif = bytes.subarray(at + 8, end - 4); }
    else kept.push(bytes.subarray(at, end)); at = end;
  }
  return { picture: Buffer.concat(kept), exif };
}
function smokeExifValues(bytes) {
  assert.ok(bytes); const little = bytes.toString('ascii', 0, 2) === 'II', view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(2, little), 42); const values = new Map(), queue = [view.getUint32(4, little)], seen = new Set();
  while (queue.length) {
    const offset = queue.pop(); assert.ok(!seen.has(offset) && offset >= 8); seen.add(offset); assert.ok(seen.size <= 2);
    const count = view.getUint16(offset, little); assert.ok(offset + 2 + count * 12 + 4 <= bytes.length);
    for (let at = offset + 2; at < offset + 2 + count * 12; at += 12) {
      const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little), count = view.getUint32(at + 4, little);
      if (tag === 0x8769) { assert.equal(type, 4); assert.equal(count, 1); queue.push(view.getUint32(at + 8, little)); continue; }
      assert.ok(type === 2 || type === 7); const from = count <= 4 ? at + 8 : view.getUint32(at + 8, little); assert.ok(from + count <= bytes.length);
      assert.ok(!values.has(tag)); values.set(tag, bytes.subarray(from, from + count));
    }
  }
  return values;
}

export async function smokeNewTools({ call, client, workspace, imageInput, imageResized, pdfInput, qrPath, qrPayload = 'https://abox.tools/' }) {
  const covered = [], capabilityAbsences = [], sourceHashes = new Map();
  const run = async (name, args) => { const result = await call(client, name, args); covered.push(name); return result; };
  const local = name => path.join(workspace, name);
  const remember = async filename => sourceHashes.set(filename, hash(await readFile(filename)));
  for (const filename of [imageInput, imageResized, pdfInput, qrPath]) await remember(filename);

  const readPath = local('read code.json'), read = await run('abox_code_read', { input_path: qrPath, output_path: readPath });
  assert.equal(read.found, true); assert.equal(read.symbology, 'qr'); assert.equal(read.verified, true);
  assert.equal(read.verification.external_requests, false); assert.equal(read.verification.sampled_qr_modules, true);
  const report = JSON.parse(await readFile(readPath, 'utf8')); assert.equal(report.code.text, String(qrPayload)); privateSummary(read, [String(qrPayload)]);

  const redPath = local('solid red.png'), bluePath = local('solid blue.png');
  await writeFile(redPath, solidPng(64, 64, [255, 0, 0])); await writeFile(bluePath, solidPng(64, 64, [0, 0, 255]));
  await remember(redPath); await remember(bluePath);
  const gifPath = local('created two frames.gif'), gif = await run('abox_gif_create', { input_paths: [redPath, bluePath], output_path: gifPath,
    width: 64, height: 64, delays_ms: [100, 200], dither: false, loop: 'once' });
  assert.equal(gif.verified, true); assert.equal(gif.frame_count, 2); assert.equal(gif.verification.lzw_end_codes, true);
  const gifBytes = new Uint8Array(await readFile(gifPath)), parsedGif = parseGif(gifBytes); assert.equal(parsedGif.frames.length, 2);
  for (const [at, frame] of parsedGif.frames.entries()) {
    assert.equal(frame.delay, at ? 20 : 10); const compressed = frameData(gifBytes, frame), decoded = lzwDecode(compressed, frame.minCodeSize, frame.width * frame.height);
    assert.equal(decoded.complete, true); assert.equal(decoded.truncated, false); assert.equal(decoded.corrupt, null); assert.equal(decoded.overrun, 0);
    assert.equal(decoded.pixels, frame.width * frame.height); assert.equal(decoded.bytesRead, compressed.length);
    const palette = paletteFor(parsedGif, frame).colors, wanted = at ? [0, 0, 255] : [255, 0, 0];
    for (const index of decoded.indices) assert.deepEqual([...palette.subarray(index * 3, index * 3 + 3)], wanted);
  }
  await remember(gifPath);

  const passwordFile = local('retained PDF password.txt'), password = ' exact release-smoke password\n'; await writeFile(passwordFile, password); await remember(passwordFile);
  const beforePdf = await pdfFingerprints(await readFile(pdfInput)), encryptedPath = local('password protected.pdf');
  const protectedPdf = await run('abox_pdf_protect', { input_path: pdfInput, output_path: encryptedPath, open_password_file: passwordFile, restrict_copy: true });
  assert.equal(protectedPdf.revision, 6); assert.equal(protectedPdf.bits, 256); assert.equal(protectedPdf.verified, true);
  assert.equal(protectedPdf.verification.blank_password_refused, true); assert.equal(protectedPdf.verification.reachable_graph, true);
  privateSummary(protectedPdf, [password, passwordFile]);
  const encryptedBytes = await readFile(encryptedPath); await assert.rejects(PdfDocument.open(new Uint8Array(encryptedBytes)), EncryptedPdfError);
  await assert.rejects(PdfDocument.open(new Uint8Array(encryptedBytes), { unlock: standardSecurity('').unlock }), WrongPasswordError);
  assert.deepEqual((await pdfFingerprints(encryptedBytes, password)).fingerprints, beforePdf.fingerprints); await remember(encryptedPath);
  const unlockedPath = local('unlocked.pdf'), unlocked = await run('abox_pdf_unlock', { input_path: encryptedPath, output_path: unlockedPath, password_file: passwordFile });
  assert.equal(unlocked.verified, true); assert.equal(unlocked.verification.encryption_removed, true); privateSummary(unlocked, [password, passwordFile]);
  assert.deepEqual(await pdfFingerprints(await readFile(unlockedPath)), beforePdf);

  const wavPath = local('source float.wav'), wavBytes = wavFixture(), originalSamples = wavSamples(wavBytes); await writeFile(wavPath, wavBytes); await remember(wavPath);
  const editPath = local('reversed float.wav'), edited = await run('abox_audio_edit', { input_path: wavPath, output_path: editPath, reverse: true, bits: 32 });
  assert.equal(edited.verified, true); assert.equal(edited.verification.all_encoded_samples, true); assert.equal(edited.frames, 400);
  assert.deepEqual(wavSamples(await readFile(editPath)), originalSamples.toReversed()); assert.equal(edited.source_metadata_copied, false);
  const trimPath = local('trimmed float.wav'), trimmed = await run('abox_audio_trim', { input_path: wavPath, output_path: trimPath, ranges: [{ start: 0.01, end: 0.03 }], fade_ms: 0, bits: 32 });
  assert.equal(trimmed.verified, true); assert.equal(trimmed.frames, 160); assert.deepEqual(wavSamples(await readFile(trimPath)), originalSamples.slice(80, 240));

  const videoA = local('copy packet one.mp4'), videoB = local('copy packet two.mp4');
  await writeFile(videoA, await packetFixture(10)); await writeFile(videoB, await packetFixture(30)); await remember(videoA); await remember(videoB);
  const inspectedVideo = await run('abox_video_inspect', { input_path: videoA }); assert.equal(inspectedVideo.video.sample_count, 4);
  assert.equal(inspectedVideo.header_only, true); assert.equal(inspectedVideo.verified, false); assert.equal(inspectedVideo.decoding_verified, false);
  assert.ok(!Object.hasOwn(inspectedVideo.video, 'samples'));
  const cutPath = local('copy trimmed.mp4'), cut = await run('abox_video_trim', { input_path: videoA, output_path: cutPath, ranges: [{ start: 1, end: 3 }], keep_audio: false });
  assert.equal(cut.verified, true); assert.equal(cut.reencoded, false); assert.equal(cut.verification.decoding, false);
  const cutBytes = await readFile(cutPath); assert.deepEqual(packets(cutBytes, await mp4(cutBytes)), [[10, 1, 55], [10, 2, 55]]);
  const joinPath = local('copy joined.mp4'), joined = await run('abox_video_join', { input_paths: [videoA, videoB], output_path: joinPath, keep_audio: false });
  assert.equal(joined.verified, true); assert.equal(joined.verification.packet_bytes, true); assert.equal(joined.verification.decoding, false);
  const joinBytes = await readFile(joinPath); assert.deepEqual(packets(joinBytes, await mp4(joinBytes)), [10, 30].flatMap(marker => [0, 1, 2, 3].map(at => [marker, at, 55])));

  const rotatePath = local('copy rotated.mp4'), rotated = await run('abox_video_rotate', { input_path: videoA, output_path: rotatePath });
  assert.equal(rotated.verified, true); assert.equal(rotated.reencoded, false); assert.equal(rotated.verification.decoding, false);
  const originalVideoBytes = await readFile(videoA), originalVideo = await mp4(originalVideoBytes), rotateBytes = await readFile(rotatePath), rotatedVideo = await mp4(rotateBytes);
  assert.deepEqual(packets(rotateBytes, rotatedVideo), packets(originalVideoBytes, originalVideo));
  assert.deepEqual(rotatedVideo.video.sampleEntry, originalVideo.video.sampleEntry); assert.equal(rotatedVideo.video.rotation, 90);
  assert.deepEqual([rotatedVideo.video.codedWidth, rotatedVideo.video.codedHeight], [16, 24]);
  assert.deepEqual([rotatedVideo.video.displayWidth, rotatedVideo.video.displayHeight], [24, 16]);
  const matrix = new DataView(rotatedVideo.video.matrix.buffer, rotatedVideo.video.matrix.byteOffset, 36);
  assert.deepEqual(Array.from({ length: 9 }, (_, at) => matrix.getInt32(at * 4)), [0, 65536, 0, -65536, 0, 0, 24 * 65536, 0, 0x40000000]);
  assert.deepEqual(rotatedVideo.video.samples.map(({ dts, pts, duration }) => [dts, pts, duration]), originalVideo.video.samples.map(({ dts, pts, duration }) => [dts, pts, duration]));
  const remuxPath = local('copy remuxed.mp4'), remuxed = await run('abox_video_remux', { input_path: videoA, output_path: remuxPath });
  assert.equal(remuxed.verified, true); assert.equal(remuxed.reencoded, false); assert.equal(remuxed.verification.decoding, false);
  const remuxBytes = await readFile(remuxPath), remuxVideo = await mp4(remuxBytes);
  assert.deepEqual(packets(remuxBytes, remuxVideo), packets(originalVideoBytes, originalVideo));
  assert.deepEqual(remuxVideo.video.sampleEntry, originalVideo.video.sampleEntry); assert.deepEqual(remuxVideo.video.matrix, originalVideo.video.matrix);
  assert.deepEqual(remuxVideo.video.samples.map(({ dts, pts, duration }) => [dts, pts, duration]), originalVideo.video.samples.map(({ dts, pts, duration }) => [dts, pts, duration]));

  const scanConfig = local('scan corners.json'), scanPath = local('scanned.png');
  const [scanWidth, scanHeight] = pngSize(await readFile(imageInput));
  await writeFile(scanConfig, JSON.stringify({ pages: [{ image_width: scanWidth, image_height: scanHeight,
    corners: [{ x: 0, y: 0 }, { x: scanWidth, y: 0 }, { x: scanWidth, y: scanHeight }, { x: 0, y: scanHeight }] }] }));
  await remember(scanConfig);
  const scan = await run('abox_document_scan', { input_paths: [imageInput], config_path: scanConfig, output_path: scanPath, format: 'png', mode: 'photo' });
  assert.equal(scan.verified, true); assert.equal(scan.verification.png_all_pixels, true); assert.equal(scan.page_count, 1);
  assert.ok(!Object.hasOwn(scan.pages[0], 'corners')); assert.deepEqual(pngSize(await readFile(scanPath)), [scan.pages[0].width, scan.pages[0].height]);

  const portraitPath = local('custom portrait.png'), idConfig = local('custom portrait settings.json');
  await writeFile(portraitPath, solidPng(600, 800, [160, 80, 40])); await remember(portraitPath);
  await writeFile(idConfig, JSON.stringify({ image_width: 600, image_height: 800, width_mm: 35, height_mm: 45, dpi: 150,
    head_min_mm: 30, head_max_mm: 32, eye_min_mm: 24, eye_max_mm: 26,
    landmarks: { crown: { x: 300, y: 100 }, chin: { x: 300, y: 580 }, left_eye: { x: 240, y: 340 }, right_eye: { x: 360, y: 340 } } }));
  await remember(idConfig);
  const id = await run('abox_id_photo', { input_path: portraitPath, settings_path: idConfig, output_dir: local('custom portrait print set') });
  assert.equal(id.verified, true); assert.equal(id.verification.custom_geometry, true); assert.equal(id.verification.pixel_identity, false);
  assert.equal(id.output_count, 3); privateSummary(id, ['crown', 'left_eye']);
  const idReport = JSON.parse(await readFile(id.manifest_path, 'utf8')); assert.equal(idReport.regulatory_approval, false);
  for (const item of id.outputs) { const bytes = await readFile(item.output_path), jfif = bytes.indexOf(Buffer.from('JFIF\0')); assert.ok(jfif > 0); assert.equal(bytes[jfif + 7], 1); assert.equal(bytes.readUInt16BE(jfif + 8), 150); assert.equal(bytes.readUInt16BE(jfif + 10), 150); }

  const profileConfig = local('profile settings.json'), profilePath = local('business preview.svg'), privateName = 'PRIVATE BUSINESS PREVIEW';
  await writeFile(profileConfig, JSON.stringify({ profile: { name: privateName, status: 'open24' }, surface: 'panel' })); await remember(profileConfig);
  const profile = await run('abox_business_profile', { config_path: profileConfig, output_path: profilePath, format: 'svg' });
  assert.equal(profile.verified, true); assert.equal(profile.verification.passive_svg, true); assert.equal(profile.verification.external_references, false);
  assert.ok((await readFile(profilePath, 'utf8')).includes(privateName)); privateSummary(profile, [privateName]);
  const heightsConfig = local('height settings.json'), heightsPath = local('height comparison.png'), privateFigure = 'PRIVATE HEIGHT FIGURE';
  await writeFile(heightsConfig, JSON.stringify({ figures: [{ name: privateFigure, height: '170 cm', shape: 'woman' }, { height: '180 cm' }] })); await remember(heightsConfig);
  const heights = await run('abox_height_compare', { config_path: heightsConfig, output_path: heightsPath, scale: 1 });
  assert.equal(heights.verified, true); assert.equal(heights.item_count, 2); assert.equal(heights.verification.png_pixel_checks, heights.width * heights.height);
  assert.deepEqual(pngSize(await readFile(heightsPath)), [heights.width, heights.height]); privateSummary(heights, [privateFigure, '170 cm']);

  const receiptInput = local('printed receipt.png'), receiptPath = local('extracted receipt.json');
  const receiptPng = await withBrowser(page => page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 750; const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1000, 750); context.fillStyle = '#000000'; context.font = '42px monospace';
    ['ABOX TEST STORE', 'RECEIPT 12345', 'Date: 2026-10-27', 'Item A       10.00', 'Tax           1.50', 'TOTAL USD    11.50'].forEach((line, at) => context.fillText(line, 70, 100 + at * 95));
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  await writeFile(receiptInput, Buffer.from(receiptPng, 'base64')); await remember(receiptInput);
  const receipt = await run('abox_receipt_extract', { input_path: receiptInput, output_path: receiptPath });
  assert.equal(receipt.verified, true); assert.equal(receipt.review_required, true); assert.equal(receipt.confirmed, false);
  assert.equal(receipt.verification.extraction_accuracy, false); assert.equal(receipt.verification.network_requests, false);
  const receiptReport = JSON.parse(await readFile(receiptPath, 'utf8')); assert.match(receiptReport.text, /ABOX TEST STORE/); assert.equal(receiptReport.receipt.amount, '11.50');
  privateSummary(receipt, ['ABOX TEST STORE', '12345', '11.50', '2026-10-27']);

  const dicomInput = local('technical source.dcm'), dicomPath = local('technical preview.png'); await writeFile(dicomInput, dicomFixture()); await remember(dicomInput);
  const dicom = await run('abox_dicom_inspect', { input_path: dicomInput }); assert.equal(dicom.verified, false); assert.equal(dicom.header_verified, true);
  assert.equal(dicom.width, 2); assert.equal(dicom.height, 2); assert.equal(dicom.verification.decoded_pixels, false);
  const preview = await run('abox_dicom_render', { input_path: dicomInput, output_path: dicomPath, window_center: 150, window_width: 301 });
  assert.equal(preview.verified, true); assert.equal(preview.verification.native_samples_checked, 4); assert.equal(preview.verification.png_pixels_checked, 4);
  assert.deepEqual(pngSize(await readFile(dicomPath)), [2, 2]);
  assert.deepEqual(await renderedPixels(dicomPath), [0, 85, 170, 255].flatMap(value => [value, value, value, 255]));
  for (const result of [dicom, preview]) privateSummary(result, ['PRIVATE^DICOM^PERSON', 'PRIVATE-DICOM-ID']);
  const rleInput = local('technical RLE source.dcm'), rlePath = local('technical RLE preview.png'); await writeFile(rleInput, dicomFixture(true)); await remember(rleInput);
  const rleInfo = await run('abox_dicom_inspect', { input_path: rleInput }); assert.equal(rleInfo.verified, false);
  assert.equal(rleInfo.compression, 'rle-lossless'); assert.equal(rleInfo.compressed_stream_verified, true); assert.equal(rleInfo.verification.decoded_pixels, false);
  const rlePreview = await run('abox_dicom_render', { input_path: rleInput, output_path: rlePath, window_center: 150, window_width: 301 });
  assert.equal(rlePreview.verified, true); assert.equal(rlePreview.verification.compressed_stream, true);
  assert.equal(rlePreview.verification.native_samples_checked, 0); assert.equal(rlePreview.verification.stored_samples_checked, 4);
  assert.equal(rlePreview.verification.png_pixels_checked, 4); assert.equal(rlePreview.decoded_sample_layout, 'interleaved');
  assert.deepEqual(await renderedPixels(rlePath), [0, 85, 170, 255].flatMap(value => [value, value, value, 255]));
  for (const result of [rleInfo, rlePreview]) privateSummary(result, ['PRIVATE^DICOM^PERSON', 'PRIVATE-DICOM-ID']);

  const jpegInput = local('metadata source.jpg'), editsPath = local('EXIF changes.json'), artist = 'PRIVATE EXIF ARTIST', comment = 'PRIVATE EXIF NOTE 日本語';
  const jpegBase64 = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: await readFile(redPath) });
    return page.evaluate(async () => {
      const bitmap = await createImageBitmap(document.querySelector('#input').files[0]), canvas = document.createElement('canvas');
      try { canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]; }
      finally { bitmap.close(); canvas.width = canvas.height = 0; }
    });
  });
  await writeFile(jpegInput, Buffer.from(jpegBase64, 'base64')); await remember(jpegInput);
  await writeFile(editsPath, JSON.stringify({ set: [{ group: 'ifd0', tag: 0x013b, type: 2, value: artist }, { group: 'exif', tag: 0x9286, type: 7, value: comment }] })); await remember(editsPath);
  for (const [input, extension] of [[imageInput, 'png'], [jpegInput, 'jpg']]) {
    const output = local(`metadata edited.${extension}`), before = imagePayload(await readFile(input)); assert.equal(before.exif, null);
    const editedExif = await run('abox_exif_edit', { input_path: input, output_path: output, edits_path: editsPath });
    assert.equal(editedExif.verified, true); assert.equal(editedExif.set_count, 2); assert.equal(editedExif.removed_count, 0);
    assert.equal(editedExif.verification.compressed_picture_bytes, true); assert.equal(editedExif.verification.other_container_blocks, true);
    assert.equal(editedExif.verification.raw_tags, true); assert.equal(editedExif.verification.decoded_pixels, false);
    privateSummary(editedExif, [artist, comment]); const after = imagePayload(await readFile(output)); assert.deepEqual(after.picture, before.picture);
    const tags = smokeExifValues(after.exif); assert.deepEqual(tags.get(0x013b), Buffer.from(artist + '\0', 'ascii'));
    assert.deepEqual(tags.get(0x9286), Buffer.concat([Buffer.from('UNICODE\0'), Buffer.from(comment, 'utf16le')]));
  }

  const formatting = [
    { language: 'html', source: '<main><p>PRIVATE FORMAT TEXT</p><br></main>', options: { minify: true }, expected: '<main><p>PRIVATE FORMAT TEXT</p><br></main>\n' },
    { language: 'css', source: '.a,.b{--gap: +;color:red;}', options: { minify: true }, expected: '.a,.b{--gap:+;color:red}\n' },
    { language: 'yaml', source: 'secret: PRIVATE YAML VALUE\nnumber: +9007199254740993\n', options: {} },
  ];
  for (const fixture of formatting) {
    const input = local(`format source.${fixture.language}`), output = local(`format result.${fixture.language}`); await writeFile(input, fixture.source); await remember(input);
    const formatted = await run('abox_code_format', { input_path: input, output_path: output, language: fixture.language, ...fixture.options }), contents = await readFile(output, 'utf8');
    assert.equal(formatted.verified, true); assert.equal(formatted.language, fixture.language);
    privateSummary(formatted, ['PRIVATE FORMAT TEXT', 'PRIVATE YAML VALUE']);
    if (fixture.expected) assert.equal(contents, fixture.expected);
    else { const value = parseYaml(contents); assert.equal(value.pairs[0].value.value, 'PRIVATE YAML VALUE'); assert.equal(value.pairs[1].value.raw, '9007199254740993'); }
    if (fixture.language === 'html') assert.equal(formatted.verification.rendered_equivalence, false);
    if (fixture.language === 'css') assert.equal(formatted.verification.quoted_strings, true);
    if (fixture.language === 'yaml') assert.equal(formatted.verification.ordered_values, true);
  }
  const xmlInput = local('mapping source.xml'), xmlJsonPath = local('mapping result.json');
  await writeFile(xmlInput, '<r id="7"><item>PRIVATE XML ONE</item><item>PRIVATE XML TWO</item><empty/></r>'); await remember(xmlInput);
  const xmlJson = await run('abox_xml_json', { input_path: xmlInput, output_path: xmlJsonPath, direction: 'xml-to-json' });
  assert.equal(xmlJson.verified, true); assert.equal(xmlJson.lossy_mapping, true); assert.equal(xmlJson.verification.source_mapping, true); assert.equal(xmlJson.verification.semantic_roundtrip, false);
  assert.deepEqual(JSON.parse(await readFile(xmlJsonPath, 'utf8')), { r: { '@id': '7', item: ['PRIVATE XML ONE', 'PRIVATE XML TWO'], empty: null } });
  privateSummary(xmlJson, ['PRIVATE XML ONE', 'PRIVATE XML TWO']);
  const markdownInput = local('small source.md'), markdownPath = local('small rendered.html');
  await writeFile(markdownInput, '# Local **PRIVATE NOTE**\n\nA [link](https://example.invalid) & <raw>\n'); await remember(markdownInput);
  const markdown = await run('abox_markdown_html', { input_path: markdownInput, output_path: markdownPath }), rendered = await readFile(markdownPath, 'utf8');
  assert.equal(markdown.verified, true); assert.equal(markdown.link_count, 1); assert.equal(markdown.verification.link_destinations, true);
  assert.equal(markdown.verification.browser_rendering, false); assert.ok(rendered.includes('<h1>Local <strong>PRIVATE NOTE</strong></h1>'));
  assert.ok(rendered.includes('&lt;raw&gt;')); assert.ok(rendered.includes("default-src 'none'")); assert.ok(rendered.includes('href="https://example.invalid"'));
  privateSummary(markdown, ['PRIVATE NOTE', 'https://example.invalid']);

  const encoded = async (name, args, expected) => {
    const response = await client.callTool({ name, arguments: args }), block = response.content?.find(item => item.type === 'text');
    assert.ok(block); const result = JSON.parse(block.text); assert.deepEqual(response.structuredContent, result); covered.push(name);
    if (response.isError) {
      assert.equal(result.ok, false); assert.equal(result.error?.code, 'H264_UNAVAILABLE', 'Only explicit native H.264 capability absence may skip successful encoding.');
      await assert.rejects(stat(args.output_path), { code: 'ENOENT' }); capabilityAbsences.push({ name, code: result.error.code }); return;
    }
    assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.verification.geometry, true);
    assert.equal(result.verification.frame_timing, true); assert.equal(result.verification.decoded_frames, expected.frames); assert.equal(result.verification.audio, false);
    assert.equal(result.frame_count, expected.frames); assert.equal(result.duration_seconds, expected.duration);
    const bytes = await readFile(args.output_path), media = await mp4(bytes); assert.equal(media.audio, null); assert.equal(media.video.samples.length, expected.frames);
    assert.equal(media.video.codedWidth, expected.width); assert.equal(media.video.codedHeight, expected.height); assert.equal(media.video.duration / media.video.timescale, expected.duration);
    const colors = await renderedPixels(args.output_path, true); assert.equal(colors.length, expected.frames);
    for (const [index, color] of colors.entries()) {
      const wanted = index < expected.red_frames ? [255, 0, 0] : [0, 0, 255]; assert.equal(color[3], 255);
      for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(color[channel] - wanted[channel]) <= 30, 'Generated smoke video changed source color or frame order.');
    }
  };
  await encoded('abox_images_to_video', { input_paths: [redPath, bluePath], output_path: local('created silent video.mp4'), width: 160, height: 160, fps: 10,
    durations_ms: [200, 300], quality: 'high' }, { frames: 5, red_frames: 2, duration: 0.5, width: 160, height: 160 });
  await encoded('abox_gif_to_mp4', { input_path: gifPath, output_path: local('converted silent GIF.mp4') }, { frames: 2, red_frames: 1, duration: 0.3, width: 64, height: 64 });

  for (const [filename, expected] of sourceHashes) assert.equal(hash(await readFile(filename)), expected, 'A smoke source file was modified.');
  const expected = ['abox_code_read', 'abox_gif_create', 'abox_pdf_protect', 'abox_pdf_unlock', 'abox_audio_edit', 'abox_audio_trim', 'abox_video_inspect',
    'abox_video_trim', 'abox_video_join', 'abox_document_scan', 'abox_id_photo', 'abox_business_profile', 'abox_height_compare', 'abox_receipt_extract',
    'abox_dicom_inspect', 'abox_dicom_render', 'abox_images_to_video', 'abox_gif_to_mp4', 'abox_exif_edit', 'abox_video_rotate', 'abox_video_remux',
    'abox_code_format', 'abox_xml_json', 'abox_markdown_html'].sort();
  assert.deepEqual([...new Set(covered)].sort(), expected);
  return { tools: [...new Set(covered)], capability_absences: capabilityAbsences };
}
