// Install trusted adapter code through page.evaluate in the job's isolated
// context. This shares the guard with video reversal without opening a route
// for arbitrary source files or changing the browser's CSP/network policy.
export function installAudioPacketDecoder() {
  globalThis.__aboxDecodeAudioPackets = async (file, plan) => {
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    if (!plan || !['mp3', 'mp4a.40.2'].includes(plan.codec) || ![1, 2].includes(plan.channels) || !Number.isSafeInteger(plan.frames) || plan.frames < 1 || plan.frames > 12_000_000
        || plan.frames * plan.channels > 24_000_000 || !Number.isSafeInteger(plan.sample_rate) || plan.sample_rate < 8000 || plan.sample_rate > 96000
        || plan.frames / plan.sample_rate > 600 || ![576, 1024, 1152].includes(plan.packet_frames)
        || !Array.isArray(plan.packets) || !plan.packets.length || plan.packets.length > 24000
        || plan.frames !== plan.packets.length * plan.packet_frames || !Number.isSafeInteger(file?.size) || file.size < 1 || file.size > 64 * 2 ** 20
        || (plan.codec === 'mp3' ? plan.packet_frames === 1024 || plan.description !== undefined
          : plan.packet_frames !== 1024 || !plan.description || plan.description.length < 2 || plan.description.length > 16)) {
      fail('AUDIO_DECODE_MISMATCH', 'The internal compressed-audio plan exceeded its fixed bounds.');
    }
    for (const packet of plan.packets) {
      if (![packet.offset, packet.size, packet.timestamp].every(Number.isSafeInteger) || packet.offset < 0 || packet.size < 1
          || packet.size > 8191 || packet.offset + packet.size > file.size || packet.timestamp < 0) {
        fail('AUDIO_DECODE_MISMATCH', 'An internal audio packet exceeded its admitted bounds.');
      }
    }
    if (typeof AudioDecoder !== 'function') fail('AUDIO_DECODER_UNAVAILABLE', 'This installed browser has no packet audio decoder. No fallback or download is used.');
    const config = { codec: plan.codec, sampleRate: plan.sample_rate, numberOfChannels: plan.channels };
    if (plan.description) config.description = Uint8Array.from(plan.description);
    let supported = false;
    try { supported = Boolean((await AudioDecoder.isConfigSupported(config)).supported); } catch { /* A codec can be absent. */ }
    if (!supported) fail('AUDIO_DECODER_UNAVAILABLE', 'The installed browser does not support this admitted compressed audio codec.');
    const planes = Array.from({ length: plan.channels }, () => new Float32Array(plan.frames));
    let received = 0, failure = false, previousTime = -Infinity;
    const decoder = new AudioDecoder({
      output: data => {
        try {
          if (failure) return;
          // AAC/MP3 config sampleRate/channels are ignored by WebCodecs. No
          // untrusted block size is used to allocate an application PCM plane.
          if (data.numberOfChannels !== plan.channels || data.sampleRate !== plan.sample_rate
              || !Number.isSafeInteger(data.numberOfFrames) || data.numberOfFrames < 1 || data.numberOfFrames > plan.packet_frames * 2
              || received + data.numberOfFrames > plan.frames || !Number.isSafeInteger(data.timestamp) || data.timestamp < previousTime) {
            failure = true; return;
          }
          previousTime = data.timestamp;
          for (let channel = 0; channel < planes.length; channel++) data.copyTo(planes[channel].subarray(received, received + data.numberOfFrames), { planeIndex: channel, format: 'f32-planar' });
          received += data.numberOfFrames;
        } catch { failure = true; }
        finally { data.close(); }
      }, error: () => { failure = true; },
    });
    try {
      decoder.configure(config);
      for (const [index, packet] of plan.packets.entries()) {
        if (failure) break;
        const start = performance.now();
        while (decoder.decodeQueueSize >= 4 && !failure) {
          if (performance.now() - start > 30000) fail('AUDIO_DECODE_MISMATCH', 'The native audio decoder stopped making progress.');
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        if (failure) break;
        const data = new Uint8Array(await file.slice(packet.offset, packet.offset + packet.size).arrayBuffer());
        if (data.length !== packet.size) fail('AUDIO_DECODE_MISMATCH', 'An audio packet could not be read completely.');
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: packet.timestamp, data }));
        if (!(index % 32)) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!failure) await decoder.flush();
      if (failure || received < 1 || plan.frames - received > plan.packet_frames * 4) {
        fail('AUDIO_DECODE_MISMATCH', 'The decoder changed the admitted audio geometry or omitted more than the bounded priming/padding allowance.');
      }
      return { channels: planes.map(plane => plane.subarray(0, received)), sampleRate: plan.sample_rate,
        frames: received, duration: received / plan.sample_rate, guessedRate: false, decoder_omitted_frames: plan.frames - received };
    } catch (error) {
      if (['AUDIO_DECODER_UNAVAILABLE', 'AUDIO_DECODE_MISMATCH'].includes(error?.code)) throw error;
      fail('AUDIO_DECODE_MISMATCH', 'The native packet audio decoder could not complete this admitted stream.');
    } finally { if (decoder.state !== 'closed') decoder.close(); }
  };
}
