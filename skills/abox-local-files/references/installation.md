# Standalone skill setup

A skill installed with `npx skills add A-Box-of-Tools/abox-tools-plugin --skill abox-local-files`
includes these instructions and the setup script, but not the adapter runtime.
The skills CLI itself requires Node 22.20 or later. Installing the adapter below
requires Python 3.9 or later and does not require npm or a user-installed Node.

When the user asks to set up the skill or adapter, resolve `<skill-dir>` to the
directory containing this skill's `SKILL.md`. Run the local script, quoting paths:

```text
python <skill-dir>/scripts/install-adapter.py
```

Use `python3` where that is the Python command. Setup downloads the exact version
in `adapter-version.json` from the official GitHub release, checks its published
SHA-256, validates every ZIP path and entry type, and installs an included runtime
and dependencies under `~/.abox-tools/adapters/<version>/<platform>-<arch>`.
It writes no agent settings and uploads no local documents. The checksum checks
download integrity; it is distributed by the same publisher as the archive.

The JSON result supplies `adapter_root`, `node_executable`, `cli` and `mcp_entry`.
Use those absolute paths for subsequent CLI calls. Verify cached files without
network access with `python <skill-dir>/scripts/install-adapter.py --verify-only`.
Run the returned `node_executable` and `cli` with `doctor` to check browser setup.
Existing installations are verified and reused; changed caches cause an error.
Do not delete or replace a changed installation implicitly.

If Python is unavailable, download the matching native ZIP and its `.sha256`
from the pinned release, verify SHA-256 with an available system tool, and extract
the ZIP to a permanent directory using a trusted archive utility. Use that
directory's included `runtime/node.exe` or `runtime/node` and `bin/abox.mjs`.
This manual directory does not create the receipt required by the Cursor cache
launcher; use the bundled plugin or the Python installer for that integration.

For an offline setup, the script accepts absolute `--archive <zip>` and
`--checksum <sha256-file>` paths. `--cache-root <absolute-directory>` selects a
different cache without changing app configuration; keep the returned paths.

Rendering, WAV editing, receipt OCR and new video encoding need an installed
Edge, Chrome or Chromium. MP4 creation also needs its supported native H.264
encoder. Text, metadata, PDF security and video packet-copy routes do not need
the browser. No processing call downloads dependencies. Keep setup separate from the user's file operations;
when setup is missing, explain the next setup step instead of running npm.
