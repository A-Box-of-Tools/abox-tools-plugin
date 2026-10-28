import { AdapterError } from './errors.mjs';

export function invalidLosslessJpeg() {
  throw new AdapterError('DICOM_JPEG_UNSUPPORTED', 'JPEG lossless requires one complete bounded SOF3 frame and interleaved scan, matching DICOM geometry/precision, supported DC tables, no restart intervals, and exact entropy completion. No output was written.');
}
const bad = invalidLosslessJpeg;
const u16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];

function huffman(counts, symbols) {
  const low = new Int32Array(17).fill(-1), high = new Int32Array(17).fill(-1), start = new Uint16Array(17);
  let code = 0, index = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1];
    if (code + count > 2 ** length || count && code + count - 1 === 2 ** length - 1) bad();
    if (count) { low[length] = code; high[length] = code + count - 1; start[length] = index; }
    index += count; code = (code + count) * 2;
  }
  if (!index || index > 17 || symbols.length !== index || new Set(symbols).size !== symbols.length || symbols.some(value => value > 16)) bad();
  return { low, high, start, symbols };
}

export function admitLosslessJpeg(bytes, info, uid) {
  if (bytes[0] !== 255 || bytes[1] !== 216) bad();
  let at = 2, frame = null, segments = 0; const tables = new Map();
  while (at < bytes.length) {
    if (++segments > 1024 || bytes[at++] !== 255) bad();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++]; if (at + 2 > bytes.length) bad();
    const length = u16(bytes, at), from = at + 2, end = at + length;
    if (length < 2 || end > bytes.length) bad();
    if (marker === 195) {
      if (frame || length < 8) bad();
      const precision = bytes[from], height = u16(bytes, from + 1), width = u16(bytes, from + 3), count = bytes[from + 5];
      if (width !== info.columns || height !== info.rows || precision !== info.bitsStored || precision < 2 || precision > 16
          || count !== info.samplesPerPixel || ![1, 3].includes(count) || length !== 8 + count * 3) bad();
      const ids = [];
      for (let index = 0; index < count; index++) {
        const id = bytes[from + 6 + index * 3];
        if (ids.includes(id) || bytes[from + 7 + index * 3] !== 0x11 || bytes[from + 8 + index * 3] !== 0) bad(); ids.push(id);
      }
      frame = { width, height, precision, count, ids };
    } else if (marker === 196) {
      let cursor = from;
      while (cursor < end) {
        if (cursor + 17 > end) bad();
        const slot = bytes[cursor++]; if (slot > 3 || tables.has(slot)) bad();
        const counts = bytes.subarray(cursor, cursor + 16); cursor += 16;
        const count = counts.reduce((sum, value) => sum + value, 0); if (cursor + count > end) bad();
        tables.set(slot, huffman(counts, bytes.subarray(cursor, cursor + count))); cursor += count;
      }
      if (cursor !== end) bad();
    } else if (marker === 218) {
      if (!frame || bytes[from] !== frame.count || length !== 6 + frame.count * 2) bad();
      const scan = [], seen = new Set();
      for (let index = 0; index < frame.count; index++) {
        const id = bytes[from + 1 + index * 2], selector = bytes[from + 2 + index * 2], component = frame.ids.indexOf(id), table = tables.get(selector >> 4);
        if (component < 0 || seen.has(id) || selector & 15 || !table) bad(); seen.add(id); scan.push({ component, table });
      }
      const predictor = bytes[end - 3], point = bytes[end - 1];
      if (predictor < 1 || predictor > 7 || bytes[end - 2] !== 0 || point >> 4 || point >= frame.precision
          || uid === '1.2.840.10008.1.2.4.70' && predictor !== 1) bad();
      const plan = { bytes, ...frame, scan, predictor, point, start: end, info };
      verifyLosslessJpeg(plan); return plan;
    } else if (!(marker >= 224 && marker <= 239 || marker === 254)) bad();
    at = end;
  }
  bad();
}

class Entropy {
  constructor(bytes, start) { this.bytes = bytes; this.at = start; this.value = 0; this.remaining = 0; }
  bit() {
    if (!this.remaining) {
      if (this.at >= this.bytes.length) bad();
      this.value = this.bytes[this.at++];
      if (this.value === 255 && this.bytes[this.at++] !== 0) bad();
      this.remaining = 8;
    }
    return (this.value >>> --this.remaining) & 1;
  }
  bits(count) { let value = 0; while (count--) value = value * 2 + this.bit(); return value; }
  finish() {
    if (this.remaining && (this.value & (2 ** this.remaining - 1)) !== 2 ** this.remaining - 1) bad();
    if (this.bytes[this.at++] !== 255) bad(); while (this.bytes[this.at] === 255) this.at++;
    if (this.bytes[this.at++] !== 217 || !(this.at === this.bytes.length || this.at + 1 === this.bytes.length && this.bytes[this.at] === 0)) bad();
  }
}
function symbol(reader, table) {
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    code = code * 2 + reader.bit();
    if (table.low[length] >= 0 && code >= table.low[length] && code <= table.high[length]) return table.symbols[table.start[length] + code - table.low[length]];
  }
  bad();
}
function prediction(mode, left, above, diagonal) {
  switch (mode) {
    case 1: return left;
    case 2: return above;
    case 3: return diagonal;
    case 4: return left + above - diagonal;
    case 5: return left + Math.floor((above - diagonal) / 2);
    case 6: return above + Math.floor((left - diagonal) / 2);
    case 7: return Math.floor((left + above) / 2);
  }
  bad();
}

// Two rows suffice for the independent prediction check. The unchanged site
// decoder still produces the frame; this verifier proves that no missing bits
// or early marker were silently padded, and every output sample is correct.
export function verifyLosslessJpeg(plan, actual = null) {
  const { bytes, width, height, count, precision, point, info, scan, predictor } = plan, reader = new Entropy(bytes, plan.start),
    effective = precision - point, reducedMask = 2 ** effective - 1, storedMask = 2 ** precision - 1, sign = 2 ** (precision - 1), initial = 2 ** (effective - 1);
  if (actual && (actual.width !== width || actual.height !== height || actual.samples !== count || actual.values.length !== width * height * count)) bad();
  let previous = new Uint16Array(width * count), current = new Uint16Array(width * count);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) for (const { component, table } of scan) {
      const offset = column * count + component, category = symbol(reader, table);
      if (category > effective) bad();
      let difference = 0;
      if (category === 16) difference = 32768;
      else if (category) { const raw = reader.bits(category); difference = raw < 2 ** (category - 1) ? raw - 2 ** category + 1 : raw; }
      const predicted = !row && !column ? initial : !column ? previous[offset]
        : !row ? current[offset - count] : prediction(predictor, current[offset - count], previous[offset], previous[offset - count]);
      const reduced = (predicted + difference) & reducedMask; current[offset] = reduced;
      if (actual) {
        let expected = (reduced * 2 ** point) & storedMask; if (info.signed && expected & sign) expected -= 2 ** precision;
        if (actual.values[(row * width + column) * count + component] !== expected) {
          throw new AdapterError('VERIFICATION_FAILED', 'The existing JPEG lossless decoder did not match every independently reconstructed stored sample. No output was written.');
        }
      }
    }
    [previous, current] = [current, previous];
  }
  reader.finish(); return width * height * count;
}
