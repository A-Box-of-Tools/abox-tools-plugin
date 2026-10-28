# Original media fixtures

`abox-synthetic.aac` contains original synthetic stereo tones: 8192 input frames at 48 kHz, with 440 Hz on the left and 220 Hz on the right, encoded as AAC-LC by an installed browser. Codec priming and padding can add encoded frames. `tests/audio-codec-fixtures.mjs` records the generator and can create a new file explicitly with `--write`; ordinary tests use the checked-in bytes and do not download a recording or require an encoder.

The MP3 silence used by the audio tests is constructed from ordinary Layer III frame headers, empty Huffman data and zero side information. It contains no external recording.
