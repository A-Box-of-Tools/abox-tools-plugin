# Publishing and MCP registration

The [public repository](https://github.com/A-Box-of-Tools/abox-tools-plugin) and
its [GitHub Releases](https://github.com/A-Box-of-Tools/abox-tools-plugin/releases)
are the distribution source. A GitHub Release does not register an MCP server or
create an OpenAI or Claude directory listing. The routes below were checked
against primary documentation on 25 October 2026.

| Route | What it distributes | Next step |
| --- | --- | --- |
| GitHub Release + local marketplace | Full Codex plugin, skill, local adapter, runtime, dependencies | Share the release ZIP; users open `START-HERE.html` and install through the app. |
| OpenAI public directory | Reviewed desktop plugin in ChatGPT/Codex | Confirm local-MCP submission eligibility, then submit the package. |
| Claude desktop extensions | Local MCP tools through `.mcpb` | Share release artifacts directly or submit a desktop extension for review. |
| Official MCP Registry | Discoverable metadata pointing to installable artifacts or remote servers | Publish a namespaced `server.json` after artifacts are available. |

## GitHub and Codex

The ZIP contains `.agents/plugins/marketplace.json` with a local source pointing
at the bundle root. `START-HERE.html` and the OS launcher open the documented
`codex://plugins/abox-tools?marketplacePath=...` detail page using the encoded
absolute marketplace-file path. The user selects Install in the app. Keep the
extracted folder available for later refresh. See the official
[OpenAI deep-link reference](https://learn.chatgpt.com/docs/app/commands) and
[marketplace packaging guide](https://developers.openai.com/plugins/build/plugins).

For a release, update version metadata consistently and push its `v*` tag. The
release workflow tests and packages the four OS/architecture targets and uploads
ZIPs, MCPBs, and checksums. Users of custom packages download and install updates
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

The `.mcpb` artifacts are desktop extensions with the local adapter, bundled
Node, and production dependencies. They expose MCP tools; they do not install
the portable Codex skill. First verify installation through the Claude Desktop
interface as well as the protocol-level checks.

For directory discovery, use the **desktop extension submission form** linked
from [Claude's local MCP documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
That documentation distinguishes desktop extension submissions from plugin and
remote-connector submissions. Sharing a custom MCPB directly needs no directory
listing; users install updated custom MCPB files manually.

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

This is a template, not a ready submission. Use real immutable URLs and hashes,
and include only supported packages. The artifact URL must contain `mcp`; the
`.mcpb` extension satisfies that rule. See
[supported Registry package types](https://modelcontextprotocol.io/registry/package-types).

Create `server.json` using the current Registry schema, choose an available
namespace matching your verified GitHub account/organization or domain, and
authenticate with `mcp-publisher`. Publish only after the referenced artifacts
exist. GitHub-backed names use `io.github.<account-or-organization>/<server>`;
domain authentication supports a reverse-domain namespace. See the official
[publishing quickstart](https://modelcontextprotocol.io/registry/quickstart) and
[authentication guide](https://modelcontextprotocol.io/registry/authentication).
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
