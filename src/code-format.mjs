import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseXml, printXml } from '../vendor/abox/shared/js/parse-xml.js';
import { parseCss, printCss } from '../vendor/abox/tools/json-formatter/src/css.js';
import { parseYaml, printYaml } from '../vendor/abox/shared/js/parse-yaml.js';
import { printJson } from '../vendor/abox/shared/js/parse-json.js';
import { ParseError } from '../vendor/abox/shared/js/parse-errors.js';
import { preflightStructuredYaml, inspectStructuredTree, structuredYamlUpperBytes, plainStructuredTree, structuredJsonBytes } from './structured-text.mjs';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_CODE_FORMAT_INPUT_BYTES = 2 * 2 ** 20;
export const MAX_CODE_FORMAT_OUTPUT_BYTES = 16 * 2 ** 20;
export const MAX_CODE_FORMAT_DEPTH = 128;
export const MAX_CODE_FORMAT_NODES = 100_000;
const ASCII_SPACE = /[ \t\r\n\f]/;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const fail = (code, message) => { throw new AdapterError(code, message); };
const changed = () => fail('CODE_FORMAT_UNSUPPORTED', 'The existing formatter would change protected content or supported syntax tokens. This input is refused; no output was written.');
const bound = (bytes, count, depth) => {
  if (!Number.isSafeInteger(bytes) || bytes > MAX_CODE_FORMAT_OUTPUT_BYTES || count > MAX_CODE_FORMAT_NODES || depth > MAX_CODE_FORMAT_DEPTH) {
    fail('CODE_FORMAT_LIMIT', 'Formatting exceeds the 16 MiB output, 100000 syntax-node or 128-level nesting policy.');
  }
};
function settingsFor(args) {
  const { language } = args, minify = args.minify === undefined ? false : args.minify, indent = args.indent === undefined ? '2' : args.indent;
  if (!['html', 'css', 'yaml'].includes(language) || typeof minify !== 'boolean' || !['2', '4', 'tab'].includes(indent)
      || language === 'yaml' && (args.minify !== undefined || indent === 'tab') || minify && args.indent !== undefined) {
    fail('INVALID_ARGUMENTS', 'Choose html/css/yaml and indent 2 or 4 (HTML/CSS also tab). minify applies only to HTML/CSS; omit indent when minifying.');
  }
  return { language, minify, indent: indent === 'tab' ? '\t' : ' '.repeat(Number(indent)) };
}
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('INVALID_UTF8', 'The formatting input must contain valid UTF-8 text.'); }
}
function lexicalAdmission(text, language) {
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) fail('UNSUPPORTED_TEXT', 'Unsupported control characters cannot be formatted.');
  let count = 0, depth = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '\0' || char < ' ' && !'\t\r\n\f'.includes(char)) fail('UNSUPPORTED_TEXT', 'Unsupported control characters cannot be formatted.');
    if (language === 'html') {
      // Count attribute tokens too: boolean attributes have no equals sign and
      // can otherwise allocate far more nodes than the opening-tag count says.
      if (char === '<') {
        count += 3;
        const delimited = text.startsWith('<!--', at) ? ['-->', 4] : text.startsWith('<![CDATA[', at) ? [']]>', 9] : null;
        if (delimited) { const end = text.indexOf(delimited[0], at + delimited[1]); at = end < 0 ? text.length : end + delimited[0].length - 1; bound(0, count, 0); continue; }
        if (text.startsWith('<?', at) || text.startsWith('<!', at)) {
          const end = text.indexOf(text.startsWith('<?', at) ? '?>' : '>', at + 2); at = end < 0 ? text.length : end + (text.startsWith('<?', at) ? 1 : 0); bound(0, count, 0); continue;
        }
        const name = /^[A-Za-z_:][^\s/>]*/.exec(text.slice(at + 1))?.[0]?.toLowerCase();
        let quote = null, token = false;
        for (at++; at < text.length; at++) {
          const next = text[at];
          if (quote) { if (next === quote) quote = null; continue; }
          if (next === '"' || next === "'") { quote = next; if (!token) count++; token = true; }
          else if (next === '>') break;
          else if (/\s/.test(next) || next === '=') token = false;
          else if (!token) { token = true; count++; }
          bound(0, count, 0);
        }
        if ((name === 'script' || name === 'style') && text[at - 1] !== '/') {
          const close = new RegExp(`</${name}\\s*>`, 'ig'); close.lastIndex = at + 1; const found = close.exec(text);
          at = found ? close.lastIndex - 1 : text.length; count++;
        }
        bound(0, count, 0);
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      for (at++; at < text.length; at++) { if (text[at] === '\\') at++; else if (text[at] === quote) break; }
      continue;
    }
    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2); if (end < 0) break; at = end + 1; count++; bound(0, count, depth); continue;
    }
    // Parentheses are scanned iteratively by the source. Counting their braces
    // too is conservative and prevents any recursive block-parser overflow.
    if (char === '{') { depth++; count++; }
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === ';') count++;
    bound(0, count, depth);
  }
}
function htmlPlan(nodes, indent, minify) {
  const pending = nodes.map(node => ({ node, depth: 0 })); let bytes = 1, count = 0, maximum = 0;
  while (pending.length) {
    const { node, depth } = pending.pop(); count++; bytes += 16 + (minify ? 0 : 2 * (depth + 1) * indent.length);
    if (node.t === 'element') {
      maximum = Math.max(maximum, depth + 1); bytes += 2 * Buffer.byteLength(node.name) + 8; count += node.attrs.length;
      for (const attribute of node.attrs) bytes += Buffer.byteLength(attribute.name) + (attribute.value === null ? 2 : Buffer.byteLength(attribute.value) + 5);
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    } else bytes += Buffer.byteLength(node.text ?? '') + 12;
    bound(bytes, count, maximum);
  }
  return { upper_bytes: bytes, node_count: count, max_depth: maximum };
}
const ordinaryText = text => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');
function htmlFingerprint(nodes) {
  const events = [], pending = [...nodes].reverse().map(node => ({ node, end: false }));
  while (pending.length) {
    const { node, end } = pending.pop();
    if (end) { events.push(['end']); continue; }
    if (node.t === 'element') {
      events.push(['element', node.name, node.attrs.map(attribute => [attribute.name, attribute.value]), VOID.has(node.name) ? false : Boolean(node.selfClosed)]);
      pending.push({ node, end: true });
      for (let at = node.children.length - 1; at >= 0; at--) pending.push({ node: node.children[at], end: false });
    } else if (node.t === 'text') { const text = ordinaryText(node.text); if (text) events.push(['text', text]); }
    else events.push([node.t, node.text]);
  }
  return JSON.stringify(events);
}
function protectedHtml(text) {
  const spans = [], opening = /<(script|style|pre|textarea)(?=[\s/>])/gi; let found;
  while ((found = opening.exec(text))) {
    let at = opening.lastIndex, quote = null;
    for (; at < text.length; at++) {
      if (quote) { if (text[at] === quote) quote = null; }
      else if (text[at] === '"' || text[at] === "'") quote = text[at];
      else if (text[at] === '>') break;
    }
    if (at === text.length) break;
    const tag = found[1].toLowerCase(), close = new RegExp(`</${tag}\\s*>`, 'ig'); close.lastIndex = at + 1;
    const ended = close.exec(text); spans.push([tag, text.slice(at + 1, ended ? ended.index : text.length)]);
    opening.lastIndex = ended ? close.lastIndex : text.length;
  }
  return JSON.stringify(spans);
}
function formatHtml(text, settings) {
  lexicalAdmission(text, 'html'); const nodes = parseXml(text, { html: true }), plan = htmlPlan(nodes, settings.indent, settings.minify);
  const output = printXml(nodes, { ...settings, html: true });
  bound(Buffer.byteLength(output), 0, 0); if (Buffer.byteLength(output) > plan.upper_bytes) changed();
  lexicalAdmission(output, 'html'); const checked = parseXml(output, { html: true }); htmlPlan(checked, '', true);
  if (htmlFingerprint(nodes) !== htmlFingerprint(checked) || protectedHtml(text) !== protectedHtml(output)) changed();
  return { output, summary: { node_count: plan.node_count, max_depth: plan.max_depth,
    verification: { parsed_structure: true, attribute_values: true, protected_text: true, whitespace_identity: false, rendered_equivalence: false },
    warnings: ['The existing HTML formatter uses a limited HTML tree, can close omitted tags and change ordinary/inline whitespace. Rendering and behavior can change.',
      'Scripts, styles, event handlers, URLs and active content remain in the saved file. Nothing is executed or fetched here; formatting does not sanitize HTML or prove it safe.',
      'Inputs whose script/style/pre/textarea content would change are refused. This is not a JavaScript or CSS formatter for embedded code.'] } };
}

// This fingerprint is deliberately independent of the source whitespace
// collapse. Quoted strings and escapes remain exact, including spaces inside
// them; only ordinary CSS whitespace and comma layout are normalized.
function cssLexical(text) {
  const parts = []; let space = false;
  const add = token => { if (space && parts.length && parts.at(-1) !== ',' && token !== ',') parts.push(' '); parts.push(token); space = false; };
  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (ASCII_SPACE.test(char)) { space = true; at++; continue; }
    if (char === '"' || char === "'") {
      const from = at++, quote = char;
      for (; at < text.length; at++) { if (text[at] === '\\') at++; else if (text[at] === quote) { at++; break; } }
      add(text.slice(from, at)); continue;
    }
    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2); if (end < 0) changed(); add('/**/'); at = end + 2; continue;
    }
    if (char === '\\') {
      const from = at++; let hex = 0;
      while (hex < 6 && /[0-9a-fA-F]/.test(text[at] ?? '')) { at++; hex++; }
      if (hex && ASCII_SPACE.test(text[at] ?? '')) { if (text[at++] === '\r' && text[at] === '\n') at++; }
      else if (!hex && at < text.length) { if (text[at++] === '\r' && text[at] === '\n') at++; }
      add(text.slice(from, at)); continue;
    }
    if (char === ',') { add(','); at++; continue; }
    const from = at++;
    while (at < text.length && !ASCII_SPACE.test(text[at]) && !['"', "'", '\\', ','].includes(text[at]) && !(text[at] === '/' && text[at + 1] === '*')) at++;
    add(text.slice(from, at));
  }
  return parts.join('');
}
function cssPlan(nodes, settings) {
  const pending = nodes.map(node => ({ node, depth: 0 })); let count = 0, maximum = 0, bytes = 1;
  while (pending.length) {
    const { node, depth } = pending.pop(); count++; maximum = Math.max(maximum, depth + 1);
    bytes += 32 + (settings.minify ? 0 : 2 * (depth + 1) * settings.indent.length)
      + 2 * Buffer.byteLength(node.prelude ?? node.text ?? `${node.prop ?? ''}:${node.value ?? ''}`);
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    bound(bytes, count, maximum);
  }
  return { node_count: count, max_depth: maximum, upper_bytes: bytes };
}
function cssFingerprint(nodes, minify) {
  const events = [], pending = [...nodes].reverse().map(node => ({ node, end: false }));
  while (pending.length) {
    const { node, end } = pending.pop();
    if (end) { events.push(['end']); continue; }
    if (node.t === 'comment') { if (!minify) events.push(['comment', node.text]); continue; }
    if (node.t === 'decl') events.push(['decl', cssLexical(node.prop), node.prop.startsWith('--') ? node.value : cssLexical(node.value)]);
    else {
      events.push([node.t, cssLexical(node.prelude), node.children === null]); pending.push({ node, end: true });
      for (let at = (node.children?.length ?? 0) - 1; at >= 0; at--) pending.push({ node: node.children[at], end: false });
    }
  }
  return JSON.stringify(events);
}
function formatCss(text, settings) {
  lexicalAdmission(text, 'css'); const nodes = parseCss(text), plan = cssPlan(nodes, settings), output = printCss(nodes, settings);
  bound(Buffer.byteLength(output), 0, 0); if (Buffer.byteLength(output) > plan.upper_bytes) changed();
  lexicalAdmission(output, 'css'); const checked = parseCss(output); cssPlan(checked, { indent: '', minify: true });
  if (cssFingerprint(nodes, settings.minify) !== cssFingerprint(checked, settings.minify)) changed();
  return { output, summary: { node_count: plan.node_count, max_depth: plan.max_depth,
    verification: { parsed_structure: true, lexical_values: true, quoted_strings: true, custom_property_values: true, rendered_equivalence: false },
    warnings: ['The existing CSS block formatter changes layout and can remove standalone comments when minifying. It does not validate CSS properties or prove browser rendering equivalent.',
      'Quoted strings, escapes, custom-property values and supported structure are checked. Cases the source engine would change are refused. No stylesheet, URL or imported resource is executed or fetched.'] } };
}
function formatYaml(text, settings) {
  preflightStructuredYaml(text); const tree = parseYaml(text), plan = inspectStructuredTree(tree), upper = structuredYamlUpperBytes(tree, settings.indent.length);
  const output = printYaml(tree, { indent: settings.indent.length }); bound(Buffer.byteLength(output), plan.node_count, plan.max_depth);
  if (Buffer.byteLength(output) > upper) changed(); preflightStructuredYaml(output);
  const checked = parseYaml(output); inspectStructuredTree(checked); structuredJsonBytes(tree, ''); structuredJsonBytes(checked, '');
  if (printJson(plainStructuredTree(tree), { indent: '' }) !== printJson(plainStructuredTree(checked), { indent: '' })) changed();
  return { output, summary: { ...plan, verification: { ordered_values: true, duplicate_keys: true, numeric_text: true, comments_preserved: false },
    warnings: ['The supported YAML subset is reprinted from its ordered value tree. Comments, quoting, scalar layout and numeric spellings can change; ordered values and exact normalized number tokens are checked.',
      'Anchors, aliases, explicit tags and multiple documents are unsupported. A source-printer result that cannot round-trip exactly through the supported parser is refused.'] } };
}
function processText(bytes, settings) {
  const text = decode(bytes), made = settings.language === 'html' ? formatHtml(text, settings) : settings.language === 'css' ? formatCss(text, settings) : formatYaml(text, settings);
  const output = made.output.endsWith('\n') ? made.output : made.output + '\n';
  if (!output.isWellFormed()) fail('UNSUPPORTED_TEXT', 'The formatter produced characters that cannot be preserved in UTF-8.');
  const data = new TextEncoder().encode(output); bound(data.length, 0, 0); return { data, summary: made.summary };
}
function publicFailure(error) {
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  return { code: error instanceof ParseError ? 'INVALID_CODE' : 'CODE_FORMAT_FAILED',
    message: 'The existing parser or formatter could not preserve this supported input. Source text and parser excerpts are excluded from errors. No output was written.' };
}
async function isolated(bytes, settings, { signal } = {}) {
  const input = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-code-format', input, settings }, transferList: [input.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } }); worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Code formatting exceeded the two-minute worker limit.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('CODE_FORMAT_LIMIT', 'The isolated formatting worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('CODE_FORMAT_LIMIT', 'The isolated formatting worker stopped before returning a verified result.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
export async function formatCode(args, options = {}) {
  options.signal?.throwIfAborted(); const settings = settingsFor(args), output = await newOutput(args.output_path);
  const extensions = { html: ['.html', '.htm'], css: ['.css'], yaml: ['.yaml', '.yml'] };
  if (!extensions[settings.language].includes(path.extname(output).toLowerCase())) fail('OUTPUT_EXTENSION', 'Choose a new .html/.htm, .css or .yaml/.yml output matching the selected language.');
  const input = await readInput(args.input_path, { allow_empty: true, max_bytes: MAX_CODE_FORMAT_INPUT_BYTES }); options.signal?.throwIfAborted();
  const made = await isolated(input.data, settings, options), data = Buffer.from(made.data); options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'format-code', input_path: input.path, output_path: output, input_bytes: input.data.length, output_bytes: data.length,
    language: settings.language, minified: settings.minify, ...(settings.minify ? {} : { indent: settings.indent === '\t' ? 'tab' : String(settings.indent.length) }),
    verified: true, ...made.summary };
}
if (!isMainThread && workerData?.kind === 'abox-code-format') {
  try { const result = processText(workerData.input, workerData.settings); parentPort.postMessage({ result }, [result.data.buffer]); }
  catch (error) { parentPort.postMessage({ error: publicFailure(error) }); }
  finally { parentPort.close(); }
}
