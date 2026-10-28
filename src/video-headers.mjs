import { AdapterError } from './errors.mjs';

export const MAX_AVC_SIDE = 4096;
export const MAX_AVC_CODED_PIXELS = 4_194_304;
export const MAX_AVC_REFERENCE_FRAMES = 4;
export const MAX_AVC_SAMPLES = 1800;
export const MAX_AVC_SECONDS = 60;
export const MAX_AVC_NALS = 100_000;
export const MAX_AVC_NAL_BYTES = 8 * 2 ** 20;
export const MAX_AVC_PARAMETER_BYTES = 4096;
const refuse = () => { throw new AdapterError('AVC_UNSUPPORTED', 'Decoded video supports complete progressive 8-bit 4:2:0 H.264 with one stable admitted SPS/PPS, ordinary slice pictures and bounded coded dimensions. Unsupported or ambiguous bitstreams are refused before native decoding.'); };
const limit = () => { throw new AdapterError('VIDEO_DECODE_LIMIT', 'The H.264 coded dimensions, reference pictures, sample count, duration or NAL sizes exceed this local decoding policy.'); };
const equal = (one, two) => one.length === two.length && one.every((value, at) => value === two[at]);

// Admission only, following H.264 clauses7.3.2.1/7.3.2.2/7.3.3. This is not a
// replacement decoder. Unsupported tools/profiles are refused rather than
// guessing the offsets of fields that determine native allocation sizes.
function rbsp(nal, expected, prefix = false) {
  if (!nal.length || nal[0] & 0x80 || expected !== undefined && (nal[0] & 31) !== expected) refuse();
  if ((expected === 7 || expected === 8) && !(nal[0] & 0x60)) refuse();
  const maximum = prefix ? Math.min(nal.length, 128) : nal.length;
  if (!prefix && nal.length > MAX_AVC_PARAMETER_BYTES) limit();
  const bytes = []; let zeros = 0;
  for (let at = 1; at < maximum; at++) {
    const value = nal[at];
    if (zeros >= 2) {
      if (value === 3) { if (at + 1 >= nal.length || nal[at + 1] > 3) refuse(); zeros = 0; continue; }
      if (value <= 2) refuse();
    }
    bytes.push(value); zeros = value === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(bytes);
}
class Bits {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  u(width) {
    if (!Number.isInteger(width) || width < 0 || width > 32 || this.at + width > this.bytes.length * 8) refuse();
    let value = 0;
    for (let bit = 0; bit < width; bit++, this.at++) value = value * 2 + ((this.bytes[this.at >>> 3] >>> (7 - (this.at & 7))) & 1);
    return value;
  }
  flag() { return this.u(1); }
  ue(maximum = 0x7fffffff) {
    let zeros = 0;
    while (this.flag() === 0) { if (++zeros > 30) refuse(); }
    const value = 2 ** zeros - 1 + this.u(zeros); if (value > maximum) refuse(); return value;
  }
  se(low = -0x3fffffff, high = 0x3fffffff) {
    const code = this.ue(), value = code & 1 ? (code + 1) / 2 : -code / 2;
    if (value < low || value > high) refuse(); return value;
  }
  more() {
    if (this.at >= this.bytes.length * 8) refuse();
    if (!((this.bytes[this.at >>> 3] >>> (7 - (this.at & 7))) & 1)) return true;
    for (let at = this.at + 1; at < this.bytes.length * 8; at++) if ((this.bytes[at >>> 3] >>> (7 - (at & 7))) & 1) return true;
    return false;
  }
  end() {
    if (this.flag() !== 1) refuse(); while (this.at & 7) if (this.flag()) refuse();
    if (this.at !== this.bytes.length * 8) refuse();
  }
}
function hrd(bits) {
  const count = bits.ue(31); bits.u(4); bits.u(4);
  for (let at = 0; at <= count; at++) { bits.ue(); bits.ue(); bits.flag(); }
  bits.u(5); bits.u(5); bits.u(5); bits.u(5);
}
function vui(bits, references) {
  if (bits.flag()) {
    const aspect = bits.u(8);
    if (aspect === 255) { const width = bits.u(16), height = bits.u(16); if (!width || width !== height) refuse(); }
    else if (![0, 1].includes(aspect)) refuse();
  }
  if (bits.flag()) bits.flag();
  if (bits.flag()) { bits.u(3); bits.flag(); if (bits.flag()) { bits.u(8); bits.u(8); bits.u(8); } }
  if (bits.flag()) { bits.ue(5); bits.ue(5); }
  if (bits.flag()) { const units = bits.u(32), scale = bits.u(32); if (!units || !scale) refuse(); bits.flag(); }
  const nal = bits.flag(); if (nal) hrd(bits);
  const vcl = bits.flag(); if (vcl) hrd(bits);
  if (nal || vcl) bits.flag(); bits.flag();
  if (bits.flag()) {
    bits.flag(); bits.ue(16); bits.ue(16); bits.ue(16); bits.ue(16);
    const reorder = bits.ue(MAX_AVC_REFERENCE_FRAMES), buffered = bits.ue(MAX_AVC_REFERENCE_FRAMES + 2);
    if (buffered < references || reorder > buffered) refuse();
  }
}
export function readAvcSps(nal, { max_side = MAX_AVC_SIDE, max_pixels = MAX_AVC_CODED_PIXELS } = {}) {
  const bits = new Bits(rbsp(nal, 7)), profile = bits.u(8), constraints = bits.u(8), level = bits.u(8), id = bits.ue(31);
  if (![66, 77, 100].includes(profile) || constraints & 3 || !level || level > 52) refuse();
  if (profile === 100) {
    if (bits.ue(3) !== 1 || bits.ue(6) !== 0 || bits.ue(6) !== 0 || bits.flag() || bits.flag()) refuse();
  }
  const frame_num_bits = bits.ue(12) + 4, poc_type = bits.ue(2); let poc_bits = 0;
  if (poc_type === 0) poc_bits = bits.ue(12) + 4; else if (poc_type !== 2) refuse();
  const references = bits.ue(16); if (references > MAX_AVC_REFERENCE_FRAMES) limit();
  const gaps_allowed = Boolean(bits.flag());
  const width_mbs = bits.ue(65535) + 1, height_mbs = bits.ue(65535) + 1;
  if (bits.flag() !== 1) refuse(); bits.flag();
  const coded_width = width_mbs * 16, coded_height = height_mbs * 16;
  if (coded_width > max_side || coded_height > max_side || coded_width * coded_height > max_pixels) limit();
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits.flag()) { left = bits.ue(coded_width); right = bits.ue(coded_width); top = bits.ue(coded_height); bottom = bits.ue(coded_height); }
  const width = coded_width - 2 * (left + right), height = coded_height - 2 * (top + bottom);
  if (width < 1 || height < 1) refuse();
  if (bits.flag()) vui(bits, references); bits.end();
  return { id, profile, constraints, level, frame_num_bits, poc_type, poc_bits, references,
    gaps_allowed, coded_width, coded_height, width, height, width_mbs, height_mbs, macroblocks: width_mbs * height_mbs };
}
function readPps(nal, sps) {
  const bits = new Bits(rbsp(nal, 8)), id = bits.ue(255);
  if (bits.ue(31) !== sps.id) refuse();
  const cabac = bits.flag(), bottom_poc = bits.flag();
  if (cabac && sps.profile === 66 || bits.ue(7) !== 0) refuse();
  bits.ue(3); bits.ue(3); bits.flag(); if (bits.u(2) > 2) refuse();
  bits.se(-26, 25); bits.se(-26, 25); bits.se(-12, 12); bits.flag(); bits.flag(); if (bits.flag()) refuse();
  if (bits.more()) { const transform = bits.flag(); if (transform && sps.profile !== 100 || bits.flag()) refuse(); bits.se(-12, 12); }
  bits.end(); return { id, bottom_poc };
}
export function admitAvcConfiguration(description, limits = {}) {
  const data = new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  if (data.length < 11 || data.length > MAX_AVC_PARAMETER_BYTES * 2 + 32 || data[0] !== 1 || (data[4] & 0xfc) !== 0xfc || (data[5] & 0xe0) !== 0xe0 || (data[5] & 31) !== 1) refuse();
  const length_size = (data[4] & 3) + 1; if (length_size === 3) refuse(); let at = 6;
  const take = () => {
    if (at + 2 > data.length) refuse(); const size = data[at] * 256 + data[at + 1]; at += 2;
    if (!size || size > MAX_AVC_PARAMETER_BYTES || at + size > data.length) refuse();
    const bytes = data.subarray(at, at + size); at += size; return bytes;
  };
  const sps_bytes = take(), sps = readAvcSps(sps_bytes, limits);
  if (data[1] !== sps.profile || data[2] !== sps.constraints || data[3] !== sps.level || data[at++] !== 1) refuse();
  const pps_bytes = take(), pps = readPps(pps_bytes, sps);
  if (at !== data.length) {
    if (sps.profile !== 100 || at + 4 !== data.length || data[at++] !== 0xfd || data[at++] !== 0xf8 || data[at++] !== 0xf8 || data[at++] !== 0) refuse();
  }
  return { sps, pps, sps_bytes, pps_bytes, length_size };
}
function slice(nal, configuration) {
  const bits = new Bits(rbsp(nal, undefined, true)), type = nal[0] & 31, first = bits.ue(configuration.sps.macroblocks - 1), sliceType = bits.ue(9);
  if (![0, 1, 2].includes(sliceType % 5) || bits.ue(255) !== configuration.pps.id) refuse();
  const frame = bits.u(configuration.sps.frame_num_bits), idr = type === 5 ? bits.ue(65535) : null;
  let poc = null, delta = null;
  if (configuration.sps.poc_type === 0) { poc = bits.u(configuration.sps.poc_bits); if (configuration.pps.bottom_poc) delta = bits.se(); }
  return { first, picture: JSON.stringify([type, frame, idr, poc, delta]) };
}
function singleLayerPrefix(nal) {
  // Some native AVC encoders emit the AnnexG prefix ahead of ordinary base
  // slices. Admit its finite single-layer form, never MVC or SVC slice data.
  if (nal.length !== 5) refuse();
  const bits = new Bits(nal.subarray(1, 4));
  if (bits.flag() !== 1) refuse(); const idr = Boolean(bits.flag()); bits.u(6);
  if (bits.flag() !== 1 || bits.u(3) !== 0 || bits.u(4) !== 0) refuse();
  const temporal = bits.u(3); if (idr && temporal || bits.flag()) refuse(); bits.flag();
  if (bits.flag() !== 1 || bits.u(2) !== 3 || nal[4] !== (nal[0] & 0x60 ? 0x20 : 0x80)) refuse();
  return { idr, ref_idc: nal[0] & 0x60 };
}
export function admitAvcTrack(bytes, video, { max_side = MAX_AVC_SIDE, max_pixels = MAX_AVC_CODED_PIXELS,
  max_samples = MAX_AVC_SAMPLES, max_seconds = MAX_AVC_SECONDS } = {}) {
  if (!['avc1', 'avc3'].includes(video.entryType) || !video.description || !Array.isArray(video.samples) || !video.samples.length) refuse();
  if (video.samples.length > max_samples || !(video.timescale > 0) || !(video.duration > 0) || video.duration / video.timescale > max_seconds) limit();
  const configuration = admitAvcConfiguration(video.description, { max_side, max_pixels });
  if (video.codedWidth !== configuration.sps.width || video.codedHeight !== configuration.sps.height) refuse();
  let count = 0, previousDts = -1;
  for (const sample of video.samples) {
    if (sample.size > MAX_AVC_NAL_BYTES) limit();
    if (![sample.offset, sample.size, sample.dts, sample.pts].every(Number.isSafeInteger) || sample.offset < 0 || sample.size < 1 || sample.offset + sample.size > bytes.length || sample.dts <= previousDts) refuse();
    previousDts = sample.dts; let at = sample.offset, firstMb = -1, picture = null, slices = 0, prefix = null;
    while (at < sample.offset + sample.size) {
      if (++count > MAX_AVC_NALS) limit();
      if (at + configuration.length_size > sample.offset + sample.size) refuse();
      let length = 0; for (let byte = 0; byte < configuration.length_size; byte++) length = length * 256 + bytes[at++];
      if (!length || length > MAX_AVC_NAL_BYTES) limit();
      if (at + length > sample.offset + sample.size) refuse();
      const nal = bytes.subarray(at, at + length), type = nal[0] & 31; at += length;
      if (nal[0] & 0x80 || ![1, 5, 6, 7, 8, 9, 10, 11, 12, 14].includes(type) || prefix && type !== 1 && type !== 5) refuse();
      if (type === 14) { prefix = singleLayerPrefix(nal); continue; }
      if (type === 7 || type === 8) { if (!equal(nal, type === 7 ? configuration.sps_bytes : configuration.pps_bytes)) refuse(); }
      else if (type === 1 || type === 5) {
        const header = slice(nal, configuration);
        if (!slices && header.first !== 0 || header.first <= firstMb || picture !== null && picture !== header.picture || Boolean(sample.isKey) !== (type === 5)
            || prefix && (prefix.idr !== (type === 5) || prefix.ref_idc !== (nal[0] & 0x60))) refuse();
        prefix = null;
        firstMb = header.first; picture = header.picture; slices++;
      }
    }
    if (!slices || prefix) refuse();
  }
  // Native surfaces can include driver padding outside the SPS picture (the
  // Windows decoder adds two rows). Only a small fixed alignment allowance is
  // accepted; the visible rectangle must still match the admitted SPS exactly.
  return { admitted: true, profile: configuration.sps.profile, level: configuration.sps.level, length_size: configuration.length_size,
    coded_width: configuration.sps.coded_width, coded_height: configuration.sps.coded_height, width: configuration.sps.width,
    height: configuration.sps.height,
    native_max_width: Math.ceil((configuration.sps.coded_width + 16) / 64) * 64,
    native_max_height: Math.ceil((configuration.sps.coded_height + 16) / 64) * 64,
    reference_frames: configuration.sps.references, samples_checked: video.samples.length, nals_checked: count };
}
