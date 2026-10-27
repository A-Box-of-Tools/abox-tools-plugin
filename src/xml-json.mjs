import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { xmlToJson, jsonToXml } from '../vendor/abox/tools/xml-formatter/src/convert.js';
import { parseJson, printJson } from '../vendor/abox/shared/js/parse-json.js';
import { parseXml, unescapeXml, xmlSpace } from '../vendor/abox/shared/js/parse-xml.js';
import { ParseError } from '../vendor/abox/shared/js/parse-errors.js';
import { preflightStructuredJson, preflightStructuredXml, inspectStructuredTree, structuredJsonBytes,
  MAX_STRUCTURED_INPUT_BYTES, MAX_STRUCTURED_OUTPUT_BYTES, MAX_STRUCTURED_DEPTH, MAX_STRUCTURED_NODES } from './structured-text.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

const limit = () => { throw new AdapterError('OUTPUT_SIZE', 'The predicted XML/JSON conversion exceeds the 16 MiB output expansion limit.'); };
const unsupported = () => { throw new AdapterError('XML_JSON_UNSUPPORTED', 'JSON to XML refuses duplicate member names, colliding sanitized names and namespace-prefixed names that the source converter cannot bind. No output was written.'); };
const verify = () => { throw new AdapterError('VERIFICATION_FAILED', 'The conversion did not match the existing engine’s exact documented mapping. No output was written.'); };
const string = value => ({ t: 'str', value });
const map = pairs => ({ t: 'map', pairs });
function settingsFor(args) {
  const settings = { direction: args.direction, indent: args.indent === undefined ? '2' : args.indent };
  if (!['xml-to-json', 'json-to-xml'].includes(settings.direction) || !['2', '4', 'tab'].includes(settings.indent)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose xml-to-json or json-to-xml and indent 2, 4 or tab.');
  }
  return settings;
}

// This independent, iterative expectation uses the source parser's AST; it
// verifies the lossy conversion rule, never a semantic XML/JSON round trip.
function expectedJson(nodes) {
  const root = nodes.find(node => node.t === 'element'), done = new Map(), stack = [{ element: root, inherited: false, ready: false }];
  while (stack.length) {
    const item = stack.pop(), { element } = item, preserve = xmlSpace(element, item.inherited), children = element.children.filter(child => child.t === 'element');
    if (!item.ready) {
      stack.push({ ...item, ready: true });
      for (let index = children.length - 1; index >= 0; index--) stack.push({ element: children[index], inherited: preserve, ready: false });
      continue;
    }
    const pairs = element.attrs.map(attribute => ({ key: `@${attribute.name}`, value: string(unescapeXml(attribute.value ?? '')) }));
    const own = element.children.filter(child => child.t === 'text' || child.t === 'cdata')
      .map(child => child.t === 'cdata' ? child.text : unescapeXml(child.text)).join('');
    const layout = children.length && !preserve && /^[ \t\r\n]*$/.test(own) && !element.children.some(child => child.t === 'cdata');
    const text = layout ? '' : own;
    if (!children.length && !pairs.length) { done.set(element, text === '' ? { t: 'null' } : string(text)); continue; }
    const byName = new Map();
    for (const child of children) { if (!byName.has(child.name)) byName.set(child.name, []); byName.get(child.name).push(done.get(child)); }
    for (const [key, values] of byName) pairs.push({ key, value: values.length === 1 ? values[0] : { t: 'seq', items: values } });
    if (text !== '') pairs.push({ key: '#text', value: string(text) });
    done.set(element, map(pairs));
  }
  return map([{ key: root.name, value: done.get(root) }]);
}
function nameFor(key) {
  const cleaned = key.replace(/[^A-Za-z0-9_.:-]/g, '_'), name = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  if (name.includes(':')) unsupported(); return name;
}
const scalar = node => node.t === 'num' ? node.raw : node.t === 'bool' ? node.value ? 'true' : 'false' : node.value;
const escapedBytes = value => Buffer.byteLength(String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character])));
function expectedXml(tree, indent) {
  let bytes = Buffer.byteLength('<?xml version="1.0" encoding="UTF-8"?>\n'), renamed = 0, elements = 0;
  const root = { name: 'root', children: [] }, stack = [];
  const admit = amount => { bytes += amount; if (!Number.isSafeInteger(bytes) || bytes > MAX_STRUCTURED_OUTPUT_BYTES) limit(); };
  const add = (name, node, depth, parent) => stack.push({ name, node, depth, parent });
  const childrenFor = (node, name, parent, depth) => {
    if (node.t === 'map') {
      const names = new Set();
      for (const pair of node.pairs) {
        const converted = nameFor(pair.key); if (names.has(converted)) unsupported(); names.add(converted);
        if (converted !== pair.key) renamed++;
      }
      for (let index = node.pairs.length - 1; index >= 0; index--) { const pair = node.pairs[index]; add(nameFor(pair.key), pair.value, depth, parent); }
    } else for (let index = node.items.length - 1; index >= 0; index--) add(name, node.items[index], depth, parent);
  };
  if (tree.t === 'seq') {
    admit('<root>\n</root>\n'.length); root.container = true;
    if (!tree.items.length) root.text = '\n'; childrenFor(tree, 'item', root, 1);
  } else add('root', tree, 0, null);
  let result;
  while (stack.length) {
    const { name, node, depth, parent } = stack.pop();
    if (depth + 1 > MAX_STRUCTURED_DEPTH) throw new AdapterError('STRUCTURED_LIMIT', 'Converted XML exceeds 128 nested elements.');
    if (node.t === 'seq' && node.items.length) { childrenFor(node, name, parent, depth); continue; }
    if (++elements > MAX_STRUCTURED_NODES) throw new AdapterError('STRUCTURED_LIMIT', 'Converted XML exceeds 100000 elements.');
    const element = { name, children: [] };
    if (parent) parent.children.push(element); else result = element;
    const prefix = depth * indent.length;
    if (node.t === 'map' && node.pairs.length) {
      admit(2 * prefix + 2 * Buffer.byteLength(name) + 7); element.container = true; childrenFor(node, name, element, depth + 1);
    } else if (node.t === 'null' || node.t === 'map' || node.t === 'seq') admit(prefix + Buffer.byteLength(name) + 4);
    else {
      element.text = scalar(node);
      if (typeof element.text !== 'string' || !element.text.isWellFormed()) {
        throw new AdapterError('XML_JSON_UNSUPPORTED', 'A JSON string cannot be represented without replacing Unicode characters in UTF-8 XML.');
      }
      admit(prefix + 2 * Buffer.byteLength(name) + escapedBytes(element.text) + 6);
    }
  }
  return { root: tree.t === 'seq' ? root : result, bytes, renamed, elements: elements + (tree.t === 'seq' ? 1 : 0) };
}
function xmlFacts(root, expected = false) {
  const facts = [], stack = [{ node: root, closing: false }];
  while (stack.length) {
    const { node, closing } = stack.pop();
    if (closing) { facts.push(['close', node.name]); continue; }
    facts.push(['open', node.name]); stack.push({ node, closing: true });
    if (expected) {
      if (node.text !== undefined && node.text !== '') facts.push(['text', node.text]);
      for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index], closing: false });
    } else {
      if (node.attrs.length) verify();
      const children = node.children.filter(child => child.t === 'element'), own = node.children.filter(child => child.t === 'text').map(child => unescapeXml(child.text)).join('');
      if (node.children.some(child => !['element', 'text'].includes(child.t))) verify();
      if (children.length) {
        if (!/^[ \t\r\n]*$/.test(own)) verify();
        for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], closing: false });
      } else if (own !== '') facts.push(['text', own]);
    }
  }
  return facts;
}

function processText(bytes, settings) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AdapterError('INVALID_UTF8', 'The input must contain valid UTF-8 text.'); }
  const indent = settings.indent === 'tab' ? '\t' : ' '.repeat(Number(settings.indent));
  let output, expected, inputSummary, outputSummary, renamed = 0;
  if (settings.direction === 'xml-to-json') {
    preflightStructuredXml(text); const source = parseXml(text, { html: false });
    expected = expectedJson(source); inputSummary = { node_count: 0, max_depth: 0 };
    const stack = source.map(node => ({ node, depth: 0 }));
    while (stack.length) {
      const { node, depth } = stack.pop(); inputSummary.node_count++;
      if (node.t === 'element') { inputSummary.node_count += node.attrs.length; inputSummary.max_depth = Math.max(inputSummary.max_depth, depth + 1);
        for (const child of node.children) stack.push({ node: child, depth: depth + 1 }); }
    }
    outputSummary = inspectStructuredTree(expected); const predicted = structuredJsonBytes(expected, indent);
    output = xmlToJson(text, { indent });
    if (Buffer.byteLength(output) !== predicted) verify(); preflightStructuredJson(output);
    const checked = parseJson(output); inspectStructuredTree(checked);
    if (printJson(expected, { indent: '' }) !== printJson(checked, { indent: '' })) verify();
  } else {
    preflightStructuredJson(text); const source = parseJson(text); inputSummary = inspectStructuredTree(source);
    expected = expectedXml(source, indent); renamed = expected.renamed;
    output = jsonToXml(text, { indent, root: 'root' });
    if (Buffer.byteLength(output) !== expected.bytes) verify();
    try { preflightStructuredXml(output); } catch {
      throw new AdapterError('XML_JSON_UNSUPPORTED', 'The JSON contains characters or names that the unchanged converter cannot represent in supported XML. No output was written.');
    }
    const checked = parseXml(output, { html: false }), root = checked.find(node => node.t === 'element');
    if (JSON.stringify(xmlFacts(expected.root, true)) !== JSON.stringify(xmlFacts(root))) verify();
    outputSummary = { node_count: expected.elements, max_depth: inputSummary.max_depth };
  }
  if (!output.isWellFormed()) throw new AdapterError('XML_JSON_UNSUPPORTED', 'The conversion cannot preserve this input in UTF-8.');
  const data = new TextEncoder().encode(output); if (data.length > MAX_STRUCTURED_OUTPUT_BYTES) limit();
  return { data, summary: { input_nodes: inputSummary.node_count, output_nodes: outputSummary.node_count, max_input_depth: inputSummary.max_depth,
    renamed_keys: renamed, lossy_mapping: true, verification: { source_mapping: true, parsed_output: true, semantic_roundtrip: false } } };
}

async function isolated(bytes, settings, { signal } = {}) {
  const input = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-xml-json', input, settings }, transferList: [input.buffer],
    execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'XML/JSON conversion exceeded two minutes.')), 120000);
    worker.on('message', message => {
      if (!message.error) return finish(null, message.result);
      const error = new AdapterError(message.error.code, message.error.message);
      if (Number.isSafeInteger(message.error.line)) { error.line = message.error.line; error.column = message.error.column; }
      finish(error);
    });
    worker.on('error', () => finish(new AdapterError('STRUCTURED_PROCESSING_FAILED', 'The isolated converter could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('STRUCTURED_PROCESSING_FAILED', 'The isolated converter stopped before returning a verified output.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
export async function convertXmlJson(args, options = {}) {
  options.signal?.throwIfAborted(); const settings = settingsFor(args), format = settings.direction === 'xml-to-json' ? 'json' : 'xml', output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== `.${format}`) throw new AdapterError('OUTPUT_EXTENSION', `Use a new .${format} output file.`);
  const input = await readInput(args.input_path, { allow_empty: true, max_bytes: MAX_STRUCTURED_INPUT_BYTES }); options.signal?.throwIfAborted();
  const made = await isolated(input.data, settings, options), data = Buffer.from(made.data); options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'xml-json', input_path: input.path, output_path: output, input_bytes: input.data.length, output_bytes: data.length,
    format, encoding: 'utf-8', ...settings, verified: true, ...made.summary,
    warnings: ['This is a verified application of the source converter’s lossy mapping, not semantic XML/JSON round-trip equivalence.',
      'XML values become strings (empty elements become null); attributes use @, repeated children become arrays, and mixed text uses #text. Comments, processing instructions and interleaved content order are lost.',
      'JSON uses a fixed root element named root, and top-level arrays use item. Null, empty arrays and empty maps collapse; numbers and booleans become XML text. Invalid key characters are replaced by underscores; ambiguous duplicate/colliding or prefixed names are refused.'] };
}

if (!isMainThread && workerData?.kind === 'abox-xml-json') {
  try { const result = processText(workerData.input, workerData.settings); parentPort.postMessage({ result }, [result.data.buffer]); }
  catch (error) {
    const failure = error instanceof ParseError ? { code: 'INVALID_XML_JSON', message: `Invalid or unsupported input at line ${error.line}, column ${error.column}.`, line: error.line, column: error.column }
      : error instanceof AdapterError ? { code: error.code, message: error.message }
        : { code: 'STRUCTURED_PROCESSING_FAILED', message: 'The existing XML/JSON converter could not process this input. No output was written; input contents are excluded from errors.' };
    parentPort.postMessage({ error: failure });
  } finally { parentPort.close(); }
}
