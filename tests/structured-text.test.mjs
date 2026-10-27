import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertYamlJson, formatXml, MAX_STRUCTURED_INPUT_BYTES, MAX_STRUCTURED_OUTPUT_BYTES,
  MAX_STRUCTURED_DEPTH, MAX_STRUCTURED_NODES } from '../src/structured-text.mjs';

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-structured-text-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const digest = data => createHash('sha256').update(data).digest('hex');
const yamlToJson = (args, options) => convertYamlJson({ ...args, direction: 'yaml-to-json' }, options);
const jsonToYaml = (args, options) => convertYamlJson({ ...args, direction: 'json-to-yaml' }, options);

test('YAML conversion retains duplicate and integer-key order, exact numeric values and comments diagnostics', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.yaml'), output = path.join(directory, 'output.json');
  const source = ['# private comment text', '"10": 123456789012345678901234567890', '"2": 1e999 # another comment',
    '"10": -0', 'hex: 0x1234567890abcdef1234567890abcdef', 'plus: +0001.50',
    'decimal: .5e999', 'no: no', 'date: 2026-10-27', 'escaped: "a\\n\\u263a"', ''].join('\n');
  await writeFile(input, source);
  const result = await yamlToJson({ input_path: input, output_path: output });
  const expected = ['{', '  "10": 123456789012345678901234567890,', '  "2": 1e999,', '  "10": -0,',
    `  "hex": ${BigInt('0x1234567890abcdef1234567890abcdef')},`, '  "plus": 1.50,', '  "decimal": 0.5e999,',
    '  "no": "no",', '  "date": "2026-10-27",', '  "escaped": "a\\n☺"', '}', ''].join('\n');
  assert.equal(await readFile(output, 'utf8'), expected);
  assert.equal(result.operation, 'yaml-json'); assert.equal(result.format, 'json'); assert.equal(result.verified, true);
  assert.equal(result.encoding, 'utf-8'); assert.equal(result.comments_removed, 2); assert.equal(result.max_depth, 1);
  assert.equal(result.output_bytes, Buffer.byteLength(expected)); assert.ok(result.warnings.length > 0);
  for (const secret of ['private comment text', 'escaped', '123456789012345678901234567890']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(await readFile(input, 'utf8'), source);
});

test('YAML natural sorting is stable for duplicates and nested flow and compact block collections', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.yaml'), output = path.join(directory, 'output.json');
  const source = ['item10: 10', 'item2: 2', 'item1: 1', 'item2: 3', 'nested:', '- name: first', '  flags: [true, false, null]',
    '- - {key: value}', '  - "&literal"', 'block: |-', '  [this is text, not a collection]', '  *and not an alias', '  ---', '  ...', ''].join('\n');
  await writeFile(input, source);
  const result = await yamlToJson({ input_path: input, output_path: output, sort_keys: true, indent: '4' });
  const printed = await readFile(output, 'utf8');
  assert.ok(printed.indexOf('"item1"') < printed.indexOf('"item2"'));
  assert.ok(printed.indexOf('"item2": 2') < printed.indexOf('"item2": 3'));
  assert.ok(printed.indexOf('"item2": 3') < printed.indexOf('"item10"'));
  const independent = JSON.parse(printed);
  assert.deepEqual(independent.nested, [{ flags: [true, false, null], name: 'first' }, [{ key: 'value' }, '&literal']]);
  assert.equal(independent.block, '[this is text, not a collection]\n*and not an alias\n---\n...');
  assert.equal(result.sort_keys, true); assert.ok(result.max_depth >= 4); assert.equal(await readFile(input, 'utf8'), source);
});

test('JSON to YAML round trips exact numbers, duplicates, escaped strings and multiline values', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json'), yaml = path.join(directory, 'converted.yml'), output = path.join(directory, 'round-trip.json');
  const source = String.raw`{"10":123456789012345678901234567890,"2":1e999,"10":-0,"no":"no","escaped":"\u0061\/\\\t\n","lines":"first\nsecond\n","items":[{"b":true,"empty":[]},null,"😀"]}`;
  await writeFile(input, '\ufeff' + source);
  const result = await jsonToYaml({ input_path: input, output_path: yaml, indent: '2' });
  const intermediate = await readFile(yaml, 'utf8');
  assert.ok(intermediate.endsWith('\n')); assert.ok(intermediate.includes('123456789012345678901234567890'));
  assert.ok(intermediate.includes('1e999')); assert.ok(intermediate.includes('lines: |\n  first\n  second\n'));
  assert.equal(result.format, 'yaml'); assert.equal(result.comments_removed, 0); assert.equal(result.verified, true);
  await yamlToJson({ input_path: yaml, output_path: output });
  const expected = ['{', '  "10": 123456789012345678901234567890,', '  "2": 1e999,', '  "10": -0,', '  "no": "no",',
    '  "escaped": "a/\\\\\\t\\n",', '  "lines": "first\\nsecond\\n",', '  "items": [', '    {', '      "b": true,',
    '      "empty": []', '    },', '    null,', '    "😀"', '  ]', '}', ''].join('\n');
  assert.equal(await readFile(output, 'utf8'), expected); assert.equal(await readFile(input, 'utf8'), '\ufeff' + source);
});

test('YAML verification refuses source printer cases that cannot round trip instead of publishing changed structure', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.json'), output = path.join(directory, 'output.yaml');
  // The unchanged printer's compact sequence starts its first key two columns
  // after the dash, even when later mapping keys use a four-space step.
  for (const source of ['{"items":[{"first":1,"second":2}]}', '"first\\nsecond"']) {
    await writeFile(input, source);
    await assert.rejects(jsonToYaml({ input_path: input, output_path: output, indent: '4' }), { code: 'VERIFICATION_FAILED' });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
  }
  await writeFile(input, '{"outer":{"first":1,"second":2}}');
  await jsonToYaml({ input_path: input, output_path: output, indent: '4' });
  assert.equal(await readFile(output, 'utf8'), 'outer:\n    first: 1\n    second: 2\n');
});

test('YAML refuses anchors, aliases, tags, multiple documents and malformed syntax without leaking values', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.yaml');
  const cases = [
    ['private-secret-key: &anchor value', 'UNSUPPORTED_YAML'], ['key: *private-secret-alias', 'UNSUPPORTED_YAML'],
    ['key: !!str private-secret-value', 'UNSUPPORTED_YAML'], ['{key: &private-secret-flow}', 'UNSUPPORTED_YAML'],
    ['[*private-secret-flow]', 'UNSUPPORTED_YAML'], ['{!private-secret-key: value}', 'UNSUPPORTED_YAML'],
    ['---\na: 1\n---\nb: 2', 'UNSUPPORTED_YAML'], ['a: 1\n---\nb: 2', 'UNSUPPORTED_YAML'],
    ['a: 1\n...\nb: 2', 'UNSUPPORTED_YAML'], ['a: 1\n...\n---\nb: 2', 'UNSUPPORTED_YAML'],
    ['--- # private-secret comment', 'UNSUPPORTED_YAML'], ['... # private-secret comment', 'UNSUPPORTED_YAML'],
    ['[a # private-secret]', 'UNSUPPORTED_YAML'], ['[#private-secret]', 'UNSUPPORTED_YAML'],
    ['{key # private-secret: value}', 'UNSUPPORTED_YAML'],
    ['key: [1, private-secret-value', 'INVALID_YAML_JSON'],
    ['key: "private-secret-value', 'INVALID_YAML_JSON'], ['key:\n\tchild: private-secret-value', 'UNSUPPORTED_YAML'],
  ];
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `bad-${index}.json`); await writeFile(input, source);
    await assert.rejects(yamlToJson({ input_path: input, output_path: output }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes('private-secret')); assert.ok(!JSON.stringify(error).includes('private-secret'));
      if (code === 'INVALID_YAML_JSON') { assert.ok(error.line >= 1); assert.ok(error.column >= 1); }
      return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
  }
  await writeFile(input, '# comment only\n'); const empty = path.join(directory, 'empty.json');
  await yamlToJson({ input_path: input, output_path: empty }); assert.equal(await readFile(empty, 'utf8'), 'null\n');
  await writeFile(input, '---\na: 1\n...\n# terminal comment\n'); const marked = path.join(directory, 'marked.json');
  await yamlToJson({ input_path: input, output_path: marked }); assert.equal(await readFile(marked, 'utf8'), '{\n  "a": 1\n}\n');
  await writeFile(input, '["a # b", a#b]'); const hashes = path.join(directory, 'hashes.json');
  await yamlToJson({ input_path: input, output_path: hashes }); assert.deepEqual(JSON.parse(await readFile(hashes, 'utf8')), ['a # b', 'a#b']);
  await writeFile(input, String.raw`{"private-secret":"\ud800"}`);
  await assert.rejects(jsonToYaml({ input_path: input, output_path: path.join(directory, 'surrogate.yaml') }), { code: 'UNSUPPORTED_TEXT' });
});

test('structured YAML/JSON guards bound recursive parsing, syntax nodes and output expansion', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input');
  const boundary = '['.repeat(MAX_STRUCTURED_DEPTH) + '0' + ']'.repeat(MAX_STRUCTURED_DEPTH);
  await writeFile(input, boundary);
  const accepted = await yamlToJson({ input_path: input, output_path: path.join(directory, 'boundary.json') });
  assert.equal(accepted.max_depth, MAX_STRUCTURED_DEPTH);
  const excessive = '['.repeat(MAX_STRUCTURED_DEPTH + 1) + '"unterminated';
  for (const [index, operation] of [yamlToJson, jsonToYaml].entries()) {
    await writeFile(input, excessive);
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, `deep-${index}.${index ? 'yaml' : 'json'}`) }), { code: 'STRUCTURED_LIMIT' });
  }
  const disguisedFlow = '[ # private-secret comment, ' + '['.repeat(1000) + '0' + ']'.repeat(1000) + ' ]';
  await writeFile(input, disguisedFlow);
  await assert.rejects(yamlToJson({ input_path: input, output_path: path.join(directory, 'flow-comment-depth.json') }), { code: 'UNSUPPORTED_YAML' });
  await assert.rejects(readFile(path.join(directory, 'flow-comment-depth.json')), { code: 'ENOENT' });
  const blocks = Array.from({ length: MAX_STRUCTURED_DEPTH + 1 }, (_, index) => ' '.repeat(index * 2) + 'key:').join('\n');
  await writeFile(input, blocks);
  await assert.rejects(yamlToJson({ input_path: input, output_path: path.join(directory, 'block-depth.json') }), { code: 'STRUCTURED_LIMIT' });
  const compact = '- '.repeat(MAX_STRUCTURED_DEPTH + 1) + '0'; await writeFile(input, compact);
  await assert.rejects(yamlToJson({ input_path: input, output_path: path.join(directory, 'compact-depth.json') }), { code: 'STRUCTURED_LIMIT' });
  await writeFile(input, '[' + Array(MAX_STRUCTURED_NODES).fill('0').join(',') + ']');
  await assert.rejects(yamlToJson({ input_path: input, output_path: path.join(directory, 'wide.json') }), { code: 'STRUCTURED_LIMIT' });
  const expanding = '['.repeat(127) + '[' + Array(35000).fill('0').join(',') + ']' + ']'.repeat(127);
  assert.ok(Buffer.byteLength(expanding) < MAX_STRUCTURED_INPUT_BYTES); await writeFile(input, expanding);
  for (const [index, operation] of [yamlToJson, jsonToYaml].entries()) {
    const output = path.join(directory, `expanding-${index}.${index ? 'yaml' : 'json'}`);
    await assert.rejects(operation({ input_path: input, output_path: output, indent: '4' }), { code: 'OUTPUT_SIZE' });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('XML formatting preserves mixed content, xml:space, comments, CDATA, attributes and declaration', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.xml'), output = path.join(directory, 'formatted.xml');
  const source = '<?xml version="1.0" encoding="UTF-8"?><root a=\'&quot;\' b="&#x1F600;">'
    + '<p>Hello  <b>world</b> !&#33;&amp;</p><keep xml:space="preserve">  <x/> \n <restore xml:space="default"><a/><b/></restore> </keep>'
    + '<!--private-comment--><data><![CDATA[<raw>&custom-is-literal;]]></data><empty></empty></root>';
  await writeFile(input, '\ufeff' + source);
  const result = await formatXml({ input_path: input, output_path: output, indent: '4' });
  const expected = ['<?xml version="1.0" encoding="UTF-8"?>', '<root a=\'&quot;\' b="&#x1F600;">',
    '    <p>Hello  <b>world</b> !&#33;&amp;</p>',
    '    <keep xml:space="preserve">  <x/> \n <restore xml:space="default"><a/><b/></restore> </keep>',
    '    <!--private-comment-->', '    <data><![CDATA[<raw>&custom-is-literal;]]></data>', '    <empty></empty>', '</root>', ''].join('\n');
  assert.equal(await readFile(output, 'utf8'), expected); assert.equal(result.operation, 'format-xml');
  assert.equal(result.output_bytes, Buffer.byteLength(expected)); assert.equal(result.format, 'xml'); assert.equal(result.verified, true);
  assert.equal(result.max_depth, 4); assert.equal(result.encoding, 'utf-8'); assert.ok(result.warnings.length > 0);
  assert.ok(!JSON.stringify(result).includes('private-comment')); assert.equal(await readFile(input, 'utf8'), '\ufeff' + source);
});

test('XML minification changes only element-layout whitespace and accepts XML predefined/numeric references', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.xml'), output = path.join(directory, 'minified.xml');
  const source = '<root>\n  <a x="&apos;&quot;&lt;&gt;&amp;&#9;&#xA;"> &#65; &amp; </a>\n  <b/>\n</root>\n';
  await writeFile(input, source); await formatXml({ input_path: input, output_path: output, minify: true });
  const expected = '<root><a x="&apos;&quot;&lt;&gt;&amp;&#9;&#xA;"> &#65; &amp; </a><b/></root>';
  assert.equal(await readFile(output, 'utf8'), expected);
  const tabbed = path.join(directory, 'tabbed.xml'); await formatXml({ input_path: output, output_path: tabbed, indent: 'tab' });
  assert.equal(await readFile(tabbed, 'utf8'), '<root>\n\t<a x="&apos;&quot;&lt;&gt;&amp;&#9;&#xA;"> &#65; &amp; </a>\n\t<b/>\n</root>\n');
  const version11 = path.join(directory, 'version11.xml'); await writeFile(input, '<?xml version="1.1"?><r>&#1;</r>');
  await formatXml({ input_path: input, output_path: version11 });
  assert.equal(await readFile(version11, 'utf8'), '<?xml version="1.1"?>\n<r>&#1;</r>\n');
});

test('XML refuses DTDs, entity declarations, custom references and HTML recovery without source leakage', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.xml');
  const cases = [
    ['<!DOCTYPE r SYSTEM "https://private-secret.invalid/dtd"><r/>', 'UNSUPPORTED_XML'],
    ['<!DOCTYPE r [<!ENTITY x SYSTEM "file:///private-secret">]><r>&x;</r>', 'UNSUPPORTED_XML'],
    ['<!ENTITY x "private-secret"><r/>', 'UNSUPPORTED_XML'], ['<r>&private-secret;</r>', 'UNSUPPORTED_XML'],
    ['<r a="&private-secret;"/>', 'UNSUPPORTED_XML'], ['<r>&amp</r>', 'UNSUPPORTED_XML'],
    ['<?xml version="1.0" encoding="UTF-16"?><r/>', 'UNSUPPORTED_XML'],
    ['<r><br></r>', 'INVALID_XML'], ['<r>private-secret &#0;</r>', 'INVALID_XML'],
    ['<r a=private-secret/>', 'INVALID_XML'], ['<r><private-secret></r>', 'INVALID_XML'],
  ];
  for (const [index, [source, code]] of cases.entries()) {
    const output = path.join(directory, `invalid-${index}.xml`); await writeFile(input, source);
    await assert.rejects(formatXml({ input_path: input, output_path: output }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes('private-secret')); assert.ok(!JSON.stringify(error).includes('private-secret'));
      if (code === 'INVALID_XML') { assert.ok(error.line >= 1); assert.ok(error.column >= 1); }
      return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
  }
});

test('XML validity gate refuses malformed characters, names and attributes accepted by the source formatter', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.xml');
  const cases = ['<root>\u0000</root>', '<root>\ufffe</root>', '<root>\uffff</root>', '<r@/>', '<r a@="1"/>',
    '<r a="1" a="2"/>', '<r a="1"b="2"/>', '<r a="private-secret<value"/>', '<r>private-secret]]></r>',
    '<r><!--private-secret--inside--></r>', '<r><!--private-secret---></r>', '<?1bad?><r/>',
    '<?xml version="1.1"?><r>\u007f</r>', '<?xml version="1.1"?><r>\u0086</r>', '<?xml version="1.2"?><r/>'];
  for (const [index, source] of cases.entries()) {
    const output = path.join(directory, `malformed-${index}.xml`); await writeFile(input, source);
    await assert.rejects(formatXml({ input_path: input, output_path: output }), error => {
      assert.equal(error.code, 'INVALID_XML'); assert.ok(error.line >= 1); assert.ok(error.column >= 1);
      assert.ok(!String(error).includes('private-secret')); assert.ok(!JSON.stringify(error).includes('private-secret')); return true;
    });
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(await readFile(input, 'utf8'), source);
  }
  const source = '<?valid-pi data?><root名 属性="é" á="1" a·="2"><x/></root名>';
  await writeFile(input, source); const output = path.join(directory, 'unicode.xml');
  await formatXml({ input_path: input, output_path: output, minify: true });
  assert.equal(await readFile(output, 'utf8'), source);
});

test('XML bounds actual elements, attributes and output expansion before recursive printing', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.xml');
  await writeFile(input, '<r>'.repeat(MAX_STRUCTURED_DEPTH) + '</r>'.repeat(MAX_STRUCTURED_DEPTH));
  const accepted = await formatXml({ input_path: input, output_path: path.join(directory, 'boundary.xml'), minify: true });
  assert.equal(accepted.max_depth, MAX_STRUCTURED_DEPTH);
  await writeFile(input, '<r>'.repeat(MAX_STRUCTURED_DEPTH + 1));
  await assert.rejects(formatXml({ input_path: input, output_path: path.join(directory, 'deep.xml') }), { code: 'STRUCTURED_LIMIT' });
  await writeFile(input, '<r>' + '<i/>'.repeat(MAX_STRUCTURED_NODES) + '</r>');
  await assert.rejects(formatXml({ input_path: input, output_path: path.join(directory, 'wide.xml') }), { code: 'STRUCTURED_LIMIT' });
  await writeFile(input, '<r ' + Array.from({ length: MAX_STRUCTURED_NODES }, (_, index) => `a${index}=""`).join(' ') + '/>');
  await assert.rejects(formatXml({ input_path: input, output_path: path.join(directory, 'attributes.xml') }), { code: 'STRUCTURED_LIMIT' });
  const expanding = '<r>'.repeat(127) + '<i/>'.repeat(35000) + '</r>'.repeat(127);
  assert.ok(Buffer.byteLength(expanding) < MAX_STRUCTURED_INPUT_BYTES); await writeFile(input, expanding);
  const output = path.join(directory, 'expanding.xml');
  await assert.rejects(formatXml({ input_path: input, output_path: output, indent: '4' }), { code: 'OUTPUT_SIZE' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  const minified = path.join(directory, 'minified.xml'), result = await formatXml({ input_path: input, output_path: minified, minify: true });
  assert.equal(await readFile(minified, 'utf8'), expanding); assert.ok(result.output_bytes < MAX_STRUCTURED_OUTPUT_BYTES);
});

test('structured operations enforce UTF-8, file bounds, extension, exclusive outputs and argument contracts', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input'), output = path.join(directory, 'output.json');
  for (const [index, operation] of [yamlToJson, jsonToYaml, formatXml].entries()) {
    const suffix = ['json', 'yaml', 'xml'][index], destination = path.join(directory, `invalid-${index}.${suffix}`);
    await writeFile(input, Buffer.from([0xff]));
    await assert.rejects(operation({ input_path: input, output_path: destination }), { code: 'INVALID_UTF8' });
    const file = await open(input, 'w'); await file.truncate(MAX_STRUCTURED_INPUT_BYTES + 1); await file.close();
    await assert.rejects(operation({ input_path: input, output_path: destination }), { code: 'INPUT_SIZE' });
    await writeFile(destination, 'keep-existing');
    await assert.rejects(operation({ input_path: input, output_path: destination }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(destination, 'utf8'), 'keep-existing');
    await assert.rejects(operation({ input_path: input, output_path: path.join(directory, `wrong-${index}.txt`) }), { code: 'OUTPUT_EXTENSION' });
    await assert.rejects(operation({ input_path: 'relative-input', output_path: path.join(directory, `relative-${index}.${suffix}`) }), { code: 'LOCAL_PATH_REQUIRED' });
  }
  await writeFile(input, '{}');
  for (const args of [{ direction: 'xml-to-json' }, { direction: 'json-to-yaml', sort_keys: true }, { direction: 'yaml-to-json', indent: 'tab' },
    { direction: 'yaml-to-json', sort_keys: 'yes' }]) await assert.rejects(convertYamlJson({ input_path: input, output_path: output, ...args }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(formatXml({ input_path: input, output_path: path.join(directory, 'output.xml'), minify: 'yes' }), { code: 'INVALID_ARGUMENTS' });
});

test('structured workers honor cancellation and leave sources and output locations intact', { timeout: 120000 }, async t => {
  const directory = await workspace(t), input = path.join(directory, 'input');
  const source = '"' + 'x'.repeat(MAX_STRUCTURED_INPUT_BYTES - 2) + '"'; await writeFile(input, source);
  const original = digest(await readFile(input));
  for (const [index, operation] of [yamlToJson, jsonToYaml, formatXml].entries()) {
    if (operation === formatXml) await writeFile(input, '<r>' + 'x'.repeat(MAX_STRUCTURED_INPUT_BYTES - 7) + '</r>');
    const before = digest(await readFile(input)), output = path.join(directory, `cancelled-${index}.${['json', 'yaml', 'xml'][index]}`);
    await assert.rejects(operation({ input_path: input, output_path: output }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    const controller = new AbortController(), pending = operation({ input_path: input, output_path: output }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 10);
    try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
    await assert.rejects(readFile(output), { code: 'ENOENT' }); assert.equal(digest(await readFile(input)), before);
  }
  await writeFile(input, source); assert.equal(digest(await readFile(input)), original);
});
