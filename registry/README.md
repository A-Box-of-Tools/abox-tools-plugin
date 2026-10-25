The Official MCP Registry publishes metadata pointing to public release assets. It does not process user files or host this adapter.

`server.template.json` deliberately has no version, package URL, or checksum. It is not a ready-to-publish registry record. `scripts/prepare-registry.mjs` adds those fields only after streaming and hashing the exact public `abox-tools-<version>-universal.mcpb` asset and checking its release checksum. The four native v0.2.0 bundles do not meet that requirement.

The first registered release was v0.2.1; v0.4.0 is now published with Abox Technologies as publisher. Tagged releases call the reusable workflow after release publication. To recover an interrupted registration, run “Publish to the Official MCP Registry” from `main` with the already public release tag. The job uses the organization repository's GitHub Actions identity; no registry PAT or user configuration change is needed. It refuses to replace a version whose metadata differs from the current template, so publish identity or metadata changes with a new release version.

The workflow skips an exact registry version that already has matching metadata and fails if the existing metadata differs. After publishing, it reads the exact public record back. The canonical name is `io.github.A-Box-of-Tools/abox-tools`; its organization casing must match GitHub's OIDC claim.

The publisher is pinned to official mcp-publisher v1.8.4. Its Linux x64 archive must match both the reviewed hash in the installer and the official release checksum file before extraction or execution. Updating it requires reviewing a new official archive hash.
