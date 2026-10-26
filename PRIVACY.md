# Privacy notice for the abox.tools local plugin

Effective 25 October 2026.

The abox.tools local plugin processes images, PDFs and file checksums on the computer where its
MCP server runs. The adapter has no hosted processing service, analytics,
telemetry, account system, or API key. It does not upload file contents to
abox.tools or another processing service.

## Data used for an operation

The agent supplies absolute input and output paths and operation settings. The
adapter reads the selected local file, processes its bytes in memory, and writes
new local outputs. It refuses to overwrite existing outputs. A large PDF split
also creates a local manifest listing the output files and source page numbers.

The MCP response contains paths, operation settings and results such as file
sizes, page counts, image dimensions, metadata inventory counts, checksum digests,
verification status, and error messages. Metadata inspection does not return tag values.
File bytes are not returned in MCP responses. The adapter does not maintain a
separate upload, user database, or processing history.

Image processing, images to PDF, PDF compression and watermark text rendering
use an installed browser with an isolated offline context and bundled modules.
PDF page operations, metadata operations and checksums run in the
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

The optional skills CLI is a separate distribution tool. Its default anonymous
installation telemetry helps skills.sh list skills; see its own privacy notice.
The included Python adapter installer downloads release archives and checksums
from GitHub and keeps a local integrity receipt. It uploads no user documents.

## Metadata removal

Metadata removal removes supported image metadata and checks the resulting
container. It retains orientation and ICC color profiles by default. Removing
metadata does not make visible content anonymous or guarantee that every image
format or application-specific field has been removed.

Images-to-PDF keep mode may embed original JPEG streams, including their metadata.
Remove image metadata before creating the PDF when a clean document is required.

PDF compression can remove standard PDF metadata, while embedded image metadata,
attachments, annotations and visible content may remain. PDF watermarking adds
an image overlay and does not remove or protect the original content.

## Questions and support

Use the [project issue tracker](https://github.com/A-Box-of-Tools/abox-tools-plugin/issues)
for questions. Issues are public: describe the problem without attaching private
documents, photos, paths, or other sensitive information. The plugin's software
license and warranty terms are in [LICENSE](LICENSE).
