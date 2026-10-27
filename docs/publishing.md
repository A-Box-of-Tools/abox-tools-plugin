# Publishing and MCP registration

The [public repository](https://github.com/A-Box-of-Tools/abox-tools-plugin) and
its [GitHub Releases](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases)
are the distribution source. A GitHub Release does not register an MCP server or
create an OpenAI or Claude directory listing. The routes below were checked
against primary documentation on 25 October 2026.

Version 0.8.0 is [active in the Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.8.0),
with **Abox Technologies** as publisher. It provides 31 local file operations and
one capabilities tool. The public GitHub Release contains 26 assets. Native and
universal package checks, packaged Gemini CLI installation, skill discovery and
offline standalone adapter setup passed on all four platforms. The public
Registry record and GitHub asset agree on the universal MCPB's SHA-256.
The public Gemini release installation route and the skill's actual GitHub download
were verified on Windows for v0.8.0 on 27 October 2026.
The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is live; Gemini's gallery crawler is enabled, with gallery listing unconfirmed. The initial 0.2.1 universal MCPB
was installed in Claude Desktop on Windows, where its server reported Running.
The Claude desktop extension form confirmed the publisher correction and current
0.3.0 review link on 25 October 2026; review remains pending. Google Forms retains
the original attachment when a response is edited, so the response directs
reviewers to the current public MCPB download. OpenAI directory submission remains
pending the publisher's local-MCP partner approval. Other distribution routes
are documented in [Platform support and publishing](platforms.md).

The tagged v0.8.0 source is
[5d94af5](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/5d94af561ff2806e823d48de72e8a91d061f9bc2).
The [v0.8.0 release and registration workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40564806884)
and [source verification workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40564806976)
passed. Source verification covered Ubuntu and Windows; the release workflow
completed all four native targets, universal assembly, four universal launch
checks, publication and registration. The release was published on 27 October
2026. Local validation passed 121 core and 47 browser checks, and the shared-skill validator
passed. The public skills CLI 1.7.4 installed the v0.8.0 skill's six files and
passed its offline installer checks in an isolated directory.

The default Python installer fetched the public Windows ZIP and verified its
SHA-256 as `bf4c2711885ebdeb728ab8b3701249bcb21afa00ef643de60ac66f27ca1804a0`,
matching GitHub's digest, before installing it in an isolated cache. The release
smoke checks then exercised that downloaded and extracted bundle with bundled
Node.js 24.22.1: all 31 file operations and 32 MCP tools passed, together with
relocation and installation-link checks. No local rebuild supplied that evidence.
The public Gemini command with `--ref v0.8.0`, using Gemini CLI 0.65.0, also
passed on Windows with 32 tools, the shared skill, the bundled runtime and a
local file operation.

Version 0.8.0 adds GIF inspection and extraction, bitmap tracing, image stacking,
solid image redaction, and password/passphrase generation. Inspection reads GIF
headers without claiming pixel validation. Extracted PNGs, traced paths, stacked
images and opaque black redactions are checked before saving. Passwords use
cryptographic randomness and are written only to a new plaintext file; secret
values and their hashes are absent from tool results.

Historical v0.7.0 publication checks are recorded in its
[release workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40555454288)
and [source verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40555454149).
Its public Gemini installation and standalone skill download were checked on
Windows. One local Gemini CLI process exited with a Windows libuv assertion
after installation; a separate isolated recheck passed without changing security
settings or weakening any check.

Version 0.7.0 introduced YAML/JSON conversion, XML formatting, text comparison, image
data URIs, QR codes and barcodes. Structured text and text comparison use bounded
local workers. Code generation defaults to SVG without a browser; PNG output
uses the installed local browser. Payloads, patches and encoded image bytes are
written to local files, while MCP results contain paths and concise summaries.

Version 0.6.0 introduced the native bundle's VS Code installation link. URI decoding
and a real MCP connection verify its configuration; installation through VS
Code's desktop interface remains unverified. On 27 October 2026, AgentSkillsDir did not accept the
authorized submission attempt because resource submissions were closed.
Smithery remains a follow-up for the publisher.

After publication, `npm run smoke:gemini -- --from-release` verifies the exact
public Gemini installation route in a disposable profile. `npm run smoke:skills`
checks the public shared-skill installation in an isolated project. Neither
changes the user's agent settings or processes private sample files.

| Route | What it distributes | Next step |
| --- | --- | --- |
| GitHub Release + local marketplace | Full Codex plugin, skill, local adapter, runtime, dependencies | Share the release ZIP; users open `START-HERE.html` and install through the app. |
| Native Cursor / VS Code installation links | Local MCP tools using the extracted bundle's runtime | Select the app in `START-HERE.html`, review its configuration, and keep the folder in place. Shared skills are installed separately. |
| OpenAI public directory | Reviewed desktop plugin in ChatGPT/Codex | Confirm local-MCP submission eligibility, then submit the package. |
| Claude desktop extensions | Local MCP tools through `.mcpb` | Submit the universal MCPB using the prepared directory materials. |
| Official MCP Registry | Discoverable metadata pointing to the universal local MCPB | Tagged releases publish verified metadata automatically through GitHub Actions OIDC. |

## GitHub and Codex

The ZIP contains `.agents/plugins/marketplace.json` with a local source pointing
at the bundle root. `START-HERE.html` and the OS launcher open the documented
`codex://plugins/abox-tools?marketplacePath=...` detail page using the encoded
absolute marketplace-file path. The user selects Install in the app. Keep the
extracted folder available for later refresh. See the official
[OpenAI deep-link reference](https://learn.chatgpt.com/docs/app/commands) and
[marketplace packaging guide](https://developers.openai.com/plugins/build/plugins).

For a release, update version metadata consistently and push its `v*` tag. The
release workflow tests and packages the four OS/architecture targets, assembles
a universal MCPB, and tests its launch configuration on all four targets before
publishing ZIPs, MCPBs, and checksums. Users of custom packages download and install updates
manually. Keep the immutable versioned download URLs for registry metadata.

## OpenAI public directory

Local MCP submissions currently require an approved partner organization. Ask an
OpenAI representative to confirm eligibility and allowlist the submitting
organization before using the submission portal. After that, follow the
desktop-only ZIP submission route, complete identity and listing requirements,
and publish after review. Clean desktop installation and the main workflows
should be tested before submission. See
[Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only).

A remote MCP submission follows a different route and needs a stable public
HTTPS service, domain verification, and a tool scan. This local stdio adapter is
not such a service. See [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission).

## Claude Desktop

The universal `.mcpb` includes all four native runtimes and uses MCPB platform
overrides to launch the local adapter. Its macOS launcher selects the native
runtime for Apple silicon or Intel. Smaller native `.mcpb` files are also
available. They expose MCP tools; they do not install
the portable Codex skill. The 0.2.1 universal bundle has been installed through
Claude Desktop on Windows and its local server reports Running. Protocol checks
cover all four platforms; the macOS desktop interface has not been checked.

For directory discovery, use the [desktop extension submission form](https://clau.de/desktop-extention-submission) linked
from [Claude's local MCP documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
That documentation distinguishes desktop extension submissions from plugin and
remote-connector submissions. Sharing a custom MCPB directly needs no directory
listing; users install updated custom MCPB files manually. The form accepts one
MCPB, publisher contact details, a GitHub link and description, a recorded Google
identity, and acceptance of Anthropic's Directory Terms. See the prepared
[listing and reviewer scenarios](directory-submissions.md). Submission does not
guarantee acceptance or a review timeline.

## Official MCP Registry

The Registry stores metadata rather than hosting artifacts. It supports MCPBs
on GitHub or GitLab Releases, so this project does not need an npm publication
for that route. A local package entry uses:

```json
{
  "registryType": "mcpb",
  "identifier": "https://github.com/A-Box-of-Tools/abox-tools-plugin/releases/download/<tag>/<asset>.mcpb",
  "fileSha256": "<SHA-256 of that exact release artifact>",
  "transport": {"type": "stdio"}
}
```

The artifact URL must contain `mcp`; the
`.mcpb` extension satisfies that rule. See
[supported Registry package types](https://modelcontextprotocol.io/registry/package-types).

The canonical name is `io.github.A-Box-of-Tools/abox-tools`. The release workflow
calls `publish-mcp.yml` after publishing the GitHub Release. It downloads and
hashes that exact universal MCPB, compares its checksum and GitHub digest,
generates `server.json` from `registry/server.template.json`, and publishes using
a short-lived GitHub Actions identity token. No PAT, npm publication, DNS
change, or local publisher login is needed.

The official publisher is pinned to a reviewed version and SHA-256. A rerun
skips an identical active Registry version and refuses to replace different
metadata. The workflow then reads back the exact public record. It can also be
run from Actions using an already published release tag. See
[the registration runbook](../registry/README.md) and the official
[publishing quickstart](https://modelcontextprotocol.io/registry/quickstart) and
[authentication guide](https://modelcontextprotocol.io/registry/authentication).
The Registry schema has no standard OS/architecture package selector. The single
universal artifact avoids asking a client to choose among four native packages.
The Registry is currently in preview. Listing there does not itself grant an
OpenAI or Claude directory listing.

## Website catalogue MCP: a separate service

The website's development endpoint,
[`https://mcp-dev.abox.tools/mcp`](https://mcp-dev.abox.tools/mcp), exposes only
`find_browser_tools`. It searches public catalogue information by query, locale,
and limit, returning browser-tool links and an interactive catalogue. It accepts
no files or filenames and performs no file processing. Source:
[website `dev` catalogue worker](https://github.com/A-Box-of-Tools/website/tree/dev/workers/catalogue-mcp).

After a separately authorized production rollout, this catalogue could have its
own Registry entry using `remotes` with `type: "streamable-http"` and the actual
public endpoint. A public remote must be reachable at the registered URL. See
[Registry remote-server publishing](https://modelcontextprotocol.io/registry/remote-servers).
An OpenAI remote-directory submission would also need its own review.

The planned production catalogue is not configured, deployed, or advertised by
this plugin release. Keep the development endpoint out of production listings.
Register the local file processor as a stdio package, and the future catalogue
as a separate remote service so their capabilities and privacy claims stay clear.
