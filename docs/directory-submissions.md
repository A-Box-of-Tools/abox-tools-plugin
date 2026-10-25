# Directory submission materials

These materials describe the local file-processing plugin. The website's
development catalogue MCP is a separate service and is not part of this listing.
Registration automation is documented in [Publishing](publishing.md).

## Listing copy

Display name: **abox.tools**

Publisher: **A Box of Tools**

Short description (29 characters): **Process local images and PDFs**

Category: **Productivity**

Description (43 words, within Claude's 50-word limit):

> Compress images to a target size, split PDFs by page or range, and remove image
> metadata using the existing abox.tools engines. Files are processed locally.
> Includes its runtime and dependencies. Image compression uses an installed
> Edge, Chrome, or Chromium browser. No account required.

Long description:

> Give your agent three reusable file tools: compress JPEG, PNG, and static WebP
> images to a byte target; split unencrypted PDFs into pages, batches, or ranges;
> and remove supported metadata from JPEG, PNG, and WebP images without
> re-encoding. The adapter processes files locally and returns output paths and
> concise verification results. It never overwrites existing outputs.
>
> The release includes Node and the server dependencies. Image compression needs
> an installed Edge, Chrome, or Chromium; the other operations do not. Metadata
> cleaning keeps orientation and color profiles by default. Input files are
> limited to 128 MiB. The Codex ZIP also includes a shared workflow skill. The
> MCPB installs the MCP tools in compatible desktop hosts.

## Public links and assets

- Repository: <https://github.com/A-Box-of-Tools/abox-tools-plugin>
- Releases: <https://github.com/A-Box-of-Tools/abox-tools-plugin/releases>
- Homepage: <https://abox.tools/>
- Documentation: <https://github.com/A-Box-of-Tools/abox-tools-plugin#readme>
- Support: <https://github.com/A-Box-of-Tools/abox-tools-plugin/issues>
- Privacy: <https://github.com/A-Box-of-Tools/abox-tools-plugin/blob/main/PRIVACY.md>
- Software license and warranty: <https://github.com/A-Box-of-Tools/abox-tools-plugin/blob/main/LICENSE>
- Icon: `assets/icon.png` in the repository and release bundle.
- Claude attachment: the release's single `abox-tools-<version>-universal.mcpb`.
- OpenAI attachment: the ZIP matching the reviewer's desktop platform. Ask the
  reviewing organization how to supply additional platform variants; the portal
  documentation does not establish automatic native selection from four ZIPs.

Contact details belong in the submission form, rather than this public file.
First-party ownership is represented by the organization-owned source engines,
the public repository, and the manifest author's organization profile.

## Reviewer scenarios

Use disposable synthetic images and unencrypted PDFs. Choose fresh absolute
output paths for every scenario; do not upload private sample files. The tests
and release smoke checks generate synthetic fixtures and verify outputs.

| Positive case | Request | Expected result |
| --- | --- | --- |
| Image size | Compress a large JPEG below 500,000 bytes to a new local path. | `verified: true`; report `fitted` and actual bytes honestly. Original remains unchanged. |
| PDF pages | Split a three-page PDF into individual pages. | Three new PDFs, each reopened and verified as one page. |
| PDF ranges | Extract `1-2` and `3` as separate PDFs from a three-page input. | Two new PDFs with two and one pages respectively. |
| Default metadata | Remove image metadata while preserving appearance. | Verified clean copy; orientation and ICC may remain, and the result describes that. |
| Strict metadata | Remove supported metadata with `keep_orientation: false` and `keep_icc: false`. | New verified copy; supported orientation and ICC fields removed. |

| Negative case | Request | Expected result |
| --- | --- | --- |
| Remote file | Process an HTTPS URL as `input_path`. | Reject the URL; require an absolute local path. No download. |
| Existing output | Save into a file that already exists. | Reject with no overwrite; input and existing output remain unchanged. |
| Encrypted PDF | Split an encrypted PDF. | Refuse the unsupported input; explain that an unencrypted PDF is needed. |

Before a directory submission, verify installation in the actual target desktop
application, exercise the main workflows there, and record the demo requested
by its review team. Protocol smoke checks do not establish a completed desktop
installation or replace that recording.

## Submission status and access

Checked 25 October 2026: version 0.2.1 is active in the Official MCP Registry;
Claude's desktop extension form confirmed receipt of the universal MCPB
submission and is awaiting review. The extension is installed and Running in
Claude Desktop on Windows. OpenAI remains pending local-MCP partner approval.

The Official MCP Registry workflow publishes metadata only after the release is
public and its universal MCPB has passed all four native smoke checks. A
successful workflow and a readable Registry record confirm publication.

Claude's [desktop extension form](https://clau.de/desktop-extention-submission)
requires a Google-account identity, contact information, one MCPB upload, and
agreement to the Directory Terms. Preparing an artifact does not mean it has
been submitted or approved.

OpenAI's [desktop-only submission guide](https://developers.openai.com/plugins/deploy/desktop-only)
requires representative-confirmed allowlisting for local MCP. The publisher
must first supply the organization ID from the
[organization settings](https://platform.openai.com/settings/organization/general)
to its OpenAI representative. Then use the
[plugin portal](https://platform.openai.com/plugins), with verified identity and
the required publishing role. Do not submit a skills-only package that silently
omits these MCP tools.
