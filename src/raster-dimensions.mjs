// These fields come from the unchanged container readers. Inspect them before
// a native decoder allocates pixels; every WebP size declaration must agree.
export function rasterInputDimensions(image) {
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (image.kind === 'png') {
    const data = image.doc.chunks.find(chunk => chunk.type === 'IHDR')?.data;
    if (data?.length === 13) return { width: view(data).getUint32(0), height: view(data).getUint32(4) };
  } else if (image.kind === 'jpeg') {
    const frames = image.doc.segments.filter(segment => [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(segment.marker));
    if (frames.length === 1 && frames[0].payload.length >= 6) {
      return { width: view(frames[0].payload).getUint16(3), height: view(frames[0].payload).getUint16(1) };
    }
  } else if (image.kind === 'webp') {
    const dimensions = [];
    for (const { fourcc, data } of image.doc.chunks) {
      if (fourcc === 'VP8X' && data.length >= 10) {
        const uint24 = at => data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
        dimensions.push({ width: uint24(4) + 1, height: uint24(7) + 1 });
      } else if (fourcc === 'VP8 ' && data.length >= 10 && data[3] === 0x9d && data[4] === 1 && data[5] === 0x2a) {
        dimensions.push({ width: view(data).getUint16(6, true) & 0x3fff, height: view(data).getUint16(8, true) & 0x3fff });
      } else if (fourcc === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
        const bits = view(data).getUint32(1, true);
        dimensions.push({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
      }
    }
    if (dimensions.length && dimensions.every(size => size.width === dimensions[0].width && size.height === dimensions[0].height)) return dimensions[0];
  }
  return null;
}
