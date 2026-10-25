# Reused code

The processing engines under `vendor/abox/` come from
[A Box of Tools](https://github.com/A-Box-of-Tools/website), Copyright (c) 2026
A Box of Tools, under the MIT license included at `vendor/abox/LICENSE`.
`vendor/abox/provenance.json` records the exact source commit and SHA-256 of
every copied file. The source modules are unchanged. Small generated re-export
modules resolve the website build's `./shared/` imports to one shared copy.
The plugin icon is the existing Image Compressor icon from that checkout.

The adapter uses the official Model Context Protocol TypeScript SDK, Zod, and
Playwright Core. Their licenses and exact versions travel with installed npm
packages and are pinned by `package-lock.json`. Browser binaries are not
bundled or downloaded by this package.

Release archives also include an official Node.js executable. Its complete
license and third-party notices are at `runtime/LICENSE` inside each archive.
The official MCPB validator is used only to build and check releases; it is not
required when running the packaged adapter.
