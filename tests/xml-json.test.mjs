import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertXmlJson } from '../src/xml-json.mjs';
import { MAX_STRUCTURED_INPUT_BYTES } from '../src/structured-text.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'abox-xml-json-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function convert(directory, source, direction, suffix, extra = {}) {
  const input = path.join(directory, `source-${suffix}.txt`), output = path.join(directory, `result-${suffix}.${direction === 'xml-to-json' ? 'json' : 'xml'}`);
  await writeFile(input, source); const result = await convertXmlJson({ input_path: input, output_path: output, direction, ...extra });
  return { input, output, result, text: await readFile(output, 'utf8') };
}

test('XML mapping keeps attributes, strings, repeated children and CDATA while explicitly losing mixed order and comments', async t => {
  const directory = await workspace(t), source = '\ufeff<?xml version="1.0" encoding="UTF-8"?>\n<!--Private discarded comment--><r id="7"> before <a>one</a> middle <b>2</b><a><![CDATA[three&]]></a> after </r>';
  const { result, input, text } = await convert(directory, source, 'xml-to-json', 'mixed');
  assert.deepEqual(JSON.parse(text), { r: { '@id': '7', a: ['one', 'three&'], b: '2', '#text': ' before  middle  after ' } });
  assert.equal(result.lossy_mapping, true); assert.equal(result.verification.source_mapping, true); assert.equal(result.verification.semantic_roundtrip, false);
  assert.equal(result.verified, true); assert.ok(text.endsWith('\n')); assert.ok(!text.includes('Private discarded comment'));
  for (const privateValue of ['one', 'three&', 'Private discarded comment', ' before ']) assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal(hash(await readFile(input)), hash(Buffer.from(source)));
  const preserved = await convert(directory, '<r xml:space="preserve"><x/> <y/></r>', 'xml-to-json', 'space', { indent: 'tab' });
  assert.deepEqual(JSON.parse(preserved.text), { r: { '@xml:space': 'preserve', x: null, y: null, '#text': ' ' } });
  assert.ok(preserved.text.includes('\t'));
  const values = await convert(directory, '<r><port>8080</port><flag>true</flag><empty/><q a="&quot;&amp;">&#x65E5;&#26412;</q></r>', 'xml-to-json', 'values', { indent: '4' });
  assert.deepEqual(JSON.parse(values.text), { r: { port: '8080', flag: 'true', empty: null, q: { '@a': '"&', '#text': '日本' } } });
});

test('prototype-looking XML and JSON names remain ordinary data without assigning to object prototypes', async t => {
  const directory = await workspace(t), xml = '<__proto__><constructor>Private constructor</constructor><prototype>Private prototype</prototype><__proto__>Private nested</__proto__></__proto__>';
  const one = await convert(directory, xml, 'xml-to-json', 'prototype'), parsed = JSON.parse(one.text);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype); assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(parsed.__proto__.constructor, 'Private constructor'); assert.equal(parsed.__proto__.__proto__, 'Private nested');
  assert.equal(Object.prototype.polluted, undefined); assert.ok(!JSON.stringify(one.result).includes('Private constructor'));
  const json = '{"__proto__":"Private nested","constructor":"Private constructor","prototype":"Private prototype"}';
  const two = await convert(directory, json, 'json-to-xml', 'json-prototype');
  assert.equal(two.text, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <__proto__>Private nested</__proto__>\n  <constructor>Private constructor</constructor>\n  <prototype>Private prototype</prototype>\n</root>\n');
  assert.equal(Object.prototype.polluted, undefined);
});

test('JSON mapping preserves raw large-number spellings and escapes text while disclosing sanitized names and collapsed empty values', async t => {
  const directory = await workspace(t), json = '{"id":9007199254740993123456789,"huge":1e999,"1 first":"<>&\\\"日本","bool":false,"nil":null,"emptyMap":{},"emptyArray":[],"list":[1,2]}';
  const made = await convert(directory, json, 'json-to-xml', 'numbers');
  assert.equal(made.text, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <id>9007199254740993123456789</id>\n  <huge>1e999</huge>\n  <_1_first>&lt;&gt;&amp;"日本</_1_first>\n  <bool>false</bool>\n  <nil/>\n  <emptyMap/>\n  <emptyArray/>\n  <list>1</list>\n  <list>2</list>\n</root>\n');
  assert.equal(made.result.renamed_keys, 1); assert.equal(made.result.verification.semantic_roundtrip, false);
  const array = await convert(directory, '[null,{},[],false,42,""]', 'json-to-xml', 'array', { indent: 'tab' });
  assert.equal(array.text, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n\t<item/>\n\t<item/>\n\t<item/>\n\t<item>false</item>\n\t<item>42</item>\n\t<item></item>\n</root>\n');
  const empty = await convert(directory, '[]', 'json-to-xml', 'empty-array'); assert.equal(empty.text, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n</root>\n');
  const nested = await convert(directory, '{"nested":[["a","b"],"c"]}', 'json-to-xml', 'nested-arrays');
  assert.equal(nested.text, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <nested>a</nested>\n  <nested>b</nested>\n  <nested>c</nested>\n</root>\n');
});

test('ambiguous JSON names, invalid XML characters and unsafe XML constructs fail without content-bearing errors or partial output', async t => {
  const directory = await workspace(t), cases = [
    ['json-to-xml', '{"Private key":1,"Private?key":2}', 'XML_JSON_UNSUPPORTED'],
    ['json-to-xml', '{"Private":1,"Private":2}', 'XML_JSON_UNSUPPORTED'],
    ['json-to-xml', '{"Private:prefix":1}', 'XML_JSON_UNSUPPORTED'],
    ['json-to-xml', '{"private":"\\u0000"}', 'XML_JSON_UNSUPPORTED'],
    ['json-to-xml', '{"private":"\\ud800"}', 'XML_JSON_UNSUPPORTED'],
    ['xml-to-json', '<!DOCTYPE r [<!ENTITY private SYSTEM "file:///Private">]><r>&private;</r>', 'UNSUPPORTED_XML'],
    ['xml-to-json', '<r>&private;</r>', 'UNSUPPORTED_XML'],
    ['xml-to-json', '<r a="Private" a="Private"/>', 'INVALID_XML_JSON'],
    ['xml-to-json', '<r@>Private</r@>', 'INVALID_XML_JSON'],
    ['xml-to-json', '<r>Private\0</r>', 'INVALID_XML_JSON'],
    ['xml-to-json', '<r>Private', 'INVALID_XML_JSON'],
  ];
  for (const [index, [direction, source, code]] of cases.entries()) {
    const input = path.join(directory, `bad-${index}.txt`), output = path.join(directory, `no-${index}.${direction === 'xml-to-json' ? 'json' : 'xml'}`); await writeFile(input, source);
    await assert.rejects(convertXmlJson({ input_path: input, output_path: output, direction }), error => {
      assert.equal(error.code, code); assert.ok(!error.message.includes('Private')); assert.ok(!error.message.includes('private')); return true;
    }); await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('parser depth/node and predicted output expansion are bounded before recursive conversion and printing', async t => {
  const directory = await workspace(t), cases = [
    ['json-to-xml', '['.repeat(129) + '0' + ']'.repeat(129), 'STRUCTURED_LIMIT'],
    ['xml-to-json', '<r>'.repeat(129) + 'x' + '</r>'.repeat(129), 'STRUCTURED_LIMIT'],
    ['json-to-xml', '[' + Array(100001).fill('0').join(',') + ']', 'STRUCTURED_LIMIT'],
    ['xml-to-json', '<r>' + '<x/>'.repeat(100001) + '</r>', 'STRUCTURED_LIMIT'],
    ['json-to-xml', JSON.stringify({ ['long'.repeat(5000)]: Array(500).fill(0) }), 'OUTPUT_SIZE'],
  ];
  for (const [index, [direction, source, code]] of cases.entries()) {
    const input = path.join(directory, `bounded-${index}.txt`), output = path.join(directory, `bounded-${index}.${direction === 'xml-to-json' ? 'json' : 'xml'}`); await writeFile(input, source);
    await assert.rejects(convertXmlJson({ input_path: input, output_path: output, direction }), { code }); await assert.rejects(readFile(output), { code: 'ENOENT' });
    assert.equal(hash(await readFile(input)), hash(Buffer.from(source)));
  }
});

test('UTF-8, BOM, output extensions, exclusive paths, size and cancellation contracts preserve input files', async t => {
  const directory = await workspace(t), input = path.join(directory, 'source.xml'), source = Buffer.from('\ufeff<r>Private</r>'), output = path.join(directory, 'report.json'); await writeFile(input, source);
  await assert.rejects(convertXmlJson({ input_path: input, output_path: output }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(convertXmlJson({ input_path: input, output_path: output, direction: 'xml-to-json', indent: null }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(convertXmlJson({ input_path: input, output_path: path.join(directory, 'wrong.xml'), direction: 'xml-to-json' }), { code: 'OUTPUT_EXTENSION' });
  const made = await convertXmlJson({ input_path: input, output_path: output, direction: 'xml-to-json' }); assert.equal(made.verified, true);
  await assert.rejects(convertXmlJson({ input_path: input, output_path: output, direction: 'xml-to-json' }), { code: 'OUTPUT_EXISTS' });
  const invalid = path.join(directory, 'invalid.xml'); await writeFile(invalid, Buffer.from([0xff, 0xfe]));
  await assert.rejects(convertXmlJson({ input_path: invalid, output_path: path.join(directory, 'invalid.json'), direction: 'xml-to-json' }), { code: 'INVALID_UTF8' });
  const huge = path.join(directory, 'huge.xml'), file = await open(huge, 'w'); await file.truncate(MAX_STRUCTURED_INPUT_BYTES + 1); await file.close();
  await assert.rejects(convertXmlJson({ input_path: huge, output_path: path.join(directory, 'huge.json'), direction: 'xml-to-json' }), { code: 'INPUT_SIZE' });
  await assert.rejects(convertXmlJson({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), cancelled = path.join(directory, 'cancel.json'), pending = convertXmlJson({ input_path: input, output_path: cancelled, direction: 'xml-to-json' }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  await assert.rejects(readFile(cancelled), { code: 'ENOENT' }); assert.equal(hash(await readFile(input)), hash(source));
});
