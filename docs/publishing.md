# Publishing and MCP registration

The [public repository](https://github.com/A-Box-of-Tools/abox-tools-plugin) and
its [GitHub Releases](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases)
are the distribution source. A GitHub Release does not register an MCP server or
create an OpenAI or Claude directory listing. The routes below were checked
against primary documentation on 25 October 2026.

## v0.11.0 publication evidence

The public v0.11.0 tag identifies clean source
[ff422ea](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/ff422ea7509d4195097691a94e7f992b811661ba).
It provides 66 offline file operations and six opt-in live controls, plus
capabilities: 72 operations and 73 MCP tools. The
[release workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40875056617)
and [source verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40875056519)
passed. Source verification completed on both Ubuntu and Windows, including
257 core checks, 104 browser checks and skill validation. All 11 release jobs
passed: four native targets, universal assembly, four universal launch targets,
publication and registration. The 26-asset nondraft release became public on
29 October 2026 at 12:54:07 UTC.

All four native and all four universal structured summaries reported 73 tools,
all eight passive companion roles, zero unrequested pairing/capture and no
capability absences. Windows and Linux used Node.js 24.22.1, macOS Apple silicon
24.21.0, and macOS Intel 24.19.0 for both native and universal checks.

The public universal MCPB is 188067956 bytes with SHA-256
`a8a2ab86d1c88e63ae46c2ddc131004fdbba722ed6187a8b5f5d7aa30bc545a8`.
The exact [v0.11.0 Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.11.0)
returned HTTP 200, active/latest status, Abox Technologies as publisher and that
matching universal hash. Its publication/status-change timestamp is
`2026-10-29T12:54:21.617466Z`.

The public Windows ZIP is 63909230 bytes with SHA-256
`fc1a160ae42ec1b2d98a3258eb53f41c6120ec1e700b627902508259726ce671`.
The default Python installer downloaded that actual public ZIP without a local
archive argument, verified its digest and installed an isolated Windows x64
cache. Its clean `BUNDLE` identifies tagged source `ff422ea` and Node.js 24.22.1;
the runtime hash is
`d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`.
The relocated actual public cache passed all 66 file operations over MCP,
73-tool registration, all eight passive UI roles, zero unrequested pairing/capture
and no capability absences. No local rebuild supplied that public-download evidence.
A separate Windows desktop MCP check used that same public cache to invoke all
four real visible-window open commands, status and stop. Each window remained
idle with zero peers and capture set to none, and all windows closed successfully.
Together these checks exercise all 72 operations; no device access was granted.

Public Gemini CLI 0.65.0 installed the GitHub repository at `--ref v0.11.0` and
reported version 0.11.0, 73 tools, the shared skill, bundled runtime selection
and a successful local file operation. Public skills CLI 1.7.4 copied the
`abox-local-files` skill from `A-Box-of-Tools/abox-tools-plugin`: adapter version
0.11.0 and 15 files in an isolated project. Its offline installer-contract check
passed without installing an adapter offline. This skill-copy proof is separate
from the default Python public download and full MCP-cache proof above.

Local validation passed 257 required core checks, 104 browser checks, the final
11-case media-controller group, five distribution and seven universal-package
checks, all 433 vendor-file hashes and both skill validators. A clean local
extracted preview using bundled Node.js 24.19.0 passed all 66 file operations,
73-tool registration and all eight passive companion roles without capability
absences. Its local preview Node runtime SHA-256 is
`3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`.
This is local preview evidence, separate from a public download.

All four integrations against the existing abox.tools pairing service passed
using two isolated browsers on the same computer. Share Text verified an exact
70,000-byte synthetic file and private-reader approval. Remote Camera verified
real RTP with a generated canvas stream, zero tracks before approval and
advancing video frames afterward. Walkie Talkie and Voice Oncall used synthetic
browser audio to verify push-to-talk transport and Stop cleanup. These checks
used no private user files or physical camera/microphone. They establish actual
pairing-service/direct-peer transport for those fixtures, rather than native
camera permission, physical-device compatibility or desktop-client installation.

Four additional interoperability cases passed against the current public
Share Text, Remote Camera, Walkie Talkie and Voice Oncall pages, which returned
HTTP 200. They verified private-reader approval, synthetic text and an exact
70,000-byte file, canvas-video RTP, generated/fake voice, push-to-talk and a
password-protected voice inbox. These used synthetic peers/media rather than
physical phones, native camera permission or a desktop MCP client's own
installation interface. Those manual validations remain unverified.

## v0.10.0 publication evidence

The following v0.10.0 receipts are retained as historical evidence.

The release tag identifies
[9a5a9c4](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/9a5a9c4a9c16170538364263102ffc85b03e0f23).
The runtime implementation is
[58dfd83](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/58dfd83ff08208a3ab638b43f9a1959d11b5200b);
the later commit changes only the nonbundled publication helper. This source
provides 66 file operations and one capabilities tool.

Local validation passed 222 core and 101 browser checks, all 407 vendor-file
hashes, the five- and seven-case Python groups and both skill validators. A local
extracted Windows archive passed all 66 operations and 67 MCP tools, including
the new image, audio, PDF, DICOM and video checks without capability absences.
That preview used bundled Node.js 24.19.0 and identified `58dfd83` in `BUNDLE`.
It is separate from the public-download receipt below.

[Source verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40706169571)
passed on Windows and Ubuntu for `58dfd83`. The tagged
[release workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40708603838)
and [tag verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40708603628)
passed for `9a5a9c4`, with final source verification on Windows and Ubuntu.
The release completed all four native builds, universal assembly, all four
universal launch checks, publication and registration. The public nondraft
release contains 26 assets and became available on 28 October 2026 at 14:57:18 UTC.
Structured summaries from all four native and all four universal jobs reported
67 MCP tools with no capability absences. Windows and Linux used Node.js 24.22.1,
macOS Apple silicon 24.21.0, and macOS Intel 24.19.0.

The universal MCPB is 187971902 bytes with SHA-256
`4a8838282318f9c0ef7eae1ee5f1f9740bbc61bdfd44fb64a418e7d00b0d3446`.
The exact [v0.10.0 Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.10.0)
returned HTTP 200 with active/latest status when checked on 28 October 2026,
Abox Technologies as publisher and that
same asset hash. Its publication timestamp is `2026-10-28T14:57:35.827538Z`.

The public Windows ZIP is 63806586 bytes with SHA-256
`96798c85085b4a020a4a6708abcc4d33f41af97e362238dbe287b5fb9ab6342e`.
The default Python installer downloaded this actual public package without a
local-archive argument, verified its checksum and installed it in an isolated
Windows x64 cache. Its clean bundle identifies tagged source `9a5a9c4` and
Node.js 24.22.1. Full MCP smoke against that actual public cache passed all
66 file operations and 67 MCP tools, including every new image, audio, PDF,
DICOM and video check without capability absences. Relocation and launch without
system Node passed as well. The default public downloader and SHA-verified
cache supplied this proof, with no local archive or rebuild.

On 28 October 2026, Gemini CLI 0.65.0 installed the actual public repository with
`--ref v0.10.0` and reported version 0.10.0, 67 MCP tools, the shared skill,
bundled runtime selection and a successful local file operation.

Public skills CLI 1.7.4 installed `abox-local-files` from
`A-Box-of-Tools/abox-tools-plugin`: adapter version 0.10.0, 14 copied files,
project scope and an isolated home, using CLI-default telemetry. The standalone
installer's offline contract check passed, without installing an adapter offline.
This skill-copy proof is separate from the default Python public download and
full 66-operation MCP check above. Publication, public installation and local
preview receipts therefore remain distinct.

## Historical v0.9.0 publication evidence

Version 0.9.0 was [registered in the Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.9.0),
with **Abox Technologies** as publisher. It provides 55 local file operations and
one capabilities tool. The public GitHub Release contains 26 assets. Native and
universal package checks, packaged Gemini CLI installation, skill discovery and
offline standalone adapter setup passed on all four platforms. The public
Registry readback was active/latest when checked on 27 October 2026 and agreed
with the universal MCPB's SHA-256.
The public v0.9.0 Windows download passed all 55 operations/56 MCP tools; public
Gemini installation and the ten-file skill installation also passed. Earlier
v0.8.0 receipts are retained below as history.
The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is live; Gemini's gallery crawler is enabled, with gallery listing unconfirmed. The initial 0.2.1 universal MCPB
was installed in Claude Desktop on Windows, where its server reported Running.
The Claude desktop extension form confirmed the publisher correction and current
0.3.0 review link on 25 October 2026; review remains pending. Google Forms retains
the original attachment when a response is edited, so the response directs
reviewers to the current public MCPB download. OpenAI directory submission remains
pending the publisher's local-MCP partner approval. Other distribution routes
are documented in [Platform support and publishing](platforms.md).

The tagged v0.9.0 source is
[9f06812](https://github.com/A-Box-of-Tools/abox-tools-plugin/commit/9f068120f51e0bba3ea91f3dd024ff9a312c7f9b).
Its [release and registration workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578848781)
and [source verification](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578847970)
passed. Source verification covered Ubuntu and Windows. Release checks completed
four native targets, universal assembly, four universal launch checks,
publication and registration. The 26-asset release became public on
27 October 2026 at 20:41 UTC.

The public universal MCPB is 173934646 bytes with SHA-256
`5cf3ae701b5aa0e84d21ab7c40cca4de7d280272e9038338c9d6f1943ddef595`;
the Registry readback on 27 October 2026 matched that asset. The public Windows ZIP
is 49920618 bytes and its published SHA-256 is
`4706f217fe1f67994d0c732b9d3d28555ce2817a5a48b388919578d92cab7b1d`.
The default Python installer downloaded that public Windows ZIP into an isolated
cache and verified the exact digest. Its bundle metadata matches tagged source
`9f068120f51e0bba3ea91f3dd024ff9a312c7f9b` with `dirty_source:false`.
Full release smoke checks against that downloaded cache passed all 55 operations,
56 MCP tools and 24 new routes without encoder absences, using bundled
Node.js 24.22.1. Relocation, installation links and launch without system Node
also passed. No local rebuild supplied this public-download evidence.

Local validation passed 198 core and 83 browser checks. All 55 file operations
and 56 MCP tools passed against an extracted native package using bundled
Node.js 24.19.0, without capability absences. All four native CI jobs passed
packaged Gemini installation and offline standalone-skill setup. The Linux CI
log confirms 56 MCP tools, 24 new operations, no encoder absences and the
ten-file skill installed through skills CLI 1.7.4. These are packaged CI/local
checks. The public Windows receipt is recorded above; public Gemini and skills
installation receipts are recorded below.

On 27 October 2026, Gemini CLI 0.65.0 installed the public repository release
with `--ref v0.9.0` and reported version 0.9.0. Its check passed with 56 tools,
the shared skill, bundled runtime selection and a local file operation.
Public skills CLI 1.7.4 separately copied the `abox-local-files` skill from
`A-Box-of-Tools/abox-tools-plugin`: adapter version 0.9.0 and ten files, installed
at project scope with an isolated home using the CLI defaults.
Its offline installer-contract check passed without installing an adapter
offline. The separate default Python public download and full 55-operation smoke
above establish actual adapter installation; the skill-only check is not used
as a substitute for that evidence.

## Historical v0.8.0 evidence

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

## Historical v0.7.0 evidence

Version 0.7.0 publication checks are recorded in its
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

## Public installation checks

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
