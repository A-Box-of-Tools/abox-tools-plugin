# Use abox.tools in Cursor

The v0.4.0 release includes a native ZIP for Windows x64, Linux x64,
macOS Apple silicon and macOS Intel. Download
the ZIP matching your computer, extract it to a permanent folder, and open
`START-HERE.html`. Select **Install tools in Cursor** and review Cursor's
installation prompt. The link
configures the Node runtime and MCP server inside that extracted folder. Keep
the folder in place. Node.js, npm, Python and a source build are not required
for this route. Image processing, PDF compression and watermark rendering need an installed Edge, Chrome or
Chromium browser.

The Git repository also contains a Cursor plugin manifest at
`.cursor-plugin/plugin.json`. It explicitly selects `cursor-mcp.json`; the
root `mcp.json` remains the Codex configuration. Cursor's plugin root variable
is `${CURSOR_PLUGIN_ROOT}`. Cursor does not expand `${PLUGIN_ROOT}`.

A source or Marketplace install requires Node.js 22.15 or newer on PATH. No
built-in Cursor Node runtime is assumed. Run the shared `abox-local-files`
setup skill once to install the adapter for this plugin version. That setup
uses Python 3 and the standard library, downloads the matching published
native ZIP, and verifies its release checksum. A new plugin version needs its
matching adapter version.

To install the skill separately, use
`npx skills add A-Box-of-Tools/abox-tools-plugin --skill abox-local-files`
and select Cursor. The current skills CLI requires Node.js 22.20 or newer;
its installation requirement is separate from the adapter's runtime minimum.
The skill's first adapter setup needs Python 3 and network access to the
published GitHub release. Processing local files after setup stays local.

The source launcher verifies the installed file inventory and hashes before
starting the cached bundled runtime. Missing or changed files produce a setup
error. It performs no downloads while tools process files. The default cache
is `~/.abox-tools/adapters/<version>/<platform>-<arch>/`. An explicit absolute
`--adapter-root` is available for a deliberately configured installation.

Installing the MCP link adds the file tools. Installing the Cursor plugin also
provides the shared workflow skills. Marketplace review and installation in
Cursor are separate from protocol tests; follow the status in
`directory-submissions.md` for publication details.

The Cursor Marketplace application was submitted on 26 October 2026, with
**Abox Technologies** as the organization and **abox-tools** as the accepted
handle. Cursor acknowledged receipt; review is pending. A live Marketplace
listing has not been confirmed.

Cursor documents [plugin components and root variables](https://cursor.com/docs/reference/plugins),
[local MCP commands](https://cursor.com/docs/mcp), and
[MCP install links](https://cursor.com/docs/mcp/install-links).
The [skills CLI installation reference](https://github.com/vercel-labs/skills#install-a-skill)
documents its own Node.js prerequisite.
