# Privacy notice for the abox.tools local plugin

Effective 25 October 2026.

The abox.tools local plugin processes images and PDFs on the computer where its
MCP server runs. The adapter has no hosted processing service, analytics,
telemetry, account system, or API key. It does not upload file contents to
abox.tools or another processing service.

## Data used for an operation

The agent supplies absolute input and output paths and operation settings. The
adapter reads the selected local file, processes its bytes in memory, and writes
new local outputs. It refuses to overwrite existing outputs. A large PDF split
also creates a local manifest listing the output files and source page numbers.

The MCP response contains paths, operation settings and results such as file
sizes, page counts, image dimensions, verification status, and error messages.
File bytes are not returned in MCP responses. The adapter does not maintain a
separate upload, user database, or processing history.

Image compression starts an installed browser using an isolated offline context
and bundled processing modules. PDF splitting and metadata removal run in the
local Node process. Compression does not require visiting the abox.tools site.
The plugin does not download a browser or processing dependencies during an
operation.

## The agent host and downloads

Your agent application receives tool arguments and results, including file
paths. Its handling of chat content, tool logs, retention, and cloud model calls
is governed by that application's settings and privacy policy. This plugin
cannot control content the user or agent independently shares with that host.

Downloading the plugin or a browser uses the download provider's network
service. GitHub hosts this repository and its release downloads. A directory or
agent application may separately check for updates. These setup activities are
separate from the adapter's local file processing.

## Metadata removal

Metadata removal removes supported image metadata and checks the resulting
container. It retains orientation and ICC color profiles by default. Removing
metadata does not make visible content anonymous or guarantee that every image
format or application-specific field has been removed.

## Questions and support

Use the [project issue tracker](https://github.com/A-Box-of-Tools/abox-tools-plugin/issues)
for questions. Issues are public: describe the problem without attaching private
documents, photos, paths, or other sensitive information. The plugin's software
license and warranty terms are in [LICENSE](LICENSE).
