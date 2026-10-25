# Platform support and publishing

Publisher: **Abox Technologies**. Product: **abox.tools**.

The processing engines can be reused across clients. Each platform needs the
appropriate installation configuration and validation; the present Codex ZIP
and Claude MCPB are not automatically native packages for every other client.
The routes below were checked against primary documentation on 25 October 2026.

| Destination | Route for abox.tools | Work needed |
| --- | --- | --- |
| [Gemini CLI extension gallery](https://geminicli.com/docs/extensions/releasing/) | Package the local MCP server and shared skill as a Gemini extension. | Add a root `gemini-extension.json`, compatible platform archives, and the `gemini-cli-extension` GitHub topic. Google crawls tagged public repositories daily and validates them before listing. Our existing CI and runtimes can supply the archives. |
| [Vercel skills.sh](https://www.skills.sh/docs/faq) | Distribute the shared agent skill across supported agents. | Users install from the public repository through the skills CLI; installation telemetry drives directory listings. Skill installation alone does not install the local adapter, so its setup path must be clear and tested. |
| [Cursor Marketplace](https://cursor.com/docs/reference/plugins) | Submit the plugin repository for review. | Adapt the MCP launch configuration to Cursor's supported variables and test it. Cursor accepts root Agent Plugins manifests but does not expand `${PLUGIN_ROOT}`; it supports `${CURSOR_PLUGIN_ROOT}` instead. Submit the public repository at <https://cursor.com/marketplace/publish>. |
| [VS Code / Copilot](https://code.visualstudio.com/api/extension-guides/ai/mcp) | Connect the existing server over local stdio. | Supply an installation configuration or a small VS Code extension and validate the extracted runtime paths. A separate Marketplace extension is an optional distribution wrapper. |
| [Vercel v0](https://v0.app/docs/MCP) | Connect a hosted MCP service through a custom endpoint or Marketplace integration. | The separate public tool catalogue is a better match for this route. A hosted service cannot use a visitor's local file paths directly; moving the file processor into hosting would require a different data flow. |
| [Glama](https://glama.ai/mcp/faq) | Submit the open-source GitHub repository through Add MCP Server. | Meet its indexing and reproducible-build requirements. A directory listing and a hosted connector are separate choices; retain local execution for the file tools. See [indexing methodology](https://glama.ai/mcp/methodology). |

For the current local-file product, prioritize Gemini CLI, skills.sh, then
Cursor. Share the same engines, schemas and operation skill, with client-specific
packaging and release tests. Publishing on one platform does not constitute
approval or installation on another.

The website's development catalogue endpoint is not a production listing target.
Register or submit that service separately after a production rollout has been
authorized and verified. This plugin's release workflow does not deploy it.
