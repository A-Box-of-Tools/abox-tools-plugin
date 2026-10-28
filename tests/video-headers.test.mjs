import assert from 'node:assert/strict';
import test from 'node:test';
import { admitAvcConfiguration, admitAvcTrack, readAvcSps } from '../src/video-headers.mjs';

class Writer {
  bits = [];
  u(value, width = 1) { for (let bit = width - 1; bit >= 0; bit--) this.bits.push(Math.floor(value / 2 ** bit) & 1); return this; }
  ue(value) { const code = value + 1, width = Math.floor(Math.log2(code)); this.u(0, width); this.u(code, width + 1); return this; }
  se(value) { return this.ue(value <= 0 ? -value * 2 : value * 2 - 1); }
  nal(header) {
    this.u(1); while (this.bits.length % 8) this.u(0);
    const raw = []; for (let at = 0; at < this.bits.length; at += 8) raw.push(this.bits.slice(at, at + 8).reduce((value, bit) => value * 2 + bit, 0));
    const escaped = [header]; let zeros = 0;
    for (const byte of raw) { if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; } escaped.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
    return Buffer.from(escaped);
  }
}
function sps({ width = 16, height = 16, profile = 66, references = 1, progressive = true, chroma = 1, crop = null, gaps = false } = {}) {
  const bits = new Writer().u(profile, 8).u(0, 8).u(31, 8).ue(0);
  if (profile === 100) bits.ue(chroma).ue(0).ue(0).u(0).u(0);
  bits.ue(0).ue(0).ue(0).ue(references).u(gaps ? 1 : 0).ue(width / 16 - 1).ue(height / 16 - 1).u(progressive ? 1 : 0).u(1).u(crop ? 1 : 0);
  if (crop) crop.forEach(value => bits.ue(value)); bits.u(0); return bits.nal(0x67);
}
function pps({ id = 0 } = {}) { return new Writer().ue(id).ue(0).u(0).u(0).ue(0).ue(0).ue(0).u(0).u(0, 2).se(0).se(0).se(0).u(1).u(0).u(0).nal(0x68); }
function vcl({ key = true, first = 0, frame = 0, ppsId = 0 } = {}) {
  const bits = new Writer().ue(first).ue(key ? 2 : 0).ue(ppsId).u(frame, 4); if (key) bits.ue(0); return bits.u(frame, 4).nal(key ? 0x65 : 0x41);
}
function configuration(sequence = sps(), picture = pps()) {
  const header = Buffer.from([1, sequence[1], sequence[2], sequence[3], 255, 225, sequence.length >>> 8, sequence.length & 255]);
  return Buffer.concat([header, sequence, Buffer.from([1, picture.length >>> 8, picture.length & 255]), picture]);
}
const packet = nal => { const size = Buffer.alloc(4); size.writeUInt32BE(nal.length); return Buffer.concat([size, nal]); };
function fixture({ sequence = sps(), width = 16, height = 16, nals = [vcl()] } = {}) {
  const bytes = Buffer.concat(nals.map(packet));
  return { bytes, video: { entryType: 'avc1', description: configuration(sequence), codedWidth: width, codedHeight: height,
    timescale: 1000, duration: 1000, samples: [{ offset: 0, size: bytes.length, dts: 0, pts: 0, isKey: true }] } };
}

test('AVC SPS gate derives macroblock allocation independently of container visible dimensions', () => {
  for (const profile of [66, 77, 100]) {
    const info = readAvcSps(sps({ width: 1920, height: 1088, crop: [0, 0, 0, 4], profile }));
    assert.deepEqual([info.coded_width, info.coded_height, info.width, info.height], [1920, 1088, 1920, 1080]);
    assert.equal(info.references, 1); assert.equal(info.frame_num_bits, 4); assert.equal(info.poc_bits, 4);
    const parsed = admitAvcConfiguration(configuration(sps({ profile }))); assert.equal(parsed.sps.profile, profile); assert.equal(parsed.pps.id, 0);
  }
  assert.throws(() => readAvcSps(sps({ width: 4096, height: 4096, crop: [0, 2040, 0, 2040] })), { code: 'VIDEO_DECODE_LIMIT' });
  assert.throws(() => readAvcSps(sps({ references: 5 })), { code: 'VIDEO_DECODE_LIMIT' });
  assert.throws(() => readAvcSps(sps({ progressive: false })), { code: 'AVC_UNSUPPORTED' });
  assert.throws(() => readAvcSps(sps({ profile: 100, chroma: 3 })), { code: 'AVC_UNSUPPORTED' });
  assert.equal(readAvcSps(sps({ gaps: true })).gaps_allowed, true);
});

test('every sample NAL is inspected; stable inband SPS/PPS are accepted and changed or extension headers are refused', () => {
  const good = fixture({ nals: [sps(), pps(), Buffer.from([9, 0xf0]), vcl()] }), result = admitAvcTrack(good.bytes, good.video);
  assert.equal(result.admitted, true); assert.equal(result.samples_checked, 1); assert.equal(result.nals_checked, 4); assert.equal(result.coded_width, 16);
  for (const nals of [[sps({ width: 32 }), vcl()], [pps({ id: 1 }), vcl()], [Buffer.from([0x6f, 0x80]), vcl()], [vcl({ ppsId: 1 })],
    [vcl({ first: 1 })], [vcl(), vcl({ frame: 1 })], [Buffer.from([0x85, 0x80])]]) {
    const bad = fixture({ nals }); assert.throws(() => admitAvcTrack(bad.bytes, bad.video), { code: 'AVC_UNSUPPORTED' });
  }
  const wrongGeometry = fixture({ width: 32 }); assert.throws(() => admitAvcTrack(wrongGeometry.bytes, wrongGeometry.video), { code: 'AVC_UNSUPPORTED' });
  const falseSync = fixture(); falseSync.video.samples[0].isKey = false; assert.throws(() => admitAvcTrack(falseSync.bytes, falseSync.video), { code: 'AVC_UNSUPPORTED' });
  const prefix = Buffer.from([0x6e, 0xc0, 0x80, 0x0f, 0x20]), singleLayer = fixture({ nals: [prefix, vcl()] });
  assert.equal(admitAvcTrack(singleLayer.bytes, singleLayer.video).nals_checked, 2);
  for (const badPrefix of [Buffer.from([0x6e, 0x40, 0x80, 0x0f, 0x20]), Buffer.from([0x6e, 0xc0, 0x90, 0x0f, 0x20]),
    Buffer.from([0x6e, 0xc0, 0x81, 0x0f, 0x20]), Buffer.from([0x6e, 0xc0, 0x80, 0x1f, 0x20]), Buffer.from([0x6e, 0xc0, 0x80, 0x0f, 0x60])]) {
    const bad = fixture({ nals: [badPrefix, vcl()] }); assert.throws(() => admitAvcTrack(bad.bytes, bad.video), { code: 'AVC_UNSUPPORTED' });
  }
  const mismatch = fixture({ nals: [Buffer.from([0x4e, 0x80, 0x80, 0x0f, 0x20]), vcl()] });
  assert.throws(() => admitAvcTrack(mismatch.bytes, mismatch.video), { code: 'AVC_UNSUPPORTED' });
});

test('NAL framing, configuration lengths, trailing SPS bits and slice allocation prefixes fail closed', () => {
  const good = fixture();
  for (const bytes of [good.bytes.subarray(0, -1), Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0])]) {
    const video = { ...good.video, samples: [{ ...good.video.samples[0], size: bytes.length }] };
    assert.throws(() => admitAvcTrack(bytes, video), error => ['AVC_UNSUPPORTED', 'VIDEO_DECODE_LIMIT'].includes(error.code));
  }
  const badLength = configuration(); badLength[7] = 255; assert.throws(() => admitAvcConfiguration(badLength), { code: 'AVC_UNSUPPORTED' });
  const badLengthSize = configuration(); badLengthSize[4] = 254; assert.throws(() => admitAvcConfiguration(badLengthSize), { code: 'AVC_UNSUPPORTED' });
  assert.throws(() => readAvcSps(Buffer.concat([sps(), Buffer.from([1])])), { code: 'AVC_UNSUPPORTED' });
  assert.throws(() => readAvcSps(Buffer.from([0x67, 66, 0, 31, 0, 0, 0])), { code: 'AVC_UNSUPPORTED' });
  const delta = fixture({ nals: [vcl({ key: false })] }); assert.throws(() => admitAvcTrack(delta.bytes, delta.video), { code: 'AVC_UNSUPPORTED' });
});

test('track count, timeline and NAL complexity budgets precede native decode', () => {
  const good = fixture();
  assert.throws(() => admitAvcTrack(good.bytes, { ...good.video, duration: 61000 }), { code: 'VIDEO_DECODE_LIMIT' });
  assert.throws(() => admitAvcTrack(good.bytes, { ...good.video, samples: Array(1801).fill(good.video.samples[0]) }), { code: 'VIDEO_DECODE_LIMIT' });
  const many = fixture({ nals: [...Array(100001).fill(Buffer.from([9, 0xf0])), vcl()] });
  assert.throws(() => admitAvcTrack(many.bytes, many.video), { code: 'VIDEO_DECODE_LIMIT' });
});
