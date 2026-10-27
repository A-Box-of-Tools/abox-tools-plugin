# Additional distribution routes

Checked 27 October 2026. These routes distribute or describe the local adapter.
File processing must continue on the user's computer. A directory listing does
not establish installation, compatibility, or approval by an agent vendor.

The publisher is **Abox Technologies** and the preferred product handle is
`abox-tools`. Where a registry requires lowercase names, use
`aboxtechnologies`. Use `abox-local-tools` only if `abox-tools` is unavailable.
Existing releases, Registry publication, skills.sh and pending vendor reviews
are recorded in [directory submissions](directory-submissions.md) and
[platform support](platforms.md).

## VS Code installation from a native bundle

The native ZIP's `START-HERE.html` provides **Install tools in VS Code**. It
opens VS Code's installation screen with the extracted bundle's absolute Node
and server paths. This requires an installed VS Code with its URL handler;
the user reviews and approves the configuration in VS Code. Keep the extracted
folder in place. This adds the MCP tools, rather than installing a VSIX or a
shared skill.

The fallback launcher accepts `--client vscode`:

```sh
./runtime/node ./scripts/open-installer.mjs --client vscode
```

On Windows, use `runtime/node.exe`. The URL uses VS Code's documented
`vscode:mcp/install?<URL-encoded JSON>` form with `name`, `type: "stdio"`,
`command` and `args`. No publisher account, Marketplace upload, hosted server,
or additional runtime download is needed for this handoff. Generated-link
checks do not establish installation in the actual desktop application.
See the official [MCP installation URL guide](https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url)
and [configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Smithery: distribute the existing MCPB

Smithery's current [publishing documentation](https://smithery.ai/docs/build/publish)
accepts a prebuilt `.mcpb` for clients to download and run locally. Choose that
route, rather than its hosted or URL-proxy routes. The entry point is
[Publish MCP Server](https://smithery.ai/new), which requires sign-in.

Its documented CLI flow is:

```sh
smithery auth login
smithery mcp publish ./server.mcpb -n aboxtechnologies/abox-tools
```

Use a verified public release MCPB. The publishing CLI needs Node.js 20+ and an
owned namespace. [Namespace names](https://smithery.ai/docs/concepts/namespaces)
must be lowercase letters, digits and hyphens. The
[CLI reference](https://smithery.ai/docs/concepts/cli) describes authentication;
the [publish API](https://smithery.ai/docs/api-reference/servers/publish-a-server)
also supports multipart bundle uploads with publisher authentication.

The publisher sign-in was opened for the business account on 27 October 2026;
the owner chose to leave Smithery for later. No submission, account creation,
namespace claim or new access grant was completed. Public documentation
did not establish the maximum MCPB upload size, publishing fee, or complete
publisher terms. Check the authenticated publishing flow before uploading;
the [privacy notice](https://smithery.ai/privacy) covers account and submitted
server information. Publishing the adapter is separate from uploading user
files, which this adapter does not support.

## AgentSkillsDir: a free discovery listing

The [submission form](https://agentskillsdir.com/submit) accepts a public project
URL and category, with optional name, description and contact email. Its stated
requirements are public source or a published package, a pinnable commit, a
license or source terms, and working software. Review is manual and listing
is not guaranteed. No account, payment, or new execution service is needed.

Its [terms](https://agentskillsdir.com/terms) retain the publisher's rights and
say the directory does not execute listed resources. Its
[privacy policy](https://agentskillsdir.com/privacy) describes storing the
submission and a salted IP hash for review. The owner approved submission under
those terms. On 27 October 2026, the completed form was submitted for
`abox-tools`, with Abox Technologies in its description and the business contact.
The site returned **Resource submissions are currently closed.** No receipt or
listing was issued. Its public form remains visible despite that backend refusal;
do not describe the application as accepted or pending review.

## Existing indexing and lower-priority options

- **Glama already indexes this repository** at the
  [abox-tools listing](https://glama.ai/mcp/servers/A-Box-of-Tools/abox-tools-plugin).
  Its indexed snapshot can lag a release. Treat it as discovery and keep
  recommending local installation; the generic Deploy Server instructions are
  a different hosted execution route. Claiming an organization namespace can
  require installing Glama's GitHub App and granting organization permissions.
  See the [submission and ownership FAQ](https://glama.ai/mcp/faq). No ownership
  claim or additional permission grant was made.
- **SkillsMP** discovers `SKILL.md` in public GitHub repositories. Its
  [current guidance](https://skillsmp.com/agent-skills) guarantees neither
  inclusion nor a fixed sync schedule. An existing abox entry and a manual
  submission form were not confirmed; older promises of daily indexing should
  not be treated as current requirements.
- **Claude Code** can install from a GitHub marketplace without waiting for a
  directory review. This needs `.claude-plugin/marketplace.json`, compatible
  plugin metadata, and working runtime/dependency setup. It is separate from
  the Claude Desktop MCPB review. See [marketplace creation](https://code.claude.com/docs/en/plugin-marketplaces)
  and [distribution options](https://code.claude.com/docs/en/plugins/publish).
- **ClawHub** offers [skill publishing](https://clawhub.ai/skills/publish) and
  [GitHub import](https://clawhub.ai/import), with
  [GitHub sign-in and publisher authentication](https://raw.githubusercontent.com/openclaw/clawhub/main/docs/auth.md).
  Its current [skill format](https://raw.githubusercontent.com/openclaw/clawhub/main/docs/skill-format.md)
  requires MIT-0, permits redistribution without attribution, disallows
  per-skill license overrides, and limits skill bundles to 50 MB. Do not
  upload the existing MIT plugin and its dependencies unchanged. An adapted
  instruction skill would need a deliberate licensing decision. No account,
  submission, or license acceptance was made.
- **mcp.so** currently advertises a $39 one-time fee on its
  [submission form](https://mcp.so/submit?type=server). Free discovery and local
  installation routes take priority. No payment or submission was made.
- **PulseMCP** currently says **submissions and changes are temporarily paused**
  on its [submission page](https://www.pulsemcp.com/submit), verified directly
  in the browser on 27 October 2026. The notice is dated 3 September 2026 and
  gives no reopening date. It recommends the Official MCP Registry and says
  it will pick up those entries after reopening. This project already publishes
  there; no separate submission was possible or confirmed.
- **LobeHub** directs publishers to CLI self-service with Node 22+, LobeHub
  sign-in, a GitHub connection and repository ownership or push access. Its
  [maintainer instructions](https://github.com/lobehub/lobehub/issues/17492)
  link to the [publisher guide](https://lobehub.com/publish-mcp/skill.md),
  which returned HTTP 403 during research. Current fees, license conditions
  and the exact GitHub grant were not established. No CLI login, GitHub access
  grant or submission was made, and an existing abox listing was not confirmed.
