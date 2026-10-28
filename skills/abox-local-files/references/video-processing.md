# Local video decoding and processing

These operations take absolute local `input_path` and new `output_path` values.
They reuse the website engines and never fetch codecs, upload media or return
frames/packets to the conversation. Call `abox_capabilities` because an older
adapter or installed browser can expose fewer features.

## Admitted input and verification

The input subset is ordinary nonfragmented MP4/M4V/MOV with stable progressive
H.264, 8-bit 4:2:0, profile 66/77/100, one SPS/PPS, ordinary zero-origin timing
and an unstretched quarter-turn display orientation. Every coded sequence/slice
and in-band parameter set is admitted before native decoding. Limits: 64 MiB,
4096 coded pixels per side, 4,194,304 coded pixels, four reference frames,
1800 picture samples and 60 seconds. Changed parameter sets, interlacing,
complex transforms, non-square pixels, clean apertures, edited timelines and
unsupported codecs fail locally.

All routes require an installed local browser with native H.264 decoding.
MP4 output also needs native H.264 encoding. Missing support is a capability
error; requested operations do not fall back to a download or upload.
New MP4 output has even sides at most 1920, at most 2,073,600 pixels and
128 MiB. Every generated frame is decoded again and checked for geometry,
timestamp and count. This is not a pixel-identical comparison with the original
compressed video, a full bitstream-validity proof or source-authenticity proof.
Color/chroma, encoder losses and source final-frame tail timing can change.

## Compress, crop or extract a frame

`abox_video_compress` / `compress-video`: `.mp4` `output_path`, required
`target_bytes` (100000–134217728), optional `max_side` (16–1920, default 1920)
and `keep_audio:true`. The source searches its supported encoding settings;
check `fitted` and actual `output_bytes`, since a target can be missed and
re-encoding can produce a larger file. Requested supported AAC packets are copied
and verified exactly, or explicitly omit sound with `keep_audio:false`.

`abox_video_crop` / `crop-video`: `.mp4` `output_path`, local JSON `crop_path`,
optional `quality` (`low`, `medium` default, `high`) and `keep_audio:true`.
The JSON contains exactly these six unique integer fields:

```json
{"image_width":160,"image_height":96,"x":80,"y":0,"width":80,"height":96}
```

Dimensions must match the decoded display image after source orientation.
`x`/`y` are top-left pixel coordinates. The rectangle must fit completely;
width/height must be even, 16–1920 and within the output pixel limit. Get actual
user-provided measurements; never guess from a scaled preview. Coordinates
remain in the local JSON rather than being returned in the summary. Configuration
is at most 16 KiB.

`abox_video_frame` / `grab-video-frame`: `.png` `output_path`, optional
`time_seconds` (0–60, default 0), within the admitted source timeline. Selects
the source frame at or before that time and applies its display orientation.
The lossless PNG is at most 32 MiB; every saved pixel is compared with the
selected decoded canvas pixels. Native codec/color behavior can vary.

## Reverse or make a time-lapse

`abox_video_reverse` / `reverse-video`: `.mp4` `output_path`, optional
`quality` (`low`, `medium` default, `high`) and `keep_audio:false`.
It reverses decoded frames and admits at most 96 million combined visible-frame
pixels. Sound is silent by default. Explicit `keep_audio:true` requires a
matching-duration mono/stereo AAC-LC track, the bounded packet decoder and a
native AAC encoder. PCM reversal is checked before lossy AAC encoding, and the
generated audio is reopened and decoded. Priming/padding can change length or
timing; decoder omissions are reported. Missing AAC encoding returns
`AUDIO_ENCODER_UNAVAILABLE` without an output. Requested sound is never silently
dropped. See [audio limits](audio-codecs.md).

`abox_video_timelapse` / `timelapse-video`: `.mp4` `output_path`, optional
`speed` (1.1–1000, default 10), `fps` (5, 10, 15, 24, 25 or 30; default 30),
`max_side` (16–1920, default 1280) and `quality` (`medium` default).
Selects source frames for the faster timeline and requires at least two planned
output frames. Sound and source metadata are omitted.

## Make a GIF or bake rotation

`abox_video_to_gif` / `video-to-gif`: `.gif` `output_path`, optional
`start_seconds:0`, `end_seconds` (omitted means source end), `fps` (1–50,
default 10), `max_side` (16–960, default 480), `colors` (4–255, default 255),
`dither:true` and `loop:true`. The range must fit the source. At most 200 sampled
frames, 16 million combined frame pixels and 32 MiB output are admitted.
Palette-quantized composited frames and total delays are verified; identical
frames can merge. Palette colors and centisecond timing are lossy. Sound is
omitted.

`abox_video_rotate_bake` / `bake-video-rotation`: `.mp4` `output_path`, optional
`degrees` (90 default, 180 or 270 clockwise), `max_side` (16–1920, default 1920)
and `keep_audio:true`. Applies the source display orientation and the additional
turn to decoded pixels, then emits an identity display matrix. Supported AAC
sound is copied exactly when requested. Re-encoding can change color and detail.

For rotation without video decoding/re-encoding, use `abox_video_rotate`
instead; it changes only the display matrix and requires a player that honors
it. The [packet-copy routes](media-and-documents.md#audio-and-video) have wider
container-copy limits. Neither rotation, cropping nor trimming automatically
identifies every sensitive item or provides an anonymization guarantee.
