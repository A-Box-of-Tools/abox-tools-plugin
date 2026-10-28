# Audio editing, trimming and extraction

Use absolute local input paths and new output files. These routes return counts,
paths and technical verification; never copy audio bytes or decoded samples
into the conversation. Call `abox_capabilities` before using a route or format
that an older installed adapter might not support.

## Supported inputs and admission

`abox_audio_edit`, `abox_audio_trim` and WAV extraction accept:

- Ordinary little-endian mono/stereo PCM16 or IEEE Float32 RIFF WAV, with one
  complete sample-data chunk and the documented simple format layout.
- Stable-format MP3 Layer III, with complete ordinary MPEG-1/2/2.5 frame
  boundaries. Free-format streams, changing rate/channels and a first frame
  requiring an earlier bit reservoir are refused. Bounded leading ID3 and a
  trailing ID3v1 tag can be skipped.
- AAC-LC ADTS with one raw-data block per frame, ordinary rate signaling and
  explicit mono/stereo channel configuration. HE-AAC, PCE channel configuration,
  960-sample frames and multiblock frames are refused.
- Ordinary nonfragmented MP4/M4A/MOV containing one mono/stereo AAC-LC audio
  track, with 1024-sample packet timing and a zero-origin unedited audio
  timeline. Unsupported track descriptions and priming/edit lists fail locally.
  Video packets are not decoded when extracting the sound.

Input is at most 64 MiB, with at most 24000 compressed packets, 600 seconds,
12 million frames, 24 million channel-samples and an 8–96 kHz sample rate.
The same decoded frame/channel/duration bounds apply to planned output, which
must fit within 128 MiB. These are admission policies, not a universal process
memory cap. Compressed decoding uses a bounded packet queue and checks every
returned native audio block before copying samples into admitted PCM planes.
It does not prove full compressed-bitstream validity.

WAV processing requires an installed local browser. Compressed processing also
requires that browser's native WebCodecs decoder for the admitted codec. Missing
support returns `AUDIO_DECODER_UNAVAILABLE`; there is no whole-file decoding
fallback, upload or runtime codec download.

## Edit or trim to WAV

`abox_audio_edit` / `edit-audio`: `input_path`, `.wav` `output_path`;
optional `reverse:false`, `speed:1` (0.25–4), `keep_pitch:true`,
`volume_mode:"gain"` or `"normalize"`, and `bits:16` or `32`.
Gain mode accepts `gain_db` (-60–24, default 0); normalize mode accepts
`normalize_db` (-60–0, default -1). Omit the other mode's level argument.
The source engine applies reverse, speed/pitch and then level. Pitch preservation
can smear transients; it does not promise transparent sound.

`abox_audio_trim` / `trim-audio`: `input_path`, `.wav` `output_path`,
`ranges:[{"start":0.08,"end":0.10},{"start":0.04,"end":0.06}]` in seconds;
optional `mode:"keep"` or `"cut"`, `fade_ms:5` (0–50), and `bits:16` or `32`.
Ranges must fit within the actual decoded source and retain samples after
rounding. Keep mode preserves supplied order, overlaps and duplicates. Cut mode
merges ranges and uses the ascending complement; the source omits leftover gaps
of at most one millisecond. Set `fade_ms:0` for exact unfaded sample selection.

## Extract sound

`abox_audio_extract` / `extract-audio`: `input_path`, `output_path`, optional
`format:"wav"` or `"m4a"` (default WAV).

For `.wav` output, optional `bits` is 16 (PCM default) or 32 (IEEE Float32),
and `channels` is `"keep"` (default) or `"mono"`. Mono averages decoded channels
using the website extractor's Float32 accumulation. No video decoder is used.

For `.m4a` output, the input must be an admitted MP4/M4A/MOV AAC-LC track.
Omit `bits` and `channels` entirely. AAC packets, timing and sample description
are copied and verified without a browser or decoding. Other tracks and container
metadata are omitted, but technical codec data and metadata inside packets can
remain. This is not redaction, anonymization or proof of playback compatibility.

## Interpret results

Check `verified`, `frames`, `sample_rate`, `channels`, `verification` and
`warnings`. Every encoded WAV sample is compared with the processed PCM samples.
PCM16 rounds/clamps those samples; Float32 retains their processed precision,
including finite values outside full scale. Neither restores prior codec losses.

`input_header_max_frames` is an encoded-frame upper bound. A native compressed
decoder can omit a bounded number of priming/padding samples, so `input_frames`
and output times use the actual decoded samples. Decoder behavior and native
PCM normalization can vary across platforms. A requested range beyond the actual
decoded end is refused rather than silently clipped. Source metadata is not
copied to WAV, and original files remain unchanged.
