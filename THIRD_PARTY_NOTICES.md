# Reused code

The processing engines under `vendor/abox/` come from
[A Box of Tools](https://github.com/A-Box-of-Tools/website), Copyright (c) 2026
A Box of Tools, under the MIT license included at `vendor/abox/LICENSE`, except
for the separately licensed wordlists, artwork and OCR components described below.
`vendor/abox/provenance.json` records the exact source commit and SHA-256 of
every copied file. The source modules are unchanged. Small generated re-export
modules resolve the website build's `./shared/` imports to one shared copy.
The plugin icon is the existing Image Compressor icon from that checkout.

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

The adapter uses the official Model Context Protocol TypeScript SDK, Zod, and
Playwright Core. Their licenses and exact versions travel with installed npm
packages and are pinned by `package-lock.json`. Browser binaries are not
bundled or downloaded by this package.

Release archives also include an official Node.js executable. Its complete
license and third-party notices are at `runtime/LICENSE` inside each archive.
The official MCPB validator is used only to build and check releases; it is not
required when running the packaged adapter.
