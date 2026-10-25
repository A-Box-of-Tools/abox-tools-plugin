The Official MCP Registry publishes metadata pointing to public release assets. It does not process user files or host this adapter.

`server.template.json` deliberately has no version, package URL, or checksum. It is not a ready-to-publish registry record. `scripts/prepare-registry.mjs` adds those fields only after streaming and hashing the exact public `abox-tools-<version>-universal.mcpb` asset and checking its release checksum. The four native v0.2.0 bundles do not meet that requirement.

The first intended registry release is v0.2.1. Once its universal bundle is public, run the “Publish to the Official MCP Registry” workflow from `main` with tag `v0.2.1`, or call that reusable workflow after the release job succeeds. The job uses the organization repository's GitHub Actions identity; no registry PAT or user configuration change is needed.

The workflow skips an exact registry version that already has matching metadata and fails if the existing metadata differs. After publishing, it reads the exact public record back. The canonical name is `io.github.A-Box-of-Tools/abox-tools`; its organization casing must match GitHub's OIDC claim.

The publisher is pinned to official mcp-publisher v1.8.4. Its Linux x64 archive must match both the reviewed hash in the installer and the official release checksum file before extraction or execution. Updating it requires reviewing a new official archive hash.
