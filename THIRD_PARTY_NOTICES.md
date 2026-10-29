# Reused code

The processing and live-session engines under `vendor/abox/` come from
[A Box of Tools](https://github.com/A-Box-of-Tools/website), Copyright (c) 2026
A Box of Tools, under the MIT license included at `vendor/abox/LICENSE`, except
for the separately licensed wordlists, artwork, OCR and HEIC components described below.
`vendor/abox/provenance.json` records the exact source commit and SHA-256 of
every copied file. The source modules are unchanged. Small generated re-export
modules resolve the website build's `./shared/` imports to one shared copy.
The plugin icon is the existing Image Compressor icon from that checkout.

The live companion reuses the website's MIT-licensed pairing, host-candidate
network filtering, text/file transfer, camera capture/session and voice-session
modules unchanged. Its WebSocket and WebRTC implementations are supplied by the
installed browser, rather than a downloaded runtime service library. The existing
abox.tools rendezvous is used only after explicit Start/Connect and receives
negotiation metadata; direct peer content is not relayed through it. Service use
is separate from redistributing the bundled code. See [Privacy](PRIVACY.md).

The long and short Dice-Generated Passphrase wordlists are by the
Electronic Frontier Foundation, from [EFF Dice-Generated Passphrases](https://www.eff.org/dice).
Their words are unchanged; the dice labels are omitted and the words are
embedded in a JavaScript module. Both lists were checked against EFF's current
official downloads on 27 October 2026. EFF's [current copyright policy](https://www.eff.org/copyright)
offers its original material under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The unchanged upstream header also records the earlier CC BY 3.0 US attribution.
The wordlists are not covered by this repository's MIT license. No EFF
endorsement is implied.

Height charts reuse the website's public-domain/CC0 people artwork by pitr,
Madeleine Price Ball, Ryan Kissinger/NIAID and OpenClipart-Vectors. The source
credits and modification notes are preserved in
`vendor/abox/tools/compare-heights/vendor/LICENSE.md`. The imported object-art
module also carries Phosphor Icons (MIT) and Google Material Symbols
(Apache 2.0), even when only people or a plain rectangle are selected. Its
credits and complete notices ship under
`vendor/abox/tools/compare-heights/vendor/objects/`.

Receipt OCR reuses the website's pinned Tesseract.js 6.0.1 worker,
Tesseract.js-core 6.0.0 LSTM WebAssembly and English language data, under
Apache 2.0. Exact source archives, hashes, the website's offline binary/model
wrappers, licenses and component notices are preserved under
`vendor/abox/tools/receipt-invoice-extractor/vendor/`. No engine or language
data is downloaded while a receipt is processed.

HEIC conversion includes unchanged libheif-js 1.19.8 with libheif and libde265,
under LGPL-3.0 and the component licenses in its complete corresponding source.
The binary and license are at `vendor/abox/tools/heic-to-jpg/vendor/`. Exact
source archives, build and replacement instructions, hashes and license locations
ship at `vendor/libheif-sources/`. They are included in every release archive;
the adapter never downloads a decoder while processing a photo. Recipients may
modify and replace this library, including for debugging those modifications.

PDF rasterization uses Mozilla PDF.js, Apache-2.0, pinned to pdfjs-dist 6.4.299.
Its unchanged JavaScript modules, bundled fonts, CMaps, license and notices ship
with the production dependency. It runs in the isolated offline browser; its
optional Node canvas bindings are not used or bundled. Redaction writes a fresh
lossless image-only PDF rather than preserving the input's object graph.

The adapter uses the official Model Context Protocol TypeScript SDK, Zod, and
Playwright Core. Their licenses and exact versions travel with installed npm
packages and are pinned by `package-lock.json`. Browser binaries are not
bundled or downloaded by this package.

Release archives also include an official Node.js executable. Its complete
license and third-party notices are at `runtime/LICENSE` inside each archive.
The official MCPB validator is used only to build and check releases; it is not
required when running the packaged adapter.
