import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderMarkdown, MAX_MARKDOWN_INPUT_BYTES, MAX_MARKDOWN_LINE_LENGTH, MAX_MARKDOWN_LINES } from '../src/markdown-html.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-markdown-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const bodyOf = html => {
  const match = /<body>([\s\S]*)<\/body>/.exec(html); assert.ok(match); return match[1];
};
async function render(t, text, name = 'document.html') {
  const directory = await workspace(t), input = path.join(directory, 'private.md'), output = path.join(directory, name);
  const original = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'); await writeFile(input, original);
  const result = await renderMarkdown({ input_path: input, output_path: output });
  assert.equal(hash(await readFile(input)), hash(original));
  return { result, html: await readFile(output, 'utf8'), input, output, directory };
}

test('Markdown reuses the limited dialect while independently retaining visible block content and safe links', async t => {
  const input = '# Heading **bold**\n\nA *small* note & <raw>\nsecond `x < y` line.\n\n'
    + '- first\n- **second**\n\n3. third\n4) fourth\n\n> quoted\n> `literal **`\n\n---\n'
    + '```js\nif (a < b) { x = "&"; }\n```\n'
    + '[open](https://example.invalid/?a=1&b="two") and [mail](mailto:test@example.invalid)\n';
  const { html, result } = await render(t, input);
  assert.equal(bodyOf(html), '<h1>Heading <strong>bold</strong></h1><p>A <em>small</em> note &amp; &lt;raw&gt;<br>second <code>x &lt; y</code> line.</p>'
    + '<ul><li>first</li><li><strong>second</strong></li></ul><ol><li>third</li><li>fourth</li></ol>'
    + '<blockquote>quoted<br><code>literal **</code></blockquote><hr><pre><code>if (a &lt; b) { x = &quot;&amp;&quot;; }</code></pre>'
    + '<p><a href="https://example.invalid/?a=1&amp;b=&quot;two&quot;" target="_blank" rel="noopener noreferrer">open</a> and '
    + '<a href="mailto:test@example.invalid" target="_blank" rel="noopener noreferrer">mail</a></p>');
  assert.equal(result.block_count, 8); assert.equal(result.link_count, 2); assert.equal(result.verified, true);
  assert.deepEqual(result.verification, { passive_html_tree: true, source_text_projection: true, link_destinations: true, browser_rendering: false });
  assert.match(html, /Content-Security-Policy/); assert.match(html, /default-src 'none'/);
  assert.ok(!JSON.stringify(result).includes('example.invalid')); assert.ok(!JSON.stringify(result).includes('Heading'));
});

test('Markdown raw HTML, unsafe links and image syntax cannot become active elements or automatic requests', async t => {
  const { html, result } = await render(t, '<script>fetch("https://private.invalid")</script>\n'
    + '<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n![image](https://example.invalid/image.png)');
  const body = bodyOf(html);
  assert.ok(body.includes('&lt;script&gt;')); assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(body.includes('[bad](javascript:alert(1))')); assert.ok(body.includes('!<a href="https://example.invalid/image.png"'));
  assert.equal(result.link_count, 1); assert.doesNotMatch(body, /<(?:script|img|iframe|style|object|svg|link)\b/i);
  assert.doesNotMatch(body, /href="javascript:/i);
  assert.ok(!JSON.stringify(result).includes('private.invalid'));
});

test('Markdown normalizes CRLF and bare CR deliberately, strips an initial UTF-8 BOM and preserves Unicode text', async t => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Café\r\n\r\n甲 & 乙\rfinal\r')]);
  const { html, result } = await render(t, bytes, 'unicode.htm');
  assert.equal(bodyOf(html), '<h1>Café</h1><p>甲 &amp; 乙<br>final</p>');
  assert.equal(result.line_endings_normalized, true); assert.equal(result.input_bom_removed, true);
  assert.equal(result.line_count, 5);
});

test('Markdown empty text, unclosed fences and unsupported syntax have explicit source behavior', async t => {
  const empty = await render(t, ''); assert.equal(bodyOf(empty.html), ''); assert.equal(empty.result.block_count, 0);
  const unclosed = await render(t, '```ignored language\n<raw> & **not bold**');
  assert.equal(bodyOf(unclosed.html), '<pre><code>&lt;raw&gt; &amp; **not bold**</code></pre>');
  const table = await render(t, 'a | b\n--- | ---\n1 | 2');
  assert.equal(bodyOf(table.html), '<p>a | b<br>--- | ---<br>1 | 2</p>');
});

test('Markdown fails closed for source emphasis that would enter href attributes without leaking private text', async t => {
  const directory = await workspace(t), input = path.join(directory, 'private.md'), output = path.join(directory, 'refused.html');
  const source = '[private-sensitive-label](https://example.invalid/**path**)'; await writeFile(input, source);
  await assert.rejects(renderMarkdown({ input_path: input, output_path: output }), error => {
    assert.equal(error.code, 'VERIFICATION_FAILED'); assert.ok(!String(error).includes('private-sensitive-label'));
    assert.ok(!String(error).includes('example.invalid')); return true;
  });
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
});

test('Markdown bounds precede the source renderer and problematic Unicode separators cannot stall it', async t => {
  const directory = await workspace(t), input = path.join(directory, 'private.md');
  const cases = [
    [Buffer.alloc(MAX_MARKDOWN_INPUT_BYTES + 1, 65), 'INPUT_SIZE'],
    ['a'.repeat(MAX_MARKDOWN_LINE_LENGTH + 1), 'MARKDOWN_LIMIT'],
    ['a\n'.repeat(MAX_MARKDOWN_LINES), 'MARKDOWN_LIMIT'],
    [('**x**'.repeat(100) + '\n').repeat(200), 'MARKDOWN_LIMIT'],
    ['# private\u2028payload', 'MARKDOWN_TEXT'], ['x\0private', 'MARKDOWN_TEXT'],
    [Buffer.from([0xc0, 0xaf]), 'INVALID_UTF8'],
  ];
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `refused-${index}.html`); await writeFile(input, source);
    await assert.rejects(renderMarkdown({ input_path: input, output_path: output }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes('payload')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('Markdown requires local paths, matching extensions and exclusive outputs', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.md'), output = path.join(directory, 'exists.html');
  await writeFile(input, '# Source'); await writeFile(output, 'keep existing');
  await assert.rejects(renderMarkdown({ input_path: input, output_path: output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'keep existing');
  await assert.rejects(renderMarkdown({ input_path: input, output_path: path.join(directory, 'wrong.txt') }), { code: 'OUTPUT_EXTENSION' });
  await assert.rejects(renderMarkdown({ input_path: 'https://example.invalid/private.md', output_path: path.join(directory, 'url.html') }), { code: 'LOCAL_PATH_REQUIRED' });
  await assert.rejects(renderMarkdown({ input_path: input, output_path: 'relative.html' }), { code: 'LOCAL_PATH_REQUIRED' });
});

test('Markdown cancellation terminates the worker before any output write and keeps the input', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.md'), output = path.join(directory, 'cancelled.html');
  const source = ('private content '.repeat(500) + '\n').repeat(60); await writeFile(input, source);
  const controller = new AbortController(), pending = renderMarkdown({ input_path: input, output_path: output }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
  await assert.rejects(renderMarkdown({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
