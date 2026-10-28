// A tiny independent lossless-JPEG fixture encoder. It emits one canonical DC
// table and a complete non-subsampled scan, for known stored sample values.
export function losslessJpeg(values, { width = 2, height = 2, precision = 16, components = 1, predictor = 1, point = 0, order = null } = {}) {
  const segment = (marker, data) => { const head = Buffer.alloc(4); head[0] = 255; head[1] = marker; head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
  const counts = Buffer.alloc(16); counts[4] = 17;
  const dht = segment(196, Buffer.concat([Buffer.from([0]), counts, Buffer.from(Array.from({ length: 17 }, (_, at) => at))]));
  const frame = Buffer.alloc(6 + components * 3); frame[0] = precision; frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3); frame[5] = components;
  for (let index = 0; index < components; index++) { frame[6 + index * 3] = index + 1; frame[7 + index * 3] = 0x11; }
  const positions = order ?? Array.from({ length: components }, (_, at) => at), scan = Buffer.alloc(1 + components * 2 + 3); scan[0] = components;
  positions.forEach((component, index) => { scan[1 + index * 2] = component + 1; }); scan[scan.length - 3] = predictor; scan[scan.length - 1] = point;
  const out = []; let accumulator = 0, used = 0;
  const bits = (value, count) => { for (let shift = count - 1; shift >= 0; shift--) { accumulator = accumulator * 2 + ((value >>> shift) & 1);
    if (++used === 8) { out.push(accumulator); if (accumulator === 255) out.push(0); accumulator = used = 0; } } };
  const effective = precision - point, mask = 2 ** effective - 1, stored = 2 ** precision - 1, half = 2 ** (effective - 1), reduced = values.map(value => (value & stored) >>> point);
  const at = (row, column, component) => reduced[(row * width + column) * components + component];
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) for (const component of positions) {
    let predicted;
    if (!row && !column) predicted = half;
    else if (!column) predicted = at(row - 1, column, component);
    else if (!row) predicted = at(row, column - 1, component);
    else {
      const a = at(row, column - 1, component), b = at(row - 1, column, component), c = at(row - 1, column - 1, component);
      predicted = [0, a, b, c, a + b - c, a + Math.floor((b - c) / 2), b + Math.floor((a - c) / 2), Math.floor((a + b) / 2)][predictor];
    }
    const difference = ((at(row, column, component) - predicted + half) & mask) - half,
      category = difference ? Math.floor(Math.log2(Math.abs(difference))) + 1 : 0;
    bits(category, 5);
    if (category && category !== 16) bits(difference < 0 ? difference + 2 ** category - 1 : difference, category);
  }
  if (used) bits(2 ** (8 - used) - 1, 8 - used);
  return evenJpeg(Buffer.concat([Buffer.from([255, 216]), dht, segment(195, frame), segment(218, scan), Buffer.from(out), Buffer.from([255, 217])]));
}
export function evenJpeg(bytes) { return bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([0])]) : bytes; }
export function encapsulatedDicom(native, fragment) {
  const start = native.lastIndexOf(Buffer.from([0xe0, 0x7f, 0x10, 0])); if (start < 0) throw new Error('Fixture Pixel Data was not found.');
  const header = Buffer.alloc(12); header.writeUInt16LE(0x7fe0); header.writeUInt16LE(0x10, 2); header.write('OB', 4); header.writeUInt32LE(0xffffffff, 8);
  const item = (tag, data) => { const bytes = Buffer.alloc(8); bytes.writeUInt16LE(0xfffe); bytes.writeUInt16LE(tag, 2); bytes.writeUInt32LE(data.length, 4); return Buffer.concat([bytes, data]); };
  return Buffer.concat([native.subarray(0, start), header, item(0xe000, Buffer.alloc(0)), item(0xe000, evenJpeg(fragment)), item(0xe0dd, Buffer.alloc(0))]);
}

// This Part 10 fixture is shared by packaged MCP checks without importing a
// node:test module or any processing implementation into the fixture builder.
export function jpegDicomFixture({ values = [0, 100, 200, 300], uid = '1.2.840.10008.1.2.4.70', predictor = 1 } = {}) {
  const element = (group, tag, vr, value) => {
    let data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
    const long = vr === 'OW', header = Buffer.alloc(long ? 12 : 8);
    header.writeUInt16LE(group); header.writeUInt16LE(tag, 2); header.write(vr, 4, 'latin1');
    long ? header.writeUInt32LE(data.length, 8) : header.writeUInt16LE(data.length, 6);
    return Buffer.concat([header, data]);
  };
  const us = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
  const meta = element(2, 0x10, 'UI', uid), length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const raw = Buffer.alloc(values.length * 2); values.forEach((value, index) => raw.writeUInt16LE(value, index * 2));
  const native = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', length), meta,
    element(8, 0x20, 'DA', '19801231'), element(0x10, 0x10, 'PN', 'PRIVATE^PATIENT'), element(0x10, 0x20, 'LO', 'PRIVATE-PATIENT-ID'),
    element(0x20, 0x0d, 'UI', '1.2.826.0.1.3680043.10.999.123'),
    element(0x28, 2, 'US', us(1)), element(0x28, 4, 'CS', 'MONOCHROME2'), element(0x28, 8, 'IS', '1'),
    element(0x28, 0x10, 'US', us(2)), element(0x28, 0x11, 'US', us(2)),
    element(0x28, 0x100, 'US', us(16)), element(0x28, 0x101, 'US', us(16)),
    element(0x28, 0x102, 'US', us(15)), element(0x28, 0x103, 'US', us(0)), element(0x7fe0, 0x10, 'OW', raw)]);
  return encapsulatedDicom(native, losslessJpeg(values, { predictor }));
}
