# Working on the local adapter

This repository packages thirty-one abox.tools operations for local agents. Runtime
processing must accept filesystem paths and write local files without a hosted
service, analytics, API key, or dependency download. Dependency installation is
a separate setup step. Existing outputs are never overwritten.

The original engines live in `vendor/abox/`. Do not edit those copies by hand.
Run `npm run sync-upstream -- --source /absolute/path/to/website` from a clean
website checkout, review the vendor diff, and keep its MIT license. Provenance
records source commits and file hashes. The generated shared-import bridges
preserve the original source modules unchanged.

Node.js 22.15 or later is required. Use `npm ci --ignore-scripts`, then run
`npm test`, `npm run test:browser`, and `npm run doctor` for an adapter change.
Browser tests need an installed Edge, Chrome, or Chromium. These are this
repository's own focused tests; there is no reason to run the website suites.

Keep the plugin manifest, package version, MCP tools, shared skill, and README
consistent. The operation skill should route to the existing tools, report
verification fields, and keep file bytes out of model context. A missed image
target is an explicit result, not a successful fit. Default EXIF cleaning may
retain orientation and ICC; never describe it as removing every byte of metadata.

Stage explicit paths. Do not commit node_modules, test outputs, or user files.

Release packages include the current runner's Node binary, its license, and the
locked production dependencies. `npm run package:release` builds one platform;
`npm run smoke:release` exercises its extracted copy without system Node or npm.
Use a fresh ignored `_release/` and `release/` for each build. The builder refuses
to overwrite previous outputs. GitHub Actions builds each supported platform
and publishes all verified assets only for a matching version tag. Do not upload
a local dirty-worktree build as a release.
