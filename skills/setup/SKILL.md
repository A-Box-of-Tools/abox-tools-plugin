---
name: setup
description: Set up or diagnose the installed abox.tools local plugin when the user requests installation, runs plugin setup, or asks for help with missing dependencies or browser support.
---

# Set up abox.tools

Resolve the installed plugin root, two directories above this skill's directory.
The adapter CLI is `<plugin-root>/bin/abox.mjs` and the MCP entry point is
`<plugin-root>/bin/abox-mcp.mjs`. Quote paths containing spaces.

1. Check for the bundled executable at `<plugin-root>/runtime/node.exe` on
   Windows or `<plugin-root>/runtime/node` on macOS/Linux. If present, use that
   executable for every check. Release bundles already include dependencies;
   do not run npm or reinstall them.
2. Run the selected executable with the absolute CLI path and `doctor`:

   ```text
   <node-executable> <plugin-root>/bin/abox.mjs doctor
   ```

   Doctor checks pinned engine hashes and detects a local Edge, Chrome, or
   Chromium. If detection fails, choose an existing browser through
   `ABOX_BROWSER_PATH`, or explain that image compression needs a browser.
   PDF splitting and metadata removal do not. Do not silently download a browser
   or disable its sandbox.
3. If no bundled runtime exists, this is a source installation. Check that the
   host has Node.js 22.15 or later. If dependencies are already present, run
   `node <plugin-root>/bin/abox.mjs doctor` directly. Only for an explicit setup
   or dependency-repair request, run `npm ci --ignore-scripts` in that installed
   plugin root, using the host's normal permissions. This setup downloads npm
   packages. Then run doctor again. If Node is unavailable, recommend the release
   bundle rather than trying to install a system runtime automatically.
4. Perform checks in the actual installed copy when the host uses a plugin
   cache. Reconnect the abox MCP server or reload the local chat when setup is
   complete so the host discovers its tools.

For a host without plugin MCP configuration support, register the selected
executable with the absolute MCP entry-point path as its argument. The README
contains an example. Preserve unrelated host settings.

Report what doctor verified and any remaining missing prerequisite. Processing
file bytes stays local; the host receives paths and result summaries. Setup does
not process user files, submit a directory listing, or deploy the website.
