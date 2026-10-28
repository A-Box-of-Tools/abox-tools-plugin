export const MAX_AUDIO_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MAX_AUDIO_FRAMES = 12_000_000;
export const MAX_AUDIO_SAMPLES = 24_000_000;
export const MAX_AUDIO_DURATION = 600;
export const MAX_AUDIO_RANGES = 100;
export const MAX_AUDIO_PACKETS = 24000;

export function audioWithinBounds(frames, channels, sampleRate) {
  return Number.isSafeInteger(frames) && frames > 0 && frames <= MAX_AUDIO_FRAMES
    && [1, 2].includes(channels) && frames * channels <= MAX_AUDIO_SAMPLES
    && Number.isSafeInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000
    && frames / sampleRate <= MAX_AUDIO_DURATION;
}
