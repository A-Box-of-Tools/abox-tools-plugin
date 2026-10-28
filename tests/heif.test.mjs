import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { admitHeif, hevcSps } from '../src/heif-admission.mjs';
import { BYTES } from '../vendor/abox/tools/heic-to-jpg/src/example-data.js';

const heic = Buffer.from(BYTES, 'base64');
const avif = await readFile(new URL('./fixtures/avif/white_1x1.avif', import.meta.url));
test('an unchanged tiled Apple HEIC and official reduced-still AVIFs pass codec geometry admission', async () => {
  const photo = admitHeif(heic, 'heic');
  assert.equal(photo.coded_items, 48);
  assert.deepEqual(photo.pictures, [{ id: 49, primary: true, width: 4032, height: 3024 }]);
  assert.deepEqual(admitHeif(avif, 'avif').pictures.map(x => [x.width, x.height]), [[1, 1]]);
  const color = await readFile(new URL('./fixtures/avif/colors_sdr_srgb.avif', import.meta.url));
  assert.deepEqual(admitHeif(color, 'avif').pictures.map(x => [x.width, x.height]), [[200, 200]]);
});
test('container extents, item geometry and movie brands cannot substitute for coded-size admission', () => {
  for (const original of [heic, avif]) {
    for (const end of [1, 8, original.length - 1]) assert.throws(() => admitHeif(original.subarray(0, end), original === heic ? 'heic' : 'avif'));
    const bad = Buffer.from(original); const ispe = bad.indexOf('ispe'); bad.writeUInt32BE(1, ispe + 8); bad.writeUInt32BE(2, ispe + 12);
    assert.throws(() => admitHeif(bad, original === heic ? 'heic' : 'avif'), /disagree|subset/);
  }
  const movie = Buffer.from(avif); movie.write('avis', 8); assert.throws(() => admitHeif(movie, 'avif'));
  const external = Buffer.from(heic); const url = external.indexOf('url '); external[url + 7] = 0; assert.throws(() => admitHeif(external, 'heic'));
});
test('changed in-band AV1 headers and truncated sized OBUs fail before native decoding', () => {
  const bad = Buffer.from(avif); const mdat = bad.indexOf('mdat'); bad[mdat + 5] = 127; assert.throws(() => admitHeif(bad, 'avif'));
  const sequence = Buffer.from(avif); sequence[mdat + 8] &= ~8; assert.throws(() => admitHeif(sequence, 'avif'));
});
function sps({ width = 64, height = 64, refs = 1, crop = 0 } = {}) {
  let bits = '';
  const n = (v, size) => { bits += v.toString(2).padStart(size, '0'); };
  const ue = v => { const b = (v + 1).toString(2); bits += '0'.repeat(b.length - 1) + b; };
  n(0, 4); n(0, 3); n(1, 1); n(1, 32); n(0, 32); n(0, 32); ue(0); ue(1); ue(width); ue(height);
  n(crop ? 1 : 0, 1); if (crop) { ue(0); ue(crop); ue(0); ue(crop); }
  ue(0); ue(0); ue(4); n(0, 1); ue(refs - 1); ue(0); ue(0); bits += '1'; bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const raw = Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2))); const escaped = []; let zeros = 0;
  for (const byte of raw) { if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; } escaped.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
  return Buffer.from([0x42, 1, ...escaped]);
}
test('HEVC admission bounds uncropped surfaces and reference multipliers, including tiny visible crops', () => {
  assert.equal(hevcSps(sps()).width, 64);
  assert.equal(hevcSps(sps({ width: 8192, height: 16 })).width, 8192);
  assert.throws(() => hevcSps(sps({ width: 8193 })), /subset|pixels/);
  assert.throws(() => hevcSps(sps({ width: 8192, height: 8192, crop: 4095 })), /pixels/);
  assert.throws(() => hevcSps(sps({ width: 4096, height: 4096, refs: 16 })), /reference-picture/);
  assert.throws(() => hevcSps(sps().subarray(0, 7)));
});

test('combined coded surfaces are counted even when every HEIF item advertises a small conformance crop', () => {
  const box = (name, ...parts) => { const data = Buffer.concat(parts); const head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(name, 4); return Buffer.concat([head, data]); };
  const uint = (value, size = 4) => { const b = Buffer.alloc(size); b.writeUIntBE(value, 0, size); return b; };
  const full = (version = 0) => Buffer.from([version, 0, 0, 0]);
  // Eight 4096-square coded surfaces crop to 512-square visible items. The
  // visible sum is only 2MP, while the actual codec sum exceeds 96MP.
  const sequence = sps({ width: 4096, height: 4096, crop: 1792 });
  const vps = Buffer.from([0x40, 1, 0x0c, 1]), pps = Buffer.from([0x44, 1, 0xc0]);
  const config = Buffer.alloc(23); config[0] = 1; config[21] = 3; config[22] = 3;
  const arrays = [vps, sequence, pps].map((nal, i) => Buffer.concat([Buffer.from([0x80 | 32 + i]), uint(1, 2), uint(nal.length, 2), nal]));
  const ipco = box('ipco', box('ispe', full(), uint(512), uint(512)), box('hvcC', config, ...arrays));
  const entries = [], associations = [], locations = []; const payload = Buffer.from([0, 0, 0, 3, 0x26, 1, 0x80]);
  for (let i = 1; i <= 8; i++) {
    const flags = full(2); flags[3] = i === 1 ? 0 : 1;
    entries.push(box('infe', flags, uint(i, 2), uint(0, 2), Buffer.from('hvc1\0')));
    associations.push(Buffer.concat([uint(i, 2), Buffer.from([2, 1, 2])]));
    locations.push(Buffer.concat([uint(i, 2), uint(0, 2), uint(1, 2), uint(0), uint(payload.length)]));
  }
  const ftyp = box('ftyp', Buffer.from('heic'), uint(0), Buffer.from('mif1heic'));
  const buildMeta = () => box('meta', full(), box('pitm', full(), uint(1, 2)), box('iinf', full(), uint(8, 2), ...entries),
    box('iloc', full(), Buffer.from([0x44, 0]), uint(8, 2), ...locations), box('iprp', ipco, box('ipma', full(), uint(8), ...associations)));
  let meta = buildMeta(); for (const location of locations) location.writeUInt32BE(ftyp.length + meta.length + 8, 6); meta = buildMeta();
  assert.throws(() => admitHeif(Buffer.concat([ftyp, meta, box('mdat', payload)]), 'heic'), /combined uncropped HEVC/);
});
