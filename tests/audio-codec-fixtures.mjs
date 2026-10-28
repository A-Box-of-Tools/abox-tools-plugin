import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withBrowser } from '../src/browser.mjs';
import { Mp4Writer, avcSampleEntry } from '../vendor/abox/shared/js/mp4-writer.js';
import { mp4aSampleEntry } from '../vendor/abox/shared/js/aac.js';
import { admitCompressedAudio } from '../src/audio-headers.mjs';

// An original synthetic Layer III silent stream: zero-length Huffman data,
// zero bit reservoir and zero side-information values in every ordinary frame.
// There is no recording, external asset or third-party sample license.
export function silentMp3(count = 24) {
  const frames = [];
  for (let at = 0; at < count; at++) { const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0]); frames.push(frame); }
  return Buffer.concat(frames);
}

export function adtsFrame(payload, { sample_rate = 48000, channels = 2 } = {}) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000], index = rates.indexOf(sample_rate);
  if (index < 0 || ![1, 2].includes(channels) || payload.length + 7 > 8191) throw new Error('Unsupported fixture geometry');
  const size = payload.length + 7, head = Buffer.from([255, 241, 64 | index << 2 | channels >> 2,
    channels << 6 | size >> 11, size >> 3 & 255, (size & 7) << 5 | 31, 252]);
  return Buffer.concat([head, Buffer.from(payload)]);
}

export async function makeAacFixture() {
  const encoded = await withBrowser(async page => page.evaluate(async () => {
    const sampleRate = 48000, frames = 8192, channels = 2;
    if (typeof AudioEncoder !== 'function' || !(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128000 })).supported) {
      return { unavailable: true };
    }
    const packets = [], pixels = new Float32Array(frames * channels); let failure = false;
    for (let at = 0; at < frames; at++) {
      const taper = Math.min(1, at / 128, (frames - at - 1) / 128);
      pixels[at] = Math.sin(at / sampleRate * Math.PI * 2 * 440) * 0.3 * taper;
      pixels[frames + at] = Math.sin(at / sampleRate * Math.PI * 2 * 220) * 0.15 * taper;
    }
    const encoder = new AudioEncoder({ output: chunk => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); packets.push(Array.from(data)); }, error: () => { failure = true; } });
    try {
      encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128000, aac: { format: 'aac' } });
      const data = new AudioData({ format: 'f32-planar', sampleRate, numberOfChannels: channels, numberOfFrames: frames, timestamp: 0, data: pixels });
      try { encoder.encode(data); } finally { data.close(); }
      await encoder.flush(); if (failure || !packets.length) throw new Error('Synthetic AAC encoding failed');
      return { packets, sampleRate, channels };
    } finally { if (encoder.state !== 'closed') encoder.close(); }
  }));
  if (encoded.unavailable) throw Object.assign(new Error('The installed browser has no AAC-LC fixture encoder.'), { code: 'AUDIO_ENCODER_UNAVAILABLE' });
  return Buffer.concat(encoded.packets.map(packet => adtsFrame(packet, { sample_rate: encoded.sampleRate, channels: encoded.channels })));
}

export async function loadAacFixture() {
  try { return await readFile(new URL('./fixtures/abox-synthetic.aac', import.meta.url)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return makeAacFixture(); }
}

export async function aacContainer(adts, { video = false, edit = false } = {}) {
  const plan = await admitCompressedAudio(adts), writer = new Mp4Writer();
  {
    // Deliberately undecodable picture packets prove audio extraction does not
    // invoke a video decoder. Their outer MP4 structure remains well formed.
    const picture = writer.addTrack({ kind: 'vide', timescale: 1000, width: 64 * 65536, height: 32 * 65536,
      sampleEntry: avcSampleEntry(64, 32, Uint8Array.of(1, 66, 0, 10, 255, 225, 0, 1, 103, 1, 0, 1, 104)) });
    picture.addSample({ data: Uint8Array.of(0, 0, 0, 1, 0), duration: Math.round(plan.duration_seconds * 1000), dts: 0, pts: 0, isKey: true });
  }
  const sound = writer.addTrack({ kind: 'soun', timescale: plan.sample_rate,
    sampleEntry: mp4aSampleEntry({ channels: plan.channels, sampleRate: plan.sample_rate, asc: plan.description }) });
  for (const [at, packet] of plan.packets.entries()) sound.addSample({ data: adts.subarray(packet.offset, packet.offset + packet.size), dts: at * 1024, pts: at * 1024, duration: 1024, isKey: true });
  if (edit) sound.addEdit(1024, Math.max(1, Math.round((plan.frames - 1024) / plan.sample_rate * 1000)));
  const data = Buffer.from(await writer.finalize().arrayBuffer());
  if (!video) {
    // Test fixture construction independently removes the known first picture
    // track without changing the audio chunk offsets laid down by the writer.
    let moov;
    for (let at = 0; at < data.length; at += data.readUInt32BE(at)) if (data.toString('ascii', at + 4, at + 8) === 'moov') { moov = at; break; }
    for (let at = moov + 8; at < moov + data.readUInt32BE(moov); at += data.readUInt32BE(at)) if (data.toString('ascii', at + 4, at + 8) === 'trak') {
      const end = at + data.readUInt32BE(at); data.write('free', at + 4); data.fill(0, at + 8, end); break;
    }
  }
  return data;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write') throw new Error('Use --write to create the original synthetic AAC fixture once.');
  const filename = new URL('./fixtures/abox-synthetic.aac', import.meta.url); await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true });
  const data = await makeAacFixture(); await writeFile(filename, data, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ ok: true, bytes: data.length, fixture: 'tests/fixtures/abox-synthetic.aac', source: 'original synthetic stereo tones, native AAC-LC encoder' }) + '\n');
}
