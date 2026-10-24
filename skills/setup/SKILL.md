---
name: setup
description: Set up or diagnose the installed abox.tools local plugin when the user asks to install it, runs plugin setup, or requests help with missing dependencies or browser support.
---

# Set up abox.tools

Resolve this skill's installed plugin root, two directories above this skill's
directory. The adapter is at `<plugin-root>/bin/abox-mcp.mjs` and its locked
dependencies are in `<plugin-root>/package-lock.json`.

1. Check Node.js is version 22.15 or later and npm is available.
2. From the installed plugin root, run `npm ci --ignore-scripts`. Installation
   downloads npm packages; processing files after setup does not need the network.
   Use the host's normal permission flow for dependency installation.
3. Run `npm run doctor` from that root. It checks the copied engine hashes and
   detects a local Edge, Chrome, or Chromium. Do not download a browser silently.
   If detection fails, use an existing installation via `ABOX_BROWSER_PATH` or
   explain that compression needs a browser. PDF and EXIF operations do not.
4. If the host copied the plugin to its installation cache, perform setup in that
   installed copy. Reconnect the abox MCP server or reload the local chat after
   setup so the host can discover its tools.

For a host without plugin MCP configuration support, register `node` with the
absolute path to `bin/abox-mcp.mjs` as its argument. See the root README for the
configuration example. Do not edit unrelated agent settings.

Report the successful setup and any remaining missing prerequisite. This skill
does not process user files or publish the plugin.
