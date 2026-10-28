import { AdapterError } from './errors.mjs';

export const MAX_HEIF_BYTES = 64 * 1024 * 1024;
export const MAX_HEIF_PIXELS = 32_000_000;
export const MAX_HEIF_SIDE = 8192;
export const MAX_HEIF_ITEMS = 256;
export const MAX_HEIF_TOTAL_PIXELS = 96_000_000;
const refuse = (message = 'This HEIF container is outside the supported still-image subset.') => { throw new AdapterError('UNSUPPORTED_HEIF', message); };
const geometry = (width, height) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_HEIF_SIDE || height > MAX_HEIF_SIDE || width * height > MAX_HEIF_PIXELS) refuse('HEIF coded and display images must fit 8192 pixels per side and 32 megapixels.');
  return { width, height };
};

class Cursor {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  n(count) { if (![0, 1, 2, 3, 4, 8].includes(count) || this.p + count > this.b.length) refuse(); let n = 0; for (let i = 0; i < count; i++) n = n * 256 + this.b[this.p++]; if (!Number.isSafeInteger(n)) refuse(); return n; }
  skip(count) { if (this.p + count > this.b.length) refuse(); this.p += count; }
  text(count) { const p = this.p; this.skip(count); return String.fromCharCode(...this.b.subarray(p, p + count)); }
  end() { if (this.p !== this.b.length) refuse(); }
}
class Bits {
  constructor(b) { this.b = b; this.p = 0; }
  n(count) { if (count < 0 || count > 32 || this.p + count > this.b.length * 8) refuse(); let value = 0; for (let i = 0; i < count; i++, this.p++) value = value * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); return value; }
  skip(count) { while (count > 0) { const n = Math.min(32, count); this.n(n); count -= n; } }
  ue(max = 1_000_000) { let zeros = 0; while (!this.n(1)) if (++zeros > 30) refuse(); const n = 2 ** zeros - 1 + this.n(zeros); if (n > max) refuse(); return n; }
}
function boxes(bytes) {
  const out = []; const c = new Cursor(bytes);
  while (c.p < bytes.length) {
    if (out.length >= 4096) refuse();
    const at = c.p; let size = c.n(4); const type = c.text(4); if (size === 1) size = c.n(8); else if (!size) size = bytes.length - at;
    if (size < c.p - at || size > bytes.length - at) refuse();
    out.push({ type, data: bytes.subarray(c.p, at + size), start: c.p, end: at + size }); c.p = at + size;
  }
  return out;
}
function one(list, name, required = true) { const found = list.filter(x => x.type === name); if (found.length > 1 || (required && found.length !== 1)) refuse(); return found[0]; }
function full(bytes, versions = [0]) { const c = new Cursor(bytes); const version = c.n(1); const flags = c.n(3); if (!versions.includes(version)) refuse(); return { c, version, flags }; }
function rbsp(nal) {
  const out = []; let zeros = 0;
  for (const byte of nal.subarray(2)) { if (zeros >= 2 && byte === 3) { zeros = 0; continue; } out.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
  return Uint8Array.from(out);
}
function nalType(nal) { if (nal.length < 3 || nal[0] & 0x80 || ((nal[0] & 1) << 5 | nal[1] >> 3) !== 0 || (nal[1] & 7) !== 1) refuse('Only single-layer HEVC still pictures are admitted.'); return nal[0] >> 1 & 63; }

/** SPS dimensions bound the decoder itself; the container's ispe is not trusted. */
export function hevcSps(nal) {
  if (nalType(nal) !== 33 || nal.length > 64 * 1024) refuse();
  const b = new Bits(rbsp(nal)); b.n(4); const sub = b.n(3); b.n(1); if (sub > 6) refuse();
  b.skip(96); const flags = []; for (let i = 0; i < sub; i++) flags.push([b.n(1), b.n(1)]);
  if (sub) for (let i = sub; i < 8; i++) if (b.n(2)) refuse();
  for (const [profile, level] of flags) { if (profile) b.skip(88); if (level) b.skip(8); }
  b.ue(15); const chroma = b.ue(3); if (chroma === 3 && b.n(1)) refuse();
  const coded = geometry(b.ue(MAX_HEIF_SIDE), b.ue(MAX_HEIF_SIDE));
  let left = 0, right = 0, top = 0, bottom = 0;
  if (b.n(1)) { left = b.ue(MAX_HEIF_SIDE); right = b.ue(MAX_HEIF_SIDE); top = b.ue(MAX_HEIF_SIDE); bottom = b.ue(MAX_HEIF_SIDE); }
  const depth = b.ue(2) + 8; if (b.ue(2) + 8 !== depth) refuse(); b.ue(12);
  const ordering = b.n(1); let maxDpb = 0;
  for (let i = ordering ? 0 : sub; i <= sub; i++) { const dpb = b.ue(15) + 1; if (b.ue(15) >= dpb) refuse(); b.ue(); maxDpb = Math.max(maxDpb, dpb); }
  // A reference-picture count is a multiplier on coded geometry, even for a
  // nominally still item. Keep its declared surface budget explicit.
  if (coded.width * coded.height * maxDpb > 128_000_000) refuse('The HEVC reference-picture surface budget is too large.');
  const sx = chroma === 1 || chroma === 2 ? 2 : 1; const sy = chroma === 1 ? 2 : 1;
  const visible = geometry(coded.width - (left + right) * sx, coded.height - (top + bottom) * sy);
  return { ...coded, visible_width: visible.width, visible_height: visible.height, bit_depth: depth, max_references: maxDpb };
}
function hevcConfig(data) {
  const c = new Cursor(data); if (c.n(1) !== 1 || data.length < 23) refuse(); c.skip(20); const length = (c.n(1) & 3) + 1; if (length !== 4) refuse();
  const count = c.n(1); if (count > 16) refuse(); const sets = new Map(); let shape;
  for (let i = 0; i < count; i++) {
    const type = c.n(1) & 63; const n = c.n(2); if (![32, 33, 34, 39, 40].includes(type) || n > 16) refuse();
    for (let j = 0; j < n; j++) { const size = c.n(2); const p = c.p; c.skip(size); const nal = data.subarray(p, p + size); if (nalType(nal) !== type) refuse();
      if (type === 32) { const b = new Bits(rbsp(nal)); b.n(4); b.n(2); if (b.n(6) !== 0) refuse(); }
      if (type === 33) { const next = hevcSps(nal); if (shape && JSON.stringify(shape) !== JSON.stringify(next)) refuse(); shape = next; }
      if ([32, 33, 34].includes(type)) { const existing = sets.get(type); if (existing && !Buffer.from(existing).equals(nal)) refuse(); sets.set(type, nal); }
    }
  }
  c.end(); if (!shape || !sets.has(32) || !sets.has(34)) refuse(); return { shape, sets };
}
function hevcItem(data, config) {
  const c = new Cursor(data); let count = 0, slices = 0, pictures = 0;
  while (c.p < data.length) {
    if (++count > 4096) refuse(); const size = c.n(4); const at = c.p; c.skip(size); const nal = data.subarray(at, at + size); const type = nalType(nal);
    if ([32, 33, 34].includes(type)) { if (!Buffer.from(config.sets.get(type) ?? []).equals(nal)) refuse('In-band HEVC parameter-set changes are refused.'); }
    else if (type <= 31) { if (![19, 20, 21].includes(type)) refuse('Only independently coded HEVC still items are supported.'); if (++slices > 1024) refuse(); if (nal[2] & 128) pictures++; }
    else if (![35, 36, 37, 38, 39, 40].includes(type)) refuse();
  }
  if (!slices || pictures !== 1) refuse('Each HEVC still item must contain exactly one coded picture.');
}
function av1Sequence(data) {
  const b = new Bits(data); const profile = b.n(3); if (profile > 2 || !b.n(1) || !b.n(1)) refuse('AVIF currently requires a reduced still-picture AV1 sequence header.');
  b.n(5); const wb = b.n(4) + 1, hb = b.n(4) + 1; const size = geometry(b.n(wb) + 1, b.n(hb) + 1);
  b.skip(3); const superres = b.n(1); b.skip(2); const high = b.n(1); const depth = profile === 2 && high ? (b.n(1) ? 12 : 10) : high ? 10 : 8;
  const mono = profile !== 1 && b.n(1); let cp = 2, tc = 2, mc = 2;
  if (b.n(1)) { cp = b.n(8); tc = b.n(8); mc = b.n(8); }
  if (mono) b.n(1);
  else { let sx, sy; if (cp === 1 && tc === 13 && mc === 0) { sx = sy = 0; } else { b.n(1); if (profile === 0) sx = sy = 1; else if (profile === 1) sx = sy = 0; else if (depth === 12) { sx = b.n(1); sy = sx ? b.n(1) : 0; } else { sx = 1; sy = 0; } if (sx && sy) b.n(2); } b.n(1); }
  b.n(1); if (!b.n(1)) refuse(); while (b.p < data.length * 8) if (b.n(1)) refuse();
  return { ...size, bit_depth: depth, superres };
}
function av1Obus(data, config, isConfig = false) {
  const c = new Cursor(data); let sequence = config?.sequence, sequenceBytes = config?.sequenceBytes, frameCount = 0, count = 0;
  while (c.p < data.length) {
    if (++count > 4096) refuse();
    const head = c.n(1); if (head & 0x81 || head & 4 || !(head & 2)) refuse(); const type = head >> 3 & 15;
    let size = 0, shift = 0, byte; do { if (shift >= 35) refuse(); byte = c.n(1); size += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    const at = c.p; c.skip(size); const payload = data.subarray(at, at + size);
    if (type === 1) { const s = av1Sequence(payload); if (sequenceBytes && !Buffer.from(sequenceBytes).equals(payload)) refuse('AV1 sequence-header changes are refused.'); sequence = s; sequenceBytes = payload; }
    else if (type === 6) {
      if (isConfig || !sequence || ++frameCount > 1) refuse();
      // Reduced still headers cannot override coded dimensions. Render size is
      // parsed separately because a decoder may expose it as display geometry.
      const b = new Bits(payload); b.n(1); const screen = b.n(1); if (screen) b.n(1);
      if (sequence.superres && b.n(1)) b.n(3);
      if (b.n(1)) { const render = geometry(b.n(16) + 1, b.n(16) + 1); if (render.width !== sequence.width || render.height !== sequence.height) refuse('AVIF render geometry must agree with its coded still extent.'); }
    } else if (type === 2) { if (size || isConfig) refuse(); }
    else if (type === 15) { if (size > 65536) refuse(); }
    else refuse('Only complete single-frame AV1 OBUs and sequence headers are admitted.');
  }
  if ((!isConfig && !sequence) || (!isConfig && frameCount !== 1)) refuse(); return { sequence, sequenceBytes };
}

/** Full item/extent/codec walk runs before handing any file bytes to a decoder. */
export function admitHeif(input, codec) {
  const bytes = Buffer.from(input); if (!bytes.length || bytes.length > MAX_HEIF_BYTES || !['heic', 'avif'].includes(codec)) refuse();
  const top = boxes(bytes); if (top.some(x => !['ftyp', 'meta', 'mdat', 'free', 'skip'].includes(x.type))) refuse('Only still HEIF containers without movie tracks are supported.');
  const ftyp = one(top, 'ftyp').data; if (ftyp.length < 12 || ftyp.length % 4) refuse(); const brands = [ftyp.toString('ascii', 0, 4)]; for (let p = 8; p < ftyp.length; p += 4) brands.push(ftyp.toString('ascii', p, p + 4));
  if (brands.includes('avis') || (codec === 'avif' ? !brands.includes('avif') : brands.includes('avif') || !brands.some(x => ['heic', 'heix', 'mif1'].includes(x)))) refuse();
  const m = one(top, 'meta'); const { c: mc, flags: mf } = full(m.data); if (mf) refuse(); const children = boxes(m.data.subarray(mc.p));
  if (children.some(x => !['hdlr', 'pitm', 'iinf', 'iloc', 'iprp', 'iref', 'idat', 'free', 'dinf'].includes(x.type))) refuse();
  const dinf = one(children, 'dinf', false);
  if (dinf) { const ref = full(one(boxes(dinf.data), 'dref').data); if (ref.flags || ref.c.n(4) !== 1) refuse(); const url = one(boxes(ref.c.b.subarray(ref.c.p)), 'url '); const u = full(url.data); if (u.flags !== 1) refuse(); u.c.end(); }
  const primaryBox = full(one(children, 'pitm').data, [0, 1]); if (primaryBox.flags) refuse(); const primary = primaryBox.c.n(primaryBox.version ? 4 : 2); primaryBox.c.end();
  const inf = full(one(children, 'iinf').data, [0, 1]); const itemCount = inf.c.n(inf.version ? 4 : 2); if (!itemCount || itemCount > MAX_HEIF_ITEMS || inf.flags) refuse();
  const entries = boxes(inf.c.b.subarray(inf.c.p)); if (entries.length !== itemCount || entries.some(x => x.type !== 'infe')) refuse(); const items = new Map();
  for (const entry of entries) { const { c, version, flags } = full(entry.data, [2, 3]); const id = c.n(version === 2 ? 2 : 4); if (!id || items.has(id) || c.n(2) || flags > 1) refuse(); const type = c.text(4); if (![codec === 'heic' ? 'hvc1' : 'av01', 'grid', 'Exif', 'mime'].includes(type)) refuse(); items.set(id, { id, type, hidden: Boolean(flags & 1), props: [] }); }
  if (!items.has(primary)) refuse();
  const loc = full(one(children, 'iloc').data, [0, 1, 2]); if (loc.flags) refuse(); const first = loc.c.n(1), second = loc.c.n(1); const ow = first >> 4, lw = first & 15, bw = second >> 4, iw = loc.version ? second & 15 : 0;
  if (![0, 4, 8].includes(ow) || ![4, 8].includes(lw) || ![0, 4, 8].includes(bw) || iw) refuse(); const locations = loc.c.n(loc.version === 2 ? 4 : 2); if (locations !== itemCount) refuse();
  const mdats = top.filter(x => x.type === 'mdat'); const idat = one(children, 'idat', false); let aggregateBytes = 0;
  for (let i = 0; i < locations; i++) {
    const id = loc.c.n(loc.version === 2 ? 4 : 2); const item = items.get(id); if (!item || item.payload) refuse(); const construction = loc.version ? loc.c.n(2) : 0; if (construction > 1 || loc.c.n(2)) refuse(); const base = loc.c.n(bw), count = loc.c.n(2); if (!count || count > 16) refuse(); const parts = [];
    for (let j = 0; j < count; j++) { const offset = base + loc.c.n(ow), length = loc.c.n(lw); if (!length || !Number.isSafeInteger(offset + length)) refuse();
      if (construction === 1) { if (!idat || offset + length > idat.data.length) refuse(); parts.push(idat.data.subarray(offset, offset + length)); }
      else { if (!mdats.some(x => offset >= x.start && offset + length <= x.end)) refuse(); parts.push(bytes.subarray(offset, offset + length)); }
      aggregateBytes += length; if (aggregateBytes > MAX_HEIF_BYTES) refuse();
    }
    item.payload = Buffer.concat(parts);
  }
  loc.c.end();
  const prp = boxes(one(children, 'iprp').data); const properties = boxes(one(prp, 'ipco').data); if (properties.length > 1024 || prp.some(x => !['ipco', 'ipma'].includes(x.type))) refuse();
  for (const x of properties) if (!['ispe', 'hvcC', 'av1C', 'pixi', 'clap', 'irot', 'imir', 'colr', 'auxC'].includes(x.type)) refuse();
  const pma = full(one(prp, 'ipma').data, [0, 1]); if (pma.flags > 1) refuse(); const associations = pma.c.n(4); if (associations > itemCount) refuse(); const seenAssociations = new Set();
  for (let i = 0; i < associations; i++) { const id = pma.c.n(pma.version ? 4 : 2); const item = items.get(id); const count = pma.c.n(1); if (!item || seenAssociations.has(id) || count > 32) refuse(); seenAssociations.add(id);
    for (let j = 0; j < count; j++) { const index = pma.c.n(pma.flags ? 2 : 1) & (pma.flags ? 32767 : 127); if (!index || index > properties.length || item.props.includes(properties[index - 1])) refuse(); item.props.push(properties[index - 1]); }
  }
  pma.c.end();
  const references = new Map(); const auxiliary = new Set(); const derived = new Set(); const ref = one(children, 'iref', false);
  if (ref) { const r = full(ref.data, [0, 1]); if (r.flags) refuse(); for (const box of boxes(r.c.b.subarray(r.c.p))) { if (!['dimg', 'thmb', 'auxl', 'cdsc'].includes(box.type)) refuse(); const c = new Cursor(box.data); const from = c.n(r.version ? 4 : 2), count = c.n(2); if (!items.has(from) || !count || count > MAX_HEIF_ITEMS) refuse(); const targets = []; for (let j = 0; j < count; j++) { const target = c.n(r.version ? 4 : 2); if (!items.has(target) || target === from) refuse(); targets.push(target); } c.end();
      if (box.type === 'dimg') { if (references.has(from)) refuse(); references.set(from, targets); for (const id of targets) derived.add(id); } else if (box.type === 'thmb' || box.type === 'auxl') auxiliary.add(from);
    } }
  let totalPixels = 0, codedPixels = 0, referencePixels = 0, codedItems = 0;
  for (const item of items.values()) {
    if (['Exif', 'mime'].includes(item.type)) { if (item.payload.length > 2 * 1024 * 1024) refuse(); continue; }
    const s = full(one(item.props, 'ispe').data); if (s.flags) refuse(); item.size = geometry(s.c.n(4), s.c.n(4)); s.c.end(); totalPixels += item.size.width * item.size.height; if (totalPixels > MAX_HEIF_TOTAL_PIXELS) refuse('The combined HEIF image and tile surface budget exceeds 96 megapixels.');
    for (const p of item.props) { const c = new Cursor(p.data);
      if (p.type === 'irot') { const turn = c.n(1); if (turn > 3) refuse(); if (turn & 1) item.rotated = !item.rotated; c.end(); }
      if (p.type === 'imir') { if (c.n(1) > 1) refuse(); c.end(); }
      if (p.type === 'clap') { if (p.data.length !== 32) refuse(); const wn = c.n(4), wd = c.n(4), hn = c.n(4), hd = c.n(4), ox = c.n(4), od = c.n(4), oy = c.n(4), oed = c.n(4); if (!wd || !hd || !od || !oed || wn / wd !== item.size.width || hn / hd !== item.size.height || ox || oy) refuse('Nonidentity HEIF clean-aperture crops are not admitted.'); }
      if (p.type === 'colr' && p.data.length > 1024 * 1024) refuse();
      if (p.type === 'pixi') { const q = full(p.data); const n = q.c.n(1); if (q.flags || n < 1 || n > 4) refuse(); for (let j = 0; j < n; j++) if (![8, 10, 12].includes(q.c.n(1))) refuse(); q.c.end(); }
    }
    if (item.type === 'grid') continue;
    codedItems++;
    if (codec === 'heic') { const config = hevcConfig(one(item.props, 'hvcC').data); if (config.shape.visible_width !== item.size.width || config.shape.visible_height !== item.size.height) refuse('HEVC coded geometry and the HEIF item extent disagree.');
      codedPixels += config.shape.width * config.shape.height; referencePixels += config.shape.width * config.shape.height * config.shape.max_references;
      if (codedPixels > MAX_HEIF_TOTAL_PIXELS || referencePixels > 128_000_000) refuse('The combined uncropped HEVC coded/reference surface budget is too large.');
      hevcItem(item.payload, config); }
    else { const config = one(item.props, 'av1C').data; if (config.length < 4 || config[0] !== 0x81) refuse(); const state = av1Obus(item.payload, av1Obus(config.subarray(4), null, true)); if (state.sequence.width !== item.size.width || state.sequence.height !== item.size.height) refuse('AV1 sequence geometry and the AVIF item extent disagree.'); }
  }
  for (const item of items.values()) if (item.type === 'grid') {
    const c = new Cursor(item.payload); if (c.n(1) !== 0) refuse(); const flags = c.n(1); if (flags > 1) refuse(); const rows = c.n(1) + 1, cols = c.n(1) + 1; const size = geometry(c.n(flags ? 4 : 2), c.n(flags ? 4 : 2)); c.end(); const tiles = references.get(item.id);
    if (!tiles || rows * cols !== tiles.length || rows * cols > MAX_HEIF_ITEMS || size.width !== item.size.width || size.height !== item.size.height) refuse();
    const first = items.get(tiles[0]); if (!first.size || first.type === 'grid') refuse();
    for (const id of tiles) { const tile = items.get(id); if (tile.type !== first.type || !tile.size || tile.rotated || tile.size.width !== first.size.width || tile.size.height !== first.size.height) refuse(); }
    if ((cols - 1) * first.size.width >= size.width || cols * first.size.width < size.width || (rows - 1) * first.size.height >= size.height || rows * first.size.height < size.height) refuse();
  }
  for (const id of references.keys()) if (items.get(id).type !== 'grid') refuse();
  const pictures = [...items.values()].filter(x => x.size && !x.hidden && !auxiliary.has(x.id) && !derived.has(x.id));
  if (!pictures.length || pictures.length > 16 || !pictures.some(x => x.id === primary)) refuse();
  return { codec, primary, coded_items: codedItems, total_pixels: totalPixels, coded_pixels: codec === 'heic' ? codedPixels : totalPixels, reference_pixels: codec === 'heic' ? referencePixels : null, pictures: pictures.map(x => ({ id: x.id, primary: x.id === primary, width: x.rotated ? x.size.height : x.size.width, height: x.rotated ? x.size.width : x.size.height })) };
}
