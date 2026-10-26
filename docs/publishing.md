# Publishing and MCP registration

The [public repository](https://github.com/A-Box-of-Tools/abox-tools-plugin) and
its [GitHub Releases](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases)
are the distribution source. A GitHub Release does not register an MCP server or
create an OpenAI or Claude directory listing. The routes below were checked
against primary documentation on 25 October 2026.

Version 0.5.0 is [active in the Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.5.0),
with **Abox Technologies** as publisher. All fifteen operations passed native and
universal package checks on all four platforms. Gemini CLI installation, skill
discovery and offline standalone adapter setup also passed on all four platforms.
The public Gemini release install command and the skill's actual GitHub download
were verified on Windows after publication. The [skills.sh listing](https://www.skills.sh/a-box-of-tools/abox-tools-plugin/abox-local-files)
is live; Gemini's gallery crawler is enabled, with gallery listing unconfirmed. The initial 0.2.1 universal MCPB
was installed in Claude Desktop on Windows, where its server reported Running.
The Claude desktop extension form confirmed the publisher correction and current
0.3.0 review link on 25 October 2026; review remains pending. Google Forms retains
the original attachment when a response is edited, so the response directs
reviewers to the current public MCPB download. OpenAI directory submission remains
pending the publisher's local-MCP partner approval. Other distribution routes
are documented in [Platform support and publishing](platforms.md).

After publication, `npm run smoke:gemini -- --from-release` verifies the exact
public Gemini installation route in a disposable profile. `npm run smoke:skills`
checks the public shared-skill installation in an isolated project. Neither
changes the user's agent settings or processes private sample files.

| Route | What it distributes | Next step |
| --- | --- | --- |
| GitHub Release + local marketplace | Full Codex plugin, skill, local adapter, runtime, dependencies | Share the release ZIP; users open `START-HERE.html` and install through the app. |
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
