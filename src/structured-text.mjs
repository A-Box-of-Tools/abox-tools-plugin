import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { jsonToYaml, yamlToJson } from '../vendor/abox/tools/yaml-to-json/src/convert.js';
import { parseJson, printJson, jsonString } from '../vendor/abox/shared/js/parse-json.js';
import { parseYaml } from '../vendor/abox/shared/js/parse-yaml.js';
import { parseXml, printXml } from '../vendor/abox/shared/js/parse-xml.js';
import { ParseError } from '../vendor/abox/shared/js/parse-errors.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_STRUCTURED_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_STRUCTURED_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_STRUCTURED_DEPTH = 128;
export const MAX_STRUCTURED_NODES = 100_000;
const TIMEOUT_MS = 120_000;

function settingsFor(args, kind) {
  if (kind === 'yaml') {
    const settings = { direction: args.direction, indent: args.indent ?? '2', sort_keys: args.sort_keys ?? false };
    if (!['yaml-to-json', 'json-to-yaml'].includes(settings.direction) || !['2', '4'].includes(settings.indent)
        || typeof settings.sort_keys !== 'boolean' || (settings.direction === 'json-to-yaml' && settings.sort_keys)) {
      throw new AdapterError('INVALID_ARGUMENTS', 'Choose yaml-to-json or json-to-yaml, indent 2 or 4, and optional sort_keys for YAML to JSON only.');
    }
    return settings;
  }
  const settings = { minify: args.minify ?? false, indent: args.indent ?? '2' };
  if (typeof settings.minify !== 'boolean' || !['2', '4', 'tab'].includes(settings.indent)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose boolean minify and indent 2, 4 or tab.');
  }
  return settings;
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AdapterError('INVALID_UTF8', 'The input must contain valid UTF-8 text.'); }
}

function encodedOutput(text) {
  // JSON can contain an escaped lone surrogate. The unchanged YAML printer
  // can emit it literally; UTF-8 would replace it, so that result is refused.
  if (!text.isWellFormed()) throw new AdapterError('UNSUPPORTED_TEXT', 'The conversion produced a value that cannot be preserved in UTF-8. No output was written.');
  return new TextEncoder().encode(text);
}

function limit(message) { throw new AdapterError('STRUCTURED_LIMIT', message); }
function sizeLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes > MAX_STRUCTURED_OUTPUT_BYTES) {
    throw new AdapterError('OUTPUT_SIZE', 'The predicted structured-text output exceeds the 16 MiB expansion limit. Use a smaller document or less indentation.');
  }
}
function depthLimit(depth) {
  if (depth > MAX_STRUCTURED_DEPTH) limit('Structured text supports at most 128 nested containers or elements.');
}
function countLimit(count) {
  if (count > MAX_STRUCTURED_NODES) limit('Structured text supports at most 100000 syntax nodes, including keys and attributes.');
}

function preflightJson(text) {
  let depth = 0, count = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (' \t\r\n,:'.includes(char)) continue;
    if (char === '}' || char === ']') { depth = Math.max(0, depth - 1); continue; }
    countLimit(++count);
    if (char === '{' || char === '[') depthLimit(++depth);
    else if (char === '"') {
      for (at++; at < text.length; at++) {
        if (text[at] === '\\') at++;
        else if (text[at] === '"') break;
      }
    } else while (at + 1 < text.length && !' \t\r\n,:{}[]"'.includes(text[at + 1])) at++;
  }
}

// The source YAML parser supports one-line flow collections and indented blocks.
// This guard counts possible allocations and recursive collection depth; it does
// not interpret scalar values or replace the source parser's syntax decisions.
function preflightYaml(text) {
  const blocks = [];
  let count = 0, scalarParent = null, documentStarted = false, startMarker = false, documentEnded = false;
  const add = (amount = 1) => { count += amount; countLimit(count); };
  const container = (indent, kind) => {
    while (blocks.length && blocks.at(-1).indent > indent) blocks.pop();
    if (kind === 'map') {
      while (blocks.length && blocks.at(-1).indent === indent && blocks.at(-1).kind !== kind) blocks.pop();
    }
    if (!blocks.length || blocks.at(-1).indent !== indent || blocks.at(-1).kind !== kind) {
      blocks.push({ indent, kind }); add();
    }
    depthLimit(blocks.length);
  };
  const keyEnd = value => {
    let quote = null;
    for (let at = 0; at < value.length; at++) {
      const char = value[at];
      if (quote) {
        if (quote === '"' && char === '\\') at++;
        else if (char === quote) {
          if (quote === "'" && value[at + 1] === "'") at++;
          else quote = null;
        }
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '{' || char === '#' && (at === 0 || /\s/.test(value[at - 1]))) return -1;
      else if (char === ':' && (at + 1 === value.length || value[at + 1] === ' ')) return at;
    }
    return -1;
  };
  const flow = (value, baseDepth) => {
    let depth = 0;
    for (let at = 0; at < value.length; at++) {
      const char = value[at];
      if (' \t,'.includes(char)) continue;
      if (char === '#' && (at === 0 || /\s/.test(value[at - 1]) || '[{,:'.includes(value[at - 1]))) {
        if (depth) throw new AdapterError('UNSUPPORTED_YAML', 'Comments inside open YAML flow collections are unsupported.');
        break;
      }
      if (char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
      if (char === ':') { add(); continue; }
      add();
      if (char === '[' || char === '{') depthLimit(baseDepth + ++depth);
      else if (char === '"' || char === "'") {
        const quote = char;
        for (at++; at < value.length; at++) {
          if (quote === '"' && value[at] === '\\') at++;
          else if (value[at] === quote) {
            if (quote === "'" && value[at + 1] === "'") at++;
            else break;
          }
        }
      } else {
        if ('&*!'.includes(char)) throw new AdapterError('UNSUPPORTED_YAML', 'YAML anchors, aliases and explicit tags are unsupported.');
        while (at + 1 < value.length && !',:{}[]'.includes(value[at + 1])) {
          at++;
          if (depth && value[at] === '#' && /\s/.test(value[at - 1])) {
            throw new AdapterError('UNSUPPORTED_YAML', 'Comments inside open YAML flow collections are unsupported.');
          }
        }
      }
    }
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (scalarParent !== null && indent > scalarParent) continue;
    scalarParent = null;
    if (/[^ ]/.test(line.slice(0, indent))) throw new AdapterError('UNSUPPORTED_YAML', 'Use spaces for YAML block indentation.');
    while (blocks.length && blocks.at(-1).indent > indent) blocks.pop();
    if (/^(?:---|\.\.\.)[ \t]+#/.test(trimmed)) {
      throw new AdapterError('UNSUPPORTED_YAML', 'Use bare YAML document markers; comments on document-marker lines are unsupported by the source engine.');
    }
    if (trimmed === '---' || trimmed === '...') {
      if (indent || documentEnded || trimmed === '---' && (documentStarted || startMarker)) {
        throw new AdapterError('UNSUPPORTED_YAML', 'Only one YAML document is supported; document markers must be at the root.');
      }
      if (trimmed === '---') startMarker = true;
      else documentEnded = true;
      continue;
    }
    if (documentEnded) throw new AdapterError('UNSUPPORTED_YAML', 'Content after a YAML document end marker is unsupported.');
    documentStarted = true;
    let rest = line.slice(indent), column = indent, scalarBase = null;
    while (rest === '-' || rest.startsWith('- ')) {
      container(column, 'seq'); add(); scalarBase = column;
      const length = rest.length;
      rest = rest.slice(1).replace(/^ +/, ''); column += length - rest.length;
    }
    const key = keyEnd(rest);
    if (key >= 0) {
      container(column, 'map'); add(2); scalarBase = column;
      if (/^[&*!]/.test(rest.trimStart())) throw new AdapterError('UNSUPPORTED_YAML', 'YAML anchors, aliases and explicit tags are unsupported.');
      rest = rest.slice(key + 1).trimStart();
    }
    if (!rest || rest.startsWith('#')) continue;
    if (scalarBase !== null && /^[|>][+\-0-9]*\s*(?:#.*)?$/.test(rest)) { scalarParent = scalarBase; add(); continue; }
    if (rest[0] === '[' || rest[0] === '{') flow(rest, blocks.length);
    else {
      if (/^[&*!]/.test(rest)) throw new AdapterError('UNSUPPORTED_YAML', 'YAML anchors, aliases and explicit tags are unsupported.');
      add();
    }
  }
}

function inspectTree(root) {
  const stack = [{ node: root, depth: 0 }];
  let count = 0, maximum = 0;
  while (stack.length) {
    const { node, depth } = stack.pop(); countLimit(++count);
    if (node.t === 'map' || node.t === 'seq') {
      const next = depth + 1; depthLimit(next); maximum = Math.max(maximum, next);
      if (node.t === 'map') {
        count += node.pairs.length; countLimit(count);
        for (const pair of node.pairs) stack.push({ node: pair.value, depth: next });
      } else for (const item of node.items) stack.push({ node: item, depth: next });
    }
  }
  return { node_count: count, max_depth: maximum };
}

function jsonBytes(root, indent) {
  let bytes = 1;
  const gap = indent.length ? 1 : 0, stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (node.t === 'map' || node.t === 'seq') {
      const entries = node.t === 'map' ? node.pairs : node.items, count = entries.length;
      bytes += 2;
      if (count) {
        bytes += 2 * gap + depth * indent.length + (count - 1) * (1 + gap) + count * (depth + 1) * indent.length;
        for (const entry of entries) {
          if (node.t === 'map') {
            bytes += Buffer.byteLength(jsonString(entry.key), 'utf8') + (gap ? 2 : 1);
            stack.push({ node: entry.value, depth: depth + 1 });
          } else stack.push({ node: entry, depth: depth + 1 });
        }
      }
    } else if (node.t === 'str') bytes += Buffer.byteLength(jsonString(node.value), 'utf8');
    else if (node.t === 'num') bytes += node.raw.length;
    else bytes += node.t === 'bool' && !node.value ? 5 : 4;
    sizeLimit(bytes);
  }
  return bytes;
}

function yamlUpperBytes(root, indent) {
  const stack = [{ node: root, depth: 0 }]; let bytes = 1;
  while (stack.length) {
    const { node, depth } = stack.pop();
    const pad = (depth + 1) * indent;
    bytes += pad + 10;
    if (node.t === 'map') {
      for (const pair of node.pairs) {
        bytes += pair.key.length * 6 + 4;
        stack.push({ node: pair.value, depth: depth + 1 });
      }
    } else if (node.t === 'seq') {
      for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
    } else if (node.t === 'str') {
      bytes += node.value.length * 6 + 2;
      let lines = 1; for (const char of node.value) if (char === '\n') lines++;
      bytes += lines * (pad + indent + 1);
    } else if (node.t === 'num') bytes += node.raw.length;
    else bytes += 5;
    sizeLimit(bytes);
  }
  return bytes;
}

function plainTree(root) {
  const make = node => node.t === 'map' ? { t: 'map', pairs: [] } : node.t === 'seq' ? { t: 'seq', items: [] }
    : node.t === 'str' ? { t: 'str', value: node.value } : { ...node };
  const result = make(root), stack = [[root, result]];
  while (stack.length) {
    const [source, target] = stack.pop();
    if (source.t === 'map') {
      for (const pair of source.pairs) {
        const value = make(pair.value); target.pairs.push({ key: pair.key, value }); stack.push([pair.value, value]);
      }
    } else if (source.t === 'seq') {
      for (const item of source.items) { const value = make(item); target.items.push(value); stack.push([item, value]); }
    }
  }
  return result;
}

function convertYaml(text, settings) {
  const toJson = settings.direction === 'yaml-to-json';
  toJson ? preflightYaml(text) : preflightJson(text);
  const tree = toJson ? parseYaml(text) : parseJson(text);
  const summary = inspectTree(tree), indent = ' '.repeat(Number(settings.indent));
  const predicted = toJson ? jsonBytes(tree, indent) : yamlUpperBytes(tree, Number(settings.indent));
  let comments = 0;
  const output = toJson ? yamlToJson(text, { indent, sortKeys: settings.sort_keys, onDiagnostic: () => comments++ })
    : jsonToYaml(text, { indent: Number(settings.indent) });
  const bytes = Buffer.byteLength(output, 'utf8'); sizeLimit(bytes);
  if (toJson ? bytes !== predicted : bytes > predicted) throw new AdapterError('VERIFICATION_FAILED', 'The conversion did not match its bounded output estimate.');
  toJson ? preflightJson(output) : preflightYaml(output);
  let checked;
  try { checked = toJson ? parseJson(output) : parseYaml(output); }
  catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const advice = !toJson && settings.indent === '4' ? ' Try indent 2 for lists.' : '';
    throw new AdapterError('VERIFICATION_FAILED', `The existing printer produced an unsupported output shape. Root multiline YAML scalars and some four-space lists cannot round trip.${advice} No output was written.`);
  }
  inspectTree(checked);
  const before = plainTree(tree), after = plainTree(checked);
  jsonBytes(before, ''); jsonBytes(after, '');
  const options = { indent: '', sortKeys: settings.sort_keys };
  if (printJson(before, options) !== printJson(after, options)) {
    throw new AdapterError('VERIFICATION_FAILED', 'The converted document did not retain its ordered values, duplicate keys and numeric tokens. No output was written.');
  }
  return { data: encodedOutput(output), summary: { ...summary, comments_removed: comments,
    warnings: [toJson ? 'YAML comments and presentation are not preserved in JSON. Only the source engine’s supported YAML subset is accepted.'
      : 'YAML output can change string quoting and escape spellings while preserving supported ordered values.'] } };
}

// XML 1.0 Fifth Edition and XML 1.1 share these Name productions. The source
// formatter is reused unchanged; this gate closes its permissive name and
// attribute cases before it can label an invalid XML result as verified.
// https://www.w3.org/TR/xml/#NT-NameStartChar
const XML_NAME_START = String.raw`:A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}`;
const XML_NAME = new RegExp(`^[${XML_NAME_START}][${XML_NAME_START}0-9.\\-\\u00b7\\u0300-\\u036f\\u203f-\\u2040]*$`, 'u');
const xmlSpace = char => char !== undefined && ' \t\r\n'.includes(char);

function xmlCharacters(text) {
  const version11 = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(['"])1\.1\1/.test(text);
  let index = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const invalid = code === 0 || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff
      || code < 0x20 && ![9, 10, 13].includes(code)
      || version11 && (code >= 0x7f && code <= 0x84 || code >= 0x86 && code <= 0x9f);
    if (invalid) throw new ParseError('xml.character', index, text);
    index += char.length;
  }
}

function xmlTag(raw, offset, source) {
  const closing = raw.startsWith('</'); let at = closing ? 2 : 1;
  const fail = () => { throw new ParseError('xml.syntax', offset + at, source); };
  const readName = attribute => {
    const start = at;
    while (at < raw.length && !xmlSpace(raw[at]) && !'/>= '.includes(raw[at])) at++;
    const value = raw.slice(start, at);
    if (!XML_NAME.test(value) || !attribute && raw[at] === '=') fail();
    return value;
  };
  readName(false);
  if (closing) {
    while (xmlSpace(raw[at])) at++;
    if (raw.slice(at) !== '>') fail();
    return;
  }
  const seen = new Set();
  while (at < raw.length) {
    const previous = at;
    while (xmlSpace(raw[at])) at++;
    if (raw.slice(at) === '>' || raw.slice(at) === '/>') return;
    if (at === previous) fail();
    const name = readName(true);
    if (seen.has(name)) fail();
    seen.add(name);
    while (xmlSpace(raw[at])) at++;
    if (raw[at++] !== '=') fail();
    while (xmlSpace(raw[at])) at++;
    const quote = raw[at++];
    if (quote !== '"' && quote !== "'") fail();
    const end = raw.indexOf(quote, at);
    if (end < 0 || raw.slice(at, end).includes('<')) fail();
    at = end + 1;
  }
  fail();
}

function preflightXml(text) {
  xmlCharacters(text);
  let at = 0, depth = 0, nodes = 0;
  const add = () => countLimit(++nodes);
  const references = value => {
    for (let index = value.indexOf('&'); index >= 0; index = value.indexOf('&', index + 1)) {
      const reference = /^&(?:lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/.exec(value.slice(index));
      if (!reference) throw new AdapterError('UNSUPPORTED_XML', 'Custom or malformed XML entity references are unsupported.');
      index += reference[0].length - 1;
    }
  };
  while (at < text.length) {
    if (text[at] !== '<') {
      const end = text.indexOf('<', at), next = end < 0 ? text.length : end;
      if (next > at) {
        add(); const value = text.slice(at, next); references(value);
        if (value.includes(']]>')) throw new ParseError('xml.character', at + value.indexOf(']]>'), text);
      }
      at = next; continue;
    }
    if (text.startsWith('<!--', at) || text.startsWith('<![CDATA[', at) || text.startsWith('<?', at)) {
      const comment = text.startsWith('<!--', at), cdata = text.startsWith('<![CDATA[', at);
      const close = comment ? '-->' : cdata ? ']]>' : '?>', start = at + (comment ? 4 : cdata ? 9 : 2);
      const end = text.indexOf(close, start); add();
      if (end < 0) return;
      const directive = text.slice(at, end + close.length);
      if (comment) {
        const value = text.slice(start, end);
        if (value.includes('--') || value.endsWith('-')) throw new ParseError('xml.comment', at, text);
      }
      if (!comment && !cdata && /^<\?xml(?=[\s?])/i.test(directive)) {
        const encoding = /\bencoding\s*=\s*(['"])(.*?)\1/i.exec(directive)?.[2];
        if (encoding && !/^utf-?8$/i.test(encoding)) throw new AdapterError('UNSUPPORTED_XML', 'Only UTF-8 XML encoding declarations are supported.');
        const version = /\bversion[ \t\r\n]*=[ \t\r\n]*(['"])(.*?)\1/.exec(directive)?.[2];
        if (version !== '1.0' && version !== '1.1') throw new ParseError('xml.declarationinvalid', at, text);
      } else if (!comment && !cdata) {
        const instruction = /^<\?([^? \t\r\n]+)(?:[ \t\r\n][\s\S]*)?\?>$/.exec(directive);
        if (!instruction || !XML_NAME.test(instruction[1])) throw new ParseError('xml.declarationinvalid', at, text);
      }
      at = end + close.length; continue;
    }
    if (text.startsWith('<!', at)) throw new AdapterError('UNSUPPORTED_XML', 'XML DTD and entity declarations are unsupported and are never resolved.');
    const closing = text.startsWith('</', at); let quote = null, end = at + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") { quote = char; add(); }
      else if (char === '>') break;
    }
    if (end >= text.length) return;
    const tag = text.slice(at, end + 1); references(tag); xmlTag(tag, at, text);
    if (closing) depth = Math.max(0, depth - 1);
    else { add(); depthLimit(depth + 1); if (!/\/\s*>$/.test(tag)) depth++; }
    at = end + 1;
  }
}

function xmlUpperBytes(nodes, sourceBytes, indent, minify) {
  let bytes = sourceBytes + 1, count = 0, maximum = 0;
  const stack = nodes.map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop(); countLimit(++count);
    bytes += 4 + (minify ? 0 : 2 * depth * indent.length);
    if (node.t === 'element') {
      depthLimit(depth + 1); maximum = Math.max(maximum, depth + 1);
      count += node.attrs.length; countLimit(count); bytes += node.attrs.length;
      for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
    }
    sizeLimit(bytes);
  }
  return { bytes, node_count: count, max_depth: maximum };
}

function formatXmlText(text, settings) {
  preflightXml(text);
  const tree = parseXml(text, { html: false });
  const indent = settings.indent === 'tab' ? '\t' : ' '.repeat(Number(settings.indent));
  const bound = xmlUpperBytes(tree, Buffer.byteLength(text), indent, settings.minify);
  const output = printXml(tree, { indent, minify: settings.minify, html: false });
  const bytes = Buffer.byteLength(output); sizeLimit(bytes);
  if (bytes > bound.bytes) throw new AdapterError('VERIFICATION_FAILED', 'The XML formatter exceeded its bounded output estimate.');
  preflightXml(output);
  const checked = parseXml(output, { html: false });
  xmlUpperBytes(checked, bytes, '', true);
  if (printXml(tree, { minify: true, html: false }) !== printXml(checked, { minify: true, html: false })) {
    throw new AdapterError('VERIFICATION_FAILED', 'XML mixed content, preserved whitespace or structure changed during formatting. No output was written.');
  }
  return { data: encodedOutput(output), summary: { node_count: bound.node_count, max_depth: bound.max_depth,
    warnings: ['Formatting can change whitespace between element-only children. Mixed content, xml:space, comments and CDATA follow the source engine’s preservation rules.'] } };
}

function publicFailure(error, kind) {
  if (error instanceof ParseError) return { code: kind === 'xml' ? 'INVALID_XML' : 'INVALID_YAML_JSON',
    message: `Invalid or unsupported structured text at line ${error.line}, column ${error.column}.`, line: error.line, column: error.column };
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  return { code: 'STRUCTURED_PROCESSING_FAILED', message: 'The existing structured-text engine could not process this input. No output was written.' };
}

async function runWorker(bytes, kind, settings, options) {
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-structured-text', job: kind, bytes: data, settings },
    transferList: [data.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Structured-text processing exceeded the two-minute limit. Use a smaller input.')), TIMEOUT_MS);
    worker.on('message', message => {
      if (message.type === 'result') finish(null, message.result);
      else if (message.type === 'error') {
        const error = new AdapterError(message.error.code, message.error.message);
        if (Number.isSafeInteger(message.error.line)) { error.line = message.error.line; error.column = message.error.column; }
        finish(error);
      }
    });
    worker.on('error', () => finish(new AdapterError('STRUCTURED_PROCESSING_FAILED', 'The isolated structured-text worker could not finish within its resource limits.')));
    worker.on('exit', () => finish(new AdapterError('STRUCTURED_PROCESSING_FAILED', 'The isolated structured-text worker stopped before producing an output.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

async function processFile(args, options, kind) {
  options.signal?.throwIfAborted();
  const settings = settingsFor(args, kind), output = await newOutput(args.output_path);
  const format = kind === 'xml' ? 'xml' : settings.direction === 'yaml-to-json' ? 'json' : 'yaml';
  if (!(format === 'yaml' ? ['.yaml', '.yml'] : [`.${format}`]).includes(path.extname(output).toLowerCase())) {
    throw new AdapterError('OUTPUT_EXTENSION', `Use an output filename ending in ${format === 'yaml' ? '.yaml or .yml' : `.${format}`}.`);
  }
  const input = await readInput(args.input_path, { allow_empty: true, max_bytes: MAX_STRUCTURED_INPUT_BYTES });
  options.signal?.throwIfAborted();
  const made = await runWorker(input.data, kind, settings, options), data = Buffer.from(made.data);
  sizeLimit(data.length); options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: kind === 'xml' ? 'format-xml' : 'yaml-json', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format, encoding: 'utf-8', verified: true, ...settings, ...made.summary };
}

export function convertYamlJson(args, options = {}) { return processFile(args, options, 'yaml'); }
export function formatXml(args, options = {}) { return processFile(args, options, 'xml'); }

if (!isMainThread && workerData?.kind === 'abox-structured-text') {
  try {
    const text = decode(workerData.bytes), result = workerData.job === 'xml' ? formatXmlText(text, workerData.settings) : convertYaml(text, workerData.settings);
    parentPort.postMessage({ type: 'result', result }, [result.data.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'error', error: publicFailure(error, workerData.job) }); }
  finally { parentPort.close(); }
}
