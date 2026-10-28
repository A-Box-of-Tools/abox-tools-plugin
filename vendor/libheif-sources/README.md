# HEIC library source and replacement

The unchanged website binary is
`../abox/tools/heic-to-jpg/vendor/libheif.js`, SHA-256
`793b36c913689784b2bfba60456fd87c14ed49e2d13f3b4d2611baaf05148f81`.
The complete LGPL-3.0 text is beside it as `LICENSE`. This combined work uses
the library through its published JavaScript API. The adapter's own code is MIT;
the codec and its source retain their original licenses. Nothing here restricts
modification, replacement or reverse engineering to debug library modifications.

Four archives included in this directory provide the exact corresponding source
and the build/distribution scripts used by libheif-js 1.19.8. `SOURCES.json`
records URLs and SHA-256 checksums; `npm run verify-vendor` checks every archive.

| Archive | Version / contents | License location inside archive |
|---|---|---|
| libheif.tar.gz | libheif commit 5e9deb19fe6b3768af0bb8e9e5e8438b15171bf3 | COPYING and component license files |
| libde265-1.0.15.tar.gz | libde265 1.0.15 source release | COPYING and component license files |
| libheif-emscripten.tar.gz | wrapper tag v1.19.8, CI workflow and distribution script | preserves upstream component licenses |
| libheif-js.tar.gz | npm wrapper tag 1.19.8, install/bundling scripts | LICENSE |

To rebuild on Linux, unpack the wrapper archive and unpack libheif into its
`libheif/` subdirectory (replace its submodule placeholder). The included
`.github/workflows/emscripten.yml` is the authoritative build recipe: Ubuntu
22.04, Emscripten 3.1.61, `libheif/scripts/install-ci-linux.sh`,
`libheif/scripts/prepare-ci.sh`, then `libheif/scripts/run-ci.sh` with its
`USE_WASM=0` replaced by `USE_WASM=1 USE_UNSAFE_EVAL=0`. Supply the included
libde265 source archive where `libheif/build-emscripten.sh` expects
`libde265-1.0.15.tar.gz`; that script records all configure/compiler/link flags.
Its defaults enable libde265, disable AOM, disable multithreading and plugin
loading, and compile a modular WebAssembly library. Run the wrapper's
`dist-prep.sh wasm`. The libheif-js archive's scripts embed the resulting WASM
binary into `libheif-wasm/libheif-bundle.js` without changing the library API.
General-purpose compiler/build tools are separate prerequisites.

To use a modified library, close the adapter, back up
`vendor/abox/tools/heic-to-jpg/vendor/libheif.js`, and replace it with your
compatible `libheif-bundle.js`. Start the adapter again; no signing key,
integrity lock or remote service blocks replacement. `doctor` will truthfully
report that this installation differs from the recorded official binary;
conversion itself does not enforce the original hash. The bounded HEIF
admission wrapper remains in `src/heif-admission.mjs`. For changes to its API,
adapt `src/heif-convert.mjs` and the website wrapper as needed in your copy.

All these files travel with the downloadable plugin. No written offer or
future server availability is needed to obtain the corresponding source.
