import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatCode, MAX_CODE_FORMAT_INPUT_BYTES } from '../src/code-format.mjs';
import { parseYaml } from '../vendor/abox/shared/js/parse-yaml.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-code-format-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function source(directory, value, name = 'source.txt') { const input = path.join(directory, name); await writeFile(input, value); return input; }

test('HTML formatting reuses source omitted-tag and void rules without evaluating scripts, styles, attributes or links', async t => {
  const directory = await workspace(t), secret = 'PRIVATE HTML CONTENT', raw = '<!doctype html><html><body data-private="PRIVATE ATTRIBUTE"><ul><li>One<li>Two</ul><br><pre>  keep\n this  </pre><textarea>a  b\nc</textarea><script>throw "PRIVATE HTML CONTENT";</script><style>.x{color:red}</style><a href="https://example.invalid/never-open">Link</a></body></html>';
  const input = await source(directory, raw), output = path.join(directory, 'formatted.html');
  const result = await formatCode({ input_path: input, output_path: output, language: 'html' }), text = await readFile(output, 'utf8');
  assert.equal(result.verified, true); assert.equal(result.verification.protected_text, true); assert.equal(result.verification.whitespace_identity, false);
  assert.equal(result.verification.rendered_equivalence, false); assert.equal(result.indent, '2'); assert.equal(result.minified, false);
  assert.match(text, /<li>One<\/li>/); assert.match(text, /<li>Two<\/li>/); assert.match(text, /<br>/);
  for (const fragment of ['<pre>  keep\n this  </pre>', '<textarea>a  b\nc</textarea>', `<script>throw "${secret}";</script>`, '<style>.x{color:red}</style>']) assert.ok(text.includes(fragment));
  for (const value of [secret, 'PRIVATE ATTRIBUTE', 'https://example.invalid/never-open']) assert.ok(!JSON.stringify(result).includes(value));
  assert.equal(await readFile(input, 'utf8'), raw); assert.ok(text.endsWith('\n'));
  const compact = path.join(directory, 'compact.htm'); await formatCode({ input_path: input, output_path: compact, language: 'html', minify: true });
  assert.ok((await readFile(compact, 'utf8')).includes('<pre>  keep\n this  </pre>'));
});

test('HTML refuses source changes to raw embedded code and preformatted bodies before writing', async t => {
  const directory = await workspace(t);
  for (const [index, raw] of ['<script>return\nPRIVATE_TOKEN;</script>', '<style>.a {\n color: red;\n}</style>', '<textarea>PRIVATE\n<SPAN> two  spaces </SPAN></textarea>'].entries()) {
    const input = await source(directory, raw, `raw-${index}.txt`), output = path.join(directory, `refused-${index}.html`);
    await assert.rejects(formatCode({ input_path: input, output_path: output, language: 'html' }), error => {
      assert.equal(error.code, 'CODE_FORMAT_UNSUPPORTED'); assert.ok(!String(error).includes('PRIVATE_TOKEN')); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('CSS formatting preserves ordered declarations, quoted tokens, custom-property streams and URL text', async t => {
  const directory = await workspace(t), raw = '/* PRIVATE COMMENT */@media (min-width: 1px){.a,.b{--gap: +;color:red;color:blue;content:"PRIVATE text";background:url("https://example.invalid/a;b");}}';
  const input = await source(directory, raw), output = path.join(directory, 'layout.css');
  const result = await formatCode({ input_path: input, output_path: output, language: 'css', indent: 'tab' }), pretty = await readFile(output, 'utf8');
  assert.equal(result.verified, true); assert.equal(result.verification.quoted_strings, true); assert.equal(result.verification.custom_property_values, true);
  assert.equal(result.verification.rendered_equivalence, false); assert.equal(result.indent, 'tab'); assert.ok(pretty.includes('\t'));
  assert.ok(pretty.indexOf('color: red;') < pretty.indexOf('color: blue;')); assert.ok(pretty.includes('--gap: +;'));
  assert.ok(pretty.includes('"PRIVATE text"')); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const compact = path.join(directory, 'compact.css'), minified = await formatCode({ input_path: input, output_path: compact, language: 'css', minify: true });
  assert.equal(minified.minified, true); assert.ok(!Object.hasOwn(minified, 'indent'));
  assert.equal(await readFile(compact, 'utf8'), '@media (min-width: 1px){.a,.b{--gap:+;color:red;color:blue;content:"PRIVATE text";background:url("https://example.invalid/a;b")}}\n');
  assert.equal(await readFile(input, 'utf8'), raw);
});

test('CSS fail-closed lexical checks detect quoted whitespace, escape and global-semicolon source corruption', async t => {
  const directory = await workspace(t);
  const cases = [['.a{content:"PRIVATE  TWO"}', false], ['.a[data-x="two  words"]{color:red}', false],
    ['.a{content:"PRIVATE;}TEXT"}', true], ['.a{--custom: PRIVATE;}VALUE;}', true], ['.a{content:"\\31  2"}', false]];
  for (const [index, [raw, minify]] of cases.entries()) {
    const input = await source(directory, raw, `bad-${index}.txt`), output = path.join(directory, `none-${index}.css`);
    await assert.rejects(formatCode({ input_path: input, output_path: output, language: 'css', minify }), error => {
      assert.ok(['CODE_FORMAT_UNSUPPORTED', 'INVALID_CODE'].includes(error.code)); assert.ok(!String(error).includes('PRIVATE')); return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('YAML formatting preserves ordered duplicate values and significant numbers while changing layout and comments', async t => {
  const directory = await workspace(t), raw = '# PRIVATE COMMENT\nid: +9007199254740993\ncountry: no\nduplicate: first\nduplicate: second\nitems: [1, 2]\n';
  const input = await source(directory, raw), output = path.join(directory, 'formatted.yml');
  const result = await formatCode({ input_path: input, output_path: output, language: 'yaml' }), formatted = await readFile(output, 'utf8'), tree = parseYaml(formatted);
  assert.equal(result.verified, true); assert.equal(result.verification.ordered_values, true); assert.equal(result.verification.comments_preserved, false);
  assert.ok(!formatted.includes('PRIVATE COMMENT')); assert.ok(formatted.includes('9007199254740993')); assert.ok(formatted.includes("'no'"));
  assert.deepEqual(tree.pairs.map(pair => pair.key), ['id', 'country', 'duplicate', 'duplicate', 'items']);
  assert.equal(tree.pairs[0].value.raw, '9007199254740993'); assert.deepEqual(tree.pairs[4].value.items.map(item => item.raw), ['1', '2']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(await readFile(input, 'utf8'), raw);
});

test('empty HTML/CSS documents and an empty YAML value use the source empty-document behavior', async t => {
  const directory = await workspace(t), input = await source(directory, '');
  for (const language of ['html', 'css', 'yaml']) {
    const output = path.join(directory, `empty.${language}`), result = await formatCode({ input_path: input, output_path: output, language });
    assert.equal(result.verified, true); assert.equal(result.input_bytes, 0);
    assert.equal(await readFile(output, 'utf8'), language === 'yaml' ? 'null\n' : '\n');
  }
});

test('formatting bounds apply before recursive printers and parser errors never include source excerpts', async t => {
  const directory = await workspace(t), cases = [
    ['css', '{'.repeat(129) + 'x:y;' + '}'.repeat(129), 'CODE_FORMAT_LIMIT'],
    ['html', '<div>'.repeat(129) + 'x' + '</div>'.repeat(129), 'CODE_FORMAT_LIMIT'],
    ['html', '<div ' + 'x '.repeat(100001) + '>', 'CODE_FORMAT_LIMIT'],
    ['html', '<div ' + 'x\u00a0'.repeat(100001) + '>', 'CODE_FORMAT_LIMIT'],
    ['yaml', 'value: &PRIVATE_ANCHOR secret\n', 'UNSUPPORTED_YAML'],
    ['yaml', 'one: 1\n---\ntwo: 2\n', 'UNSUPPORTED_YAML'],
    ['css', '.a { PRIVATE VALUE WITHOUT COLON; }', 'INVALID_CODE'],
  ];
  for (const [index, [language, raw, code]] of cases.entries()) {
    const input = await source(directory, raw, `invalid-${index}.txt`), output = path.join(directory, `invalid-${index}.${language}`);
    await assert.rejects(formatCode({ input_path: input, output_path: output, language }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes('PRIVATE')); return true;
    }); await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  const input = path.join(directory, 'too-large.txt'), handle = await open(input, 'w'); await handle.truncate(MAX_CODE_FORMAT_INPUT_BYTES + 1); await handle.close();
  await assert.rejects(formatCode({ input_path: input, output_path: path.join(directory, 'large.css'), language: 'css' }), { code: 'INPUT_SIZE' });
});

test('conditional options, valid UTF-8, exclusive outputs and cancellation never modify local sources', async t => {
  const directory = await workspace(t), input = await source(directory, '.a{color:red}'), output = path.join(directory, 'new.css'), before = await readFile(input);
  for (const args of [{ language: 'html', indent: null }, { language: 'css', minify: null }, { language: 'yaml', indent: 'tab' },
    { language: 'yaml', minify: false }, { language: 'yaml', minify: true }, { language: 'html', minify: true, indent: '2' }, { language: 'js' }]) {
    await assert.rejects(formatCode({ input_path: input, output_path: output, ...args }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(formatCode({ input_path: input, output_path: path.join(directory, 'wrong.json'), language: 'css' }), { code: 'OUTPUT_EXTENSION' });
  const invalid = await source(directory, Buffer.from([255]), 'invalid-utf8.txt');
  await assert.rejects(formatCode({ input_path: invalid, output_path: output, language: 'css' }), { code: 'INVALID_UTF8' });
  await writeFile(output, 'existing'); await assert.rejects(formatCode({ input_path: input, output_path: output, language: 'css' }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'existing');
  await assert.rejects(formatCode({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), cancelled = path.join(directory, 'cancelled.css'), pending = formatCode({ input_path: input, output_path: cancelled, language: 'css' }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5); try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(stat(cancelled), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(before));
});
