# Additional text formatting and conversion

All three routes read UTF-8 files and write new local files. They need no browser,
do not execute code, and never return file text or parser excerpts through MCP.
They use isolated cancellable workers with a two-minute limit. Existing output
files are refused and originals remain unchanged. Use the user's intended
language and transformation; do not infer sanitization or a lossless round trip.

## HTML, CSS and YAML formatting

`abox_code_format` / `format-code`: `input_path`, `output_path`, required
`language` (`html`, `css`, `yaml`); optional `indent` (`2` default, `4`, or
HTML/CSS-only `tab`) and HTML/CSS-only `minify` (default false).

Omit `minify` entirely for YAML, even when false. Omit `indent` when
`minify:true`. Output extensions match the selected language: `.html`/`.htm`,
`.css`, `.yaml`/`.yml`. Input is at most 2 MiB; output 16 MiB, depth 128 and
100000 syntax nodes. Output ends with a newline.

```json
{"input_path":"/absolute/path/site.css","output_path":"/absolute/path/site.min.css","language":"css","minify":true}
```

HTML formatting verifies a normalized tree and attributes and preserves exact
supported `script`, `style`, `pre` and `textarea` bodies. The source can change
ordinary inline whitespace or close omitted tags. Active markup and resource
URLs remain in the file: this is not sanitization, and opening the output in a
browser can execute its retained content. Do not preview or open it automatically.
`verified` does not prove equivalent browser rendering.

CSS formatting checks the supported parsed structure, quoted strings, escapes
and custom-property values. Minification can drop standalone comments. It does
not validate CSS properties or prove the same rendering. A case the source
printer would corrupt is refused; no stylesheet, imported resource or URL is
executed or fetched while formatting.

YAML uses the existing conservative single-document subset. Anchors, aliases,
explicit tags and multiple documents are refused. Comments, quoting, scalar
layout and numeric spelling can change; ordered values, duplicate keys and exact
normalized numeric tokens are checked. Unsupported printer results fail closed.
Prefer default indentation 2; do not silently change an explicit four-space
request when the source cannot preserve its value tree.

## XML and JSON mapping

`abox_xml_json` / `convert-xml-json`: `input_path`, `output_path`, required
`direction` (`xml-to-json`, `json-to-xml`); optional `indent` (`2` default,
`4`, `tab`). Output is `.json` or `.xml` for the chosen direction. Input is
at most 2 MiB, output 16 MiB, depth 128 and 100000 syntax nodes. A UTF-8 BOM
is accepted. DTDs and custom entities are refused; standard predefined entities
and valid numeric references work without external resource resolution.

This is the website's explicit lossy mapping. For example:

```xml
<order id="7"><item>one</item><item>two</item></order>
```

maps to:

```json
{"order":{"@id":"7","item":["one","two"]}}
```

XML attributes use `@`, repeated child names become arrays, and text alongside
children uses `#text`. Values are strings, with empty elements represented as
null. Comments, processing instructions and the relative order of mixed
text/child content can be lost. Do not describe this as semantic XML preservation.

JSON-to-XML always uses a fixed `<root>` element; top-level arrays use `item`.
JSON number tokens and booleans become XML text, while nulls and empty containers
can collapse to empty elements. Invalid element-name characters are replaced
with underscores. Duplicate JSON member names, sanitized-name collisions and
namespace-prefixed JSON names are refused rather than silently overwritten or
emitted unbound. The adapter verifies the source's exact mapping;
`verification.semantic_roundtrip` remains false and `lossy_mapping` true.

## Markdown to passive HTML

`abox_markdown_html` / `markdown-to-html`: only `input_path` and `output_path`
ending in `.html` or `.htm`. Uses the unchanged pure Markdown helper from the
website's sharing tool; it opens no sharing connection.

The dialect includes headings 1–6, bold/emphasis, inline and fenced code, flat
unordered/ordered lists, quotes, horizontal rules, and paragraph line breaks.
Tables, raw HTML and image rendering are unsupported; their syntax can remain
literal. Image syntax can become a literal `!` followed by a link, without
loading an image. An unclosed fence runs to the end of the input. There are no
style, theme or invented layout options.

The standalone output has fixed UTF-8 metadata, a restrictive CSP and no
scripts, styles, images or automatic resource requests. Only source HTTP(S)
and `mailto:` links become anchors; unsafe schemes remain text. Links remain
clickable in the saved file, but the adapter never opens them. Literal input
HTML is escaped. This passive output guarantee applies to this renderer, not
to the HTML formatter above.

Input is at most 1 MiB, 20000 lines and 32768 characters per line, with a
conservative 100000-node/16 MiB output preflight. CRLF and bare CR are normalized
to LF and an initial UTF-8 BOM is omitted. Unsupported controls and Unicode
line/paragraph separators are refused before the unchanged renderer runs.
Generated tag nesting, source text projection and every link destination are
checked independently. Malformed output from unusual delimiter combinations
is refused; verification does not claim browser rendering or full Markdown
compatibility. Return paths/counts, not the HTML or source text.
