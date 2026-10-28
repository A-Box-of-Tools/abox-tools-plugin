The Official MCP Registry publishes metadata pointing to public release assets. It does not process user files or host this adapter.

The [v0.10.0 Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.10.0)
is active/latest with Abox Technologies as publisher and 66 file operations plus
capabilities. The exact HTTP 200 readback identifies the 187971902-byte universal
MCPB with SHA-256 `4a8838282318f9c0ef7eae1ee5f1f9740bbc61bdfd44fb64a418e7d00b0d3446`,
matching the public GitHub asset. The 26-asset release became public on
28 October 2026 at 14:57:18 UTC; Registry publication followed at
`2026-10-28T14:57:35.827538Z`. All native/universal platform checks, publication
and registration passed in the
[release workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40708603838).
The default Python installer downloaded and verified the actual public Windows
ZIP in an isolated cache. That cache passed all 66 operations and 67 MCP tools
with bundled Node.js 24.22.1, no capability absences, relocation and launch
without system Node. No local archive or rebuild supplied the proof. Public
Gemini CLI 0.65.0 installed v0.10.0 with 67 tools, the shared skill, bundled
runtime and a local operation. Public skills CLI 1.7.4 copied the 14-file skill
into an isolated project/home and checked its installer contract offline without
installing an adapter offline. The actual adapter download/full MCP proof is
separate. These checks passed on 28 October 2026; see
[publication evidence](../docs/publishing.md#v0100-publication-evidence).

`server.template.json` deliberately has no version, package URL, or checksum. It is not a ready-to-publish registry record. `scripts/prepare-registry.mjs` adds those fields only after streaming and hashing the exact public `abox-tools-<version>-universal.mcpb` asset and checking its release checksum. The four native v0.2.0 bundles do not meet that requirement.

The first registered release was v0.2.1. Historically, the [v0.9.0 Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.A-Box-of-Tools%2Fabox-tools/versions/0.9.0) was verified active/latest on 27 October 2026, with Abox Technologies as publisher and 55 local file operations plus one capabilities tool. Its [release and registration workflow](https://github.com/A-Box-of-Tools/abox-tools-plugin/actions/runs/40578848781) passed, including all four native and universal platform checks. Public readback confirmed the 173934646-byte universal MCPB's SHA-256 as `5cf3ae701b5aa0e84d21ab7c40cca4de7d280272e9038338c9d6f1943ddef595`, matching the GitHub release asset. The 26-asset release became public on 27 October 2026 at 20:41 UTC.

All four v0.9.0 native CI jobs passed packaged Gemini and offline skill checks; the copied skill has ten files. The default Python installer downloaded and verified the actual public Windows ZIP. All 55 operations/56 MCP tools passed against that isolated cache using Node.js 24.22.1, including relocation, installation links and launch without system Node, without a local rebuild. Public Gemini CLI 0.65.0 installed v0.9.0 with 56 tools, its shared skill, bundled runtime and a local operation. Public skills CLI 1.7.4 copied the ten-file skill into an isolated project/home and validated its installer contract offline without installing an adapter offline. That skill-only check is separate from the actual public Python download. These checks passed on 27 October 2026. Historical v0.8.0 checks also verified the public Windows download, all 31 operations and public Gemini installation. See [publication evidence](../docs/publishing.md) for the separate current and historical receipts, including v0.8.0 source, workflow and artifact hashes.

Tagged releases call the reusable workflow after release publication. To recover an interrupted registration, run “Publish to the Official MCP Registry” from `main` with the already public release tag. The job uses the organization repository's GitHub Actions identity; no registry PAT or user configuration change is needed. It refuses to replace a version whose metadata differs from the current template, so publish identity or metadata changes with a new release version.

The workflow skips an exact registry version that already has matching metadata and fails if the existing metadata differs. After publishing, it reads the exact public record back. The canonical name is `io.github.A-Box-of-Tools/abox-tools`; its organization casing must match GitHub's OIDC claim.

The publisher is pinned to official mcp-publisher v1.8.4. Its Linux x64 archive must match both the reviewed hash in the installer and the official release checksum file before extraction or execution. Updating it requires reviewing a new official archive hash.
