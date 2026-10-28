import { setImmediate as yieldTurn } from 'node:timers/promises';
import { audioDecoderConfig } from '../vendor/abox/shared/js/aac.js';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { preflightMp4 } from './video-copy.mjs';
import { AdapterError } from './errors.mjs';
import { audioWithinBounds, MAX_AUDIO_INPUT_BYTES, MAX_AUDIO_OUTPUT_BYTES, MAX_AUDIO_PACKETS } from './audio-limits.mjs';

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const MPEG_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];
const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG_LOW_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const fail = () => { throw new AdapterError('UNSUPPORTED_AUDIO', 'Use complete stable-format MP3 Layer III, AAC-LC ADTS, or ordinary MP4/M4A/MOV with one mono/stereo AAC-LC track. Free-format, multiblock AAC, PCE/HE extensions, fragments and edited/delayed audio timelines are unsupported.'); };
const limit = () => { throw new AdapterError('AUDIO_LIMIT', 'Encoded audio exceeds the 64 MiB input, 24000 packet, mono/stereo, 8–96 kHz, 600 second, 12 million frame or 24 million channel-sample admission policy.'); };
const same = (one, two) => Buffer.from(one).equals(Buffer.from(two));
const clock = (frames, rate) => Math.round(frames / rate * 1_000_000);

function budget(frames, channels, rate, packets) {
  if (!audioWithinBounds(frames, channels, rate) || packets > MAX_AUDIO_PACKETS) limit();
}

function metadataBounds(bytes) {
  let start = 0, tags = 0, end = bytes.length;
  while (bytes.toString('latin1', start, start + 3) === 'ID3') {
    if (++tags > 4 || start + 10 > end || ![2, 3, 4].includes(bytes[start + 3])
        || bytes[start + 4] === 255 || bytes.subarray(start + 6, start + 10).some(byte => byte & 128)) fail();
    let length = 0; for (let at = start + 6; at < start + 10; at++) length = length * 128 + bytes[at];
    const footer = bytes[start + 3] === 4 && (bytes[start + 5] & 16) ? 10 : 0;
    if (length > 1024 * 1024 || start + 10 + length + footer > end) fail();
    if (footer && bytes.toString('latin1', start + 10 + length, start + 13 + length) !== '3DI') fail();
    start += 10 + length + footer;
  }
  if (end - start >= 128 && bytes.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  if (start >= end) fail(); return { start, end };
}

async function rawMpeg(bytes, signal) {
  const range = metadataBounds(bytes), packets = []; let first, frames = 0;
  for (let at = range.start; at < range.end;) {
    if (at + 4 > range.end || bytes[at] !== 255 || (bytes[at + 1] & 224) !== 224) fail();
    const version = bytes[at + 1] >> 3 & 3, layer = bytes[at + 1] >> 1 & 3;
    const rateIndex = bytes[at + 2] >> 2 & 3, bitrateIndex = bytes[at + 2] >> 4;
    const channels = bytes[at + 3] >> 6 === 3 ? 1 : 2, rate = MPEG_RATES[version]?.[rateIndex];
    if (layer !== 1 || !rate || bitrateIndex === 0 || bitrateIndex === 15 || (bytes[at + 3] & 3) === 2) fail();
    const count = version === 3 ? 1152 : 576, crc = (bytes[at + 1] & 1) ? 0 : 2;
    const side = version === 3 ? channels === 1 ? 17 : 32 : channels === 1 ? 9 : 17;
    const size = Math.floor((version === 3 ? 144000 : 72000) * (version === 3 ? MPEG1_KBPS : MPEG_LOW_KBPS)[bitrateIndex] / rate)
      + (bytes[at + 2] >> 1 & 1);
    if (size < 4 + crc + side || at + size > range.end) fail();
    if (!first) {
      first = { rate, channels, version, count };
      const reservoir = version === 3 ? bytes[at + 4 + crc] * 2 + (bytes[at + 5 + crc] >> 7) : bytes[at + 4 + crc];
      if (reservoir !== 0) fail();
    } else if (rate !== first.rate || channels !== first.channels || version !== first.version) fail();
    packets.push({ offset: at, size, frames: count, timestamp: clock(frames, rate) }); frames += count;
    budget(frames, channels, rate, packets.length); at += size;
    if (!(packets.length % 256)) { signal?.throwIfAborted(); await yieldTurn(); }
  }
  return { kind: 'mp3', codec: 'mp3', sample_rate: first.rate, channels: first.channels,
    frames, duration_seconds: frames / first.rate, packet_frames: first.count, packets, exact_frames: false,
    metadata_skipped: range.start !== 0 || range.end !== bytes.length };
}

function ascInfo(bytes) {
  // AAC-LC's ordinary GASpecificConfig is sixteen bits. Explicit HE/PCE,
  // 960-sample frames and core-coder dependencies are refused before decoding.
  if (bytes.length < 2 || bytes.length > 16 || bytes[0] >> 3 !== 2) fail();
  const rateIndex = (bytes[0] & 7) * 2 + (bytes[1] >> 7), channels = bytes[1] >> 3 & 15, rate = AAC_RATES[rateIndex];
  if (!rate || ![1, 2].includes(channels) || (bytes[1] & 7)) fail();
  const tail = bytes.subarray(2);
  if (tail.some(byte => byte !== 0)) {
    // Some LC encoders append syncExtensionType=0x2b7, AOT=5 and an explicit
    // sbrPresentFlag=0. This signals absence, not an HE decode path.
    let bits = ''; for (const byte of tail) bits += byte.toString(2).padStart(8, '0');
    if (!bits.startsWith('01010110111' + '00101' + '0') || /1/.test(bits.slice(17))) fail();
  }
  return { sample_rate: rate, channels };
}

async function adts(bytes, signal) {
  const range = metadataBounds(bytes), packets = []; let first, frames = 0;
  for (let at = range.start; at < range.end;) {
    if (at + 7 > range.end || bytes[at] !== 255 || (bytes[at + 1] & 246) !== 240) fail();
    const profile = bytes[at + 2] >> 6, index = bytes[at + 2] >> 2 & 15;
    const rate = AAC_RATES[index], channels = (bytes[at + 2] & 1) * 4 + (bytes[at + 3] >> 6);
    const size = (bytes[at + 3] & 3) * 2048 + bytes[at + 4] * 8 + (bytes[at + 5] >> 5);
    const header = bytes[at + 1] & 1 ? 7 : 9;
    if (profile !== 1 || !rate || ![1, 2].includes(channels) || (bytes[at + 6] & 3)
        || size <= header || at + size > range.end) fail();
    if (!first) first = { rate, channels, index };
    else if (rate !== first.rate || channels !== first.channels || index !== first.index) fail();
    packets.push({ offset: at + header, size: size - header, frames: 1024, timestamp: clock(frames, rate) }); frames += 1024;
    budget(frames, channels, rate, packets.length); at += size;
    if (!(packets.length % 256)) { signal?.throwIfAborted(); await yieldTurn(); }
  }
  const asc = Uint8Array.of(0x10 | (first.index >> 1), ((first.index & 1) << 7) | (first.channels << 3));
  return { kind: 'adts', codec: 'mp4a.40.2', description: asc, sample_rate: first.rate, channels: first.channels,
    frames, duration_seconds: frames / first.rate, packet_frames: 1024, packets, exact_frames: false,
    metadata_skipped: range.start !== 0 || range.end !== bytes.length };
}

function boxes(bytes, start, end) {
  const found = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) fail(); let size = bytes.readUInt32BE(at), head = 8;
    if (size === 1) { if (at + 16 > end) fail(); const wide = bytes.readBigUInt64BE(at + 8); if (wide > BigInt(end - at)) fail(); size = Number(wide); head = 16; }
    else if (!size) size = end - at;
    if (size < head || size > end - at) fail();
    found.push({ type: bytes.toString('latin1', at + 4, at + 8), start: at, body: at + head, end: at + size }); at += size;
  }
  return found;
}
function one(list, type) { const found = list.filter(box => box.type === type); if (found.length !== 1) fail(); return found[0]; }
function descriptor(bytes, at, end, tag) {
  if (at >= end || bytes[at++] !== tag) fail(); let size = 0, count = 0, byte;
  do { if (at >= end || ++count > 4) fail(); byte = bytes[at++]; size = size * 128 + (byte & 127); } while (byte & 128);
  if (size > end - at) fail(); return { body: at, end: at + size };
}
function strictAudioEntry(bytes, entry) {
  if (entry.end - entry.start < 36 || bytes.readUInt16BE(entry.start + 16) !== 0
      || bytes.readUInt16BE(entry.start + 14) !== 1 || entry.type !== 'mp4a') fail();
  const rate = bytes.readUInt32BE(entry.start + 32) / 65536, channels = bytes.readUInt16BE(entry.start + 24);
  const children = boxes(bytes, entry.start + 36, entry.end), esds = one(children, 'esds');
  if (children.some(child => !['esds', 'btrt'].includes(child.type)) || esds.body + 4 > esds.end || bytes.readUInt32BE(esds.body) !== 0) fail();
  if (children.some(child => child.type === 'btrt' && child.end - child.body !== 12)) fail();
  const es = descriptor(bytes, esds.body + 4, esds.end, 3);
  if (es.end !== esds.end || es.body + 3 > es.end || bytes[es.body + 2] !== 0) fail();
  const config = descriptor(bytes, es.body + 3, es.end, 4);
  if (config.body + 13 > config.end || bytes[config.body] !== 0x40 || bytes[config.body + 1] !== 0x15) fail();
  const specific = descriptor(bytes, config.body + 13, config.end, 5);
  if (specific.end !== config.end) fail();
  const sl = descriptor(bytes, config.end, es.end, 6);
  if (sl.end !== es.end || sl.end - sl.body !== 1 || bytes[sl.body] !== 2) fail();
  const asc = bytes.subarray(specific.body, specific.end), info = ascInfo(asc);
  const sampleEntry = Uint8Array.from(bytes.subarray(entry.start, entry.end));
  const checked = audioDecoderConfig({ sampleEntry, entryType: 'mp4a', sampleRate: rate, channels });
  if (!checked || checked.codec !== 'mp4a.40.2' || !same(checked.description, asc)
      || info.sample_rate !== rate || info.channels !== channels) fail();
  return { ...info, description: Uint8Array.from(asc), sample_entry: sampleEntry };
}

export async function admitMp4Audio(bytes, { signal } = {}) {
  if (!bytes.length || bytes.length > MAX_AUDIO_INPUT_BYTES) limit(); signal?.throwIfAborted();
  const structure = preflightMp4(bytes);
  if (structure.fragmented || structure.tracks.filter(track => track.kind === 'soun').length !== 1) fail();
  const top = boxes(bytes, 0, bytes.length), moov = one(top, 'moov'), movieChildren = boxes(bytes, moov.body, moov.end);
  const tracks = movieChildren.filter(box => box.type === 'trak'); let selected, videoTracks = 0;
  for (const [index, track] of tracks.entries()) {
    if (structure.tracks[index]?.kind === 'vide') videoTracks++;
    if (structure.tracks[index]?.kind !== 'soun') continue;
    const children = boxes(bytes, track.body, track.end), mdia = one(children, 'mdia'), media = boxes(bytes, mdia.body, mdia.end);
    const mdhd = one(media, 'mdhd'), minf = one(media, 'minf'), stbl = one(boxes(bytes, minf.body, minf.end), 'stbl');
    const tables = boxes(bytes, stbl.body, stbl.end), stsd = one(tables, 'stsd');
    if (mdhd.body + 4 > mdhd.end || bytes[mdhd.body] > 1 || bytes.readUIntBE(mdhd.body + 1, 3) !== 0) fail();
    const version = bytes[mdhd.body], clockAt = mdhd.body + (version ? 20 : 12);
    if (clockAt + (version ? 12 : 8) > mdhd.end) fail();
    const rate = bytes.readUInt32BE(clockAt), duration = version ? Number(bytes.readBigUInt64BE(clockAt + 4)) : bytes.readUInt32BE(clockAt + 4);
    const entry = one(boxes(bytes, stsd.body + 8, stsd.end), 'mp4a'), info = strictAudioEntry(bytes, entry);
    const record = structure.tracks[index];
    if (rate !== info.sample_rate || duration !== record.decode_duration) fail();
    const edts = children.filter(child => child.type === 'edts');
    if (edts.length) {
      if (edts.length !== 1) fail(); const list = one(boxes(bytes, edts[0].body, edts[0].end), 'elst');
      const at = list.body, version = bytes[at], width = version === 1 ? 20 : 12;
      if (version > 1 || list.end - at !== 8 + width || bytes.readUInt32BE(at + 4) !== 1) fail();
      const mediaTime = version ? Number(bytes.readBigInt64BE(at + 16)) : bytes.readInt32BE(at + 12);
      if (mediaTime !== 0 || bytes.readUInt32BE(at + (version ? 24 : 16)) !== 0x10000) fail();
      const mvhd = one(movieChildren, 'mvhd'), movieVersion = bytes[mvhd.body], movieAt = mvhd.body + (movieVersion === 1 ? 20 : 12);
      if (movieVersion > 1 || movieAt + 4 > mvhd.end) fail(); const movieRate = bytes.readUInt32BE(movieAt);
      const editDuration = version ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
      if (!movieRate || Math.abs(editDuration / movieRate - duration / rate) > 1 / movieRate) fail();
    }
    selected = { info, record, duration, rate };
  }
  if (!selected) fail();
  const { info, record, duration, rate } = selected, { stsz, stts, stsc, stco, co64, ctts } = record.tables;
  if (ctts) fail();
  const packets = [], chunks = stco ?? co64, uniform = bytes.readUInt32BE(stsz.body + 4); let frame = 0, run = 0, sample = 0;
  for (let row = 0; row < stts.count; row++) if (bytes.readUInt32BE(stts.body + 12 + row * 8) !== 1024) fail();
  for (let chunk = 0; chunk < chunks.count; chunk++) {
    while (run + 1 < stsc.count && bytes.readUInt32BE(stsc.body + 8 + (run + 1) * 12) <= chunk + 1) run++;
    const count = bytes.readUInt32BE(stsc.body + 12 + run * 12), p = chunks.body + 8 + chunk * (co64 ? 8 : 4);
    let offset = co64 ? Number(bytes.readBigUInt64BE(p)) : bytes.readUInt32BE(p);
    for (let index = 0; index < count; index++, sample++) {
      const size = uniform || bytes.readUInt32BE(stsz.body + 12 + sample * 4);
      if (size > 8191) fail();
      packets.push({ offset, size, frames: 1024, timestamp: clock(frame, rate) }); offset += size; frame += 1024;
      budget(frame, info.channels, rate, packets.length);
    }
    if (!(chunk % 256)) { signal?.throwIfAborted(); await yieldTurn(); }
  }
  if (sample !== stsz.count || frame !== duration) fail();
  budget(frame, info.channels, rate, packets.length);
  return { kind: 'mp4-aac', codec: 'mp4a.40.2', ...info, frames: frame, packets, packet_frames: 1024,
    duration_seconds: frame / rate, exact_frames: false, video_tracks: videoTracks, metadata_skipped: true };
}

export async function admitCompressedAudio(bytes, options = {}) {
  if (!bytes.length || bytes.length > MAX_AUDIO_INPUT_BYTES) limit(); options.signal?.throwIfAborted();
  if (bytes.length >= 8 && bytes.toString('latin1', 4, 8) === 'ftyp') return admitMp4Audio(bytes, options);
  const { start } = metadataBounds(bytes);
  if (start + 2 > bytes.length) fail();
  return (bytes[start + 1] & 6) === 0 ? adts(bytes, options.signal) : rawMpeg(bytes, options.signal);
}

export async function copyAacToM4a(bytes, plan, { signal } = {}) {
  if (plan.kind !== 'mp4-aac') fail();
  const payload = plan.packets.reduce((sum, packet) => sum + packet.size, 0);
  if (payload + plan.packets.length * 128 + plan.sample_entry.length + 1024 * 1024 > MAX_AUDIO_OUTPUT_BYTES) limit();
  const writer = new Mp4Writer();
  // This source writer deliberately requires video. A fixed adapter-owned
  // placeholder lets it build the ordinary audio tables; turning its generated
  // track into equal-size free space leaves all audio chunk offsets untouched.
  const placeholder = writer.addTrack({ kind: 'vide', timescale: 1000, width: 65536, height: 65536,
    sampleEntry: avcSampleEntry(1, 1, Uint8Array.of(1, 66, 0, 10, 255, 225, 0, 1, 103, 1, 0, 1, 104)) });
  placeholder.addSample({ data: Uint8Array.of(0), dts: 0, pts: 0, duration: Math.max(1, Math.round(plan.duration_seconds * 1000)), isKey: true });
  const track = writer.addTrack({ kind: 'soun', timescale: plan.sample_rate, sampleEntry: plan.sample_entry });
  for (const [index, packet] of plan.packets.entries()) {
    track.addSample({ data: bytes.subarray(packet.offset, packet.offset + packet.size), dts: index * 1024, pts: index * 1024, duration: 1024, isKey: true });
    if (!(index % 256)) { signal?.throwIfAborted(); await yieldTurn(); }
  }
  const blob = writer.finalize(); if (!blob.size || blob.size > MAX_AUDIO_OUTPUT_BYTES) limit();
  const output = Buffer.from(await blob.arrayBuffer()), moov = one(boxes(output, 0, output.length), 'moov');
  const tracks = boxes(output, moov.body, moov.end).filter(box => box.type === 'trak');
  if (tracks.length !== 2) fail();
  const media = one(boxes(output, tracks[0].body, tracks[0].end), 'mdia'), handler = one(boxes(output, media.body, media.end), 'hdlr');
  if (output.toString('latin1', handler.body + 8, handler.body + 12) !== 'vide') fail();
  output.write('free', tracks[0].start + 4, 'latin1'); output.fill(0, tracks[0].body, tracks[0].end);
  const checked = await admitMp4Audio(output, { signal });
  if (checked.video_tracks !== 0 || !same(checked.sample_entry, plan.sample_entry) || checked.frames !== plan.frames
      || checked.packets.length !== plan.packets.length || checked.channels !== plan.channels || checked.sample_rate !== plan.sample_rate) fail();
  for (let at = 0; at < checked.packets.length; at++) {
    const before = plan.packets[at], after = checked.packets[at];
    if (before.frames !== after.frames || before.timestamp !== after.timestamp
        || !same(bytes.subarray(before.offset, before.offset + before.size), output.subarray(after.offset, after.offset + after.size))) {
      throw new AdapterError('VERIFICATION_FAILED', 'The extracted M4A changed its AAC packet bytes, count, timing or sample description. No output was written.');
    }
  }
  signal?.throwIfAborted(); return output;
}
