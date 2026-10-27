import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { renderMarkdown as sourceRenderMarkdown } from '../vendor/abox/tools/share-text/src/markdown.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_MARKDOWN_INPUT_BYTES = 1024 * 1024;
export const MAX_MARKDOWN_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_MARKDOWN_LINES = 20000;
export const MAX_MARKDOWN_LINE_LENGTH = 32768;
export const MAX_MARKDOWN_NODES = 100000;
const TIMEOUT_MS = 120000;
const BEFORE = '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Markdown document</title></head><body>';
const AFTER = '</body></html>\n';
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'hr']);
const INLINE = new Set(['strong', 'em', 'code', 'a', 'br']);
const refuse = () => { throw new AdapterError('VERIFICATION_FAILED', 'The small Markdown engine produced markup outside its verified passive dialect. No output was written.'); };
const limit = () => { throw new AdapterError('MARKDOWN_LIMIT', 'Markdown supports at most 1 MiB, 20000 lines, 32768 characters per line, 100000 projected nodes and 16 MiB output.'); };

function prepare(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AdapterError('INVALID_UTF8', 'Markdown input must contain valid UTF-8. No output was written.'); }
  // The unchanged renderer splits only LF and uses dot-matching block tests.
  // Other line separators can prevent those tests from advancing their cursor.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/u.test(text)) {
    throw new AdapterError('MARKDOWN_TEXT', 'Unsupported control characters or Unicode line separators were found. Use ordinary UTF-8 text with LF or CRLF lines. No output was written.');
  }
  const normalized = text.includes('\r');
  text = text.replace(/\r\n?/g, '\n');
  let lines = text ? 1 : 0, length = 0, markers = 0, links = 0, stars = 0, ticks = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '\n') { lines++; length = 0; }
    else if (++length > MAX_MARKDOWN_LINE_LENGTH) limit();
    if (char === '*' || char === '`' || char === '[' || char === ']') markers++;
    if (char === '[') links++;
    if (char === '*') stars++;
    if (char === '`') ticks++;
  }
  const predictedNodes = 8 + lines * 4 + markers * 3;
  // Entity expansion and every possible source-emitted tag are overcounted
  // before the renderer builds its strings; rejection is deliberately conservative.
  const predictedBytes = Buffer.byteLength(BEFORE + AFTER) + bytes.length * 6
    + lines * 64 + links * 64 + stars * 24 + ticks * 16;
  if (lines > MAX_MARKDOWN_LINES || predictedNodes > MAX_MARKDOWN_NODES || predictedBytes > MAX_MARKDOWN_OUTPUT_BYTES) limit();
  return { text, lines, normalized, bom_removed: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf };
}

function entityText(text) {
  if (/&(?!(?:amp|lt|gt|quot);)/u.test(text)) refuse();
  return text.replace(/&(amp|lt|gt|quot);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name]);
}

// This verifies the finite emitted grammar, not general browser HTML. In
// particular, source emphasis replacement must not create tags in href values.
function passiveTree(html) {
  const root = { tag: 'root', children: [] }, stack = [root];
  let at = 0, nodes = 0; const links = [];
  const add = node => { if (++nodes > MAX_MARKDOWN_NODES) limit(); stack.at(-1).children.push(node); };
  while (at < html.length) {
    if (html[at] !== '<') {
      const end = html.indexOf('<', at), to = end === -1 ? html.length : end;
      const value = entityText(html.slice(at, to));
      if (stack.at(-1) === root || ['ul', 'ol'].includes(stack.at(-1).tag)) refuse();
      add({ text: value }); at = to; continue;
    }
    const end = html.indexOf('>', at); if (end === -1) refuse();
    const token = html.slice(at, end + 1), closing = /^<\/(p|h[1-6]|pre|code|blockquote|ul|ol|li|strong|em|a)>$/.exec(token);
    if (closing) {
      if (stack.length === 1 || stack.at(-1).tag !== closing[1]) refuse();
      stack.pop(); at = end + 1; continue;
    }
    let tag, href;
    const anchor = /^<a href="([^"<>]*)" target="_blank" rel="noopener noreferrer">$/.exec(token);
    if (anchor) {
      tag = 'a'; href = entityText(anchor[1]);
      if (!/^(?:https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/u.test(href)) refuse();
      links.push(href);
    } else {
      const opening = /^<(p|h[1-6]|pre|code|blockquote|ul|ol|li|strong|em|br|hr)>$/.exec(token);
      if (!opening) refuse(); tag = opening[1];
    }
    const parent = stack.at(-1).tag;
    if (parent === 'root' ? !BLOCKS.has(tag)
      : parent === 'ul' || parent === 'ol' ? tag !== 'li'
        : parent === 'pre' ? tag !== 'code'
          : !INLINE.has(tag) || parent === 'code' || tag === 'a' && stack.some(node => node.tag === 'a')) refuse();
    const node = { tag, children: [], ...(href !== undefined ? { href } : {}) }; add(node);
    if (tag !== 'br' && tag !== 'hr') { stack.push(node); if (stack.length > 32) refuse(); }
    at = end + 1;
  }
  if (stack.length !== 1) refuse();
  return { root, nodes, links };
}

// A separate text projection discards only the documented inline delimiters
// and safe-link destinations. It never constructs HTML or invokes the source.
function inlineProjection(text, links) {
  return text.split(/(`[^`]+`)/).map(part => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return part.slice(1, -1);
    return part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return whole;
      links.push(href); return label;
    })
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  }).join('');
}

function expectedBlocks(text) {
  const lines = text.split('\n'), blocks = [], links = [], inline = value => inlineProjection(value, links);
  for (let at = 0; at < lines.length;) {
    const start = at, line = lines[at];
    if (line.startsWith('```')) {
      const body = []; at++;
      while (at < lines.length && !lines[at].startsWith('```')) body.push(lines[at++]);
      at++; blocks.push({ tag: 'pre', text: body.join('\n') });
    } else if (/^(#{1,6})\s+(.*)$/.test(line)) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line); at++;
      blocks.push({ tag: `h${heading[1].length}`, text: inline(heading[2]) });
    } else if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) { at++; blocks.push({ tag: 'hr', text: '' }); }
    else if (line.startsWith('>')) {
      const body = []; while (at < lines.length && lines[at].startsWith('>')) body.push(inline(lines[at++].replace(/^>\s?/, '')));
      blocks.push({ tag: 'blockquote', text: body.join('\n') });
    } else if (/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const ordered = /^\d+[.)]\s+/.test(line), marker = ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/, items = [];
      while (at < lines.length && marker.test(lines[at])) items.push(inline(lines[at++].replace(marker, '')));
      blocks.push({ tag: ordered ? 'ol' : 'ul', items });
    } else if (!line.trim()) at++;
    else {
      const body = [];
      while (at < lines.length && lines[at].trim() && !/^(?:#{1,6}\s|```|>|[-*]\s|\d+[.)]\s|-{3,}\s*$|\*{3,}\s*$)/.test(lines[at])) body.push(inline(lines[at++]));
      blocks.push({ tag: 'p', text: body.join('\n') });
    }
    if (at <= start) refuse();
  }
  return { blocks, links };
}

function textOf(node) {
  if (node.text !== undefined) return node.text;
  if (node.tag === 'br') return '\n';
  return node.children.map(textOf).join('');
}

function verify(html, source) {
  const checked = passiveTree(html), expected = expectedBlocks(source), blocks = checked.root.children;
  if (blocks.length !== expected.blocks.length || checked.links.length !== expected.links.length
      || checked.links.some((href, index) => href !== expected.links[index])) refuse();
  for (const [index, block] of blocks.entries()) {
    const wanted = expected.blocks[index]; if (block.tag !== wanted.tag) refuse();
    if (wanted.items) {
      if (block.children.length !== wanted.items.length || block.children.some((item, at) => item.tag !== 'li' || textOf(item) !== wanted.items[at])) refuse();
    } else if (textOf(block) !== wanted.text || block.tag === 'pre' && (block.children.length !== 1 || block.children[0].tag !== 'code')) refuse();
  }
  return { block_count: blocks.length, link_count: checked.links.length, html_nodes: checked.nodes };
}

function convert(bytes) {
  const input = prepare(bytes), fragment = sourceRenderMarkdown(input.text);
  if (Buffer.byteLength(fragment) + Buffer.byteLength(BEFORE + AFTER) > MAX_MARKDOWN_OUTPUT_BYTES) limit();
  const summary = verify(fragment, input.text), data = new TextEncoder().encode(BEFORE + fragment + AFTER);
  if (data.length > MAX_MARKDOWN_OUTPUT_BYTES) limit();
  return { data, summary: { ...summary, line_count: input.lines, line_endings_normalized: input.normalized,
    input_bom_removed: input.bom_removed, verification: { passive_html_tree: true, source_text_projection: true, link_destinations: true, browser_rendering: false } } };
}

async function runWorker(bytes, options) {
  const data = Uint8Array.from(bytes), worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'abox-markdown-html', bytes: data }, transferList: [data.buffer], execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Markdown rendering exceeded the two-minute worker limit.')), TIMEOUT_MS);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.on('error', () => finish(new AdapterError('MARKDOWN_PROCESSING_FAILED', 'The isolated Markdown worker could not finish within its resource limit.')));
    worker.on('exit', () => finish(new AdapterError('MARKDOWN_PROCESSING_FAILED', 'The isolated Markdown worker stopped before producing output.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

export async function renderMarkdown(args, options = {}) {
  options.signal?.throwIfAborted();
  const output = await newOutput(args.output_path);
  if (!['.html', '.htm'].includes(path.extname(output).toLowerCase())) throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .html or .htm.');
  const input = await readInput(args.input_path, { allow_empty: true, max_bytes: MAX_MARKDOWN_INPUT_BYTES });
  options.signal?.throwIfAborted(); const made = await runWorker(input.data, options), data = Buffer.from(made.data);
  if (!data.length || data.length > MAX_MARKDOWN_OUTPUT_BYTES) limit();
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'markdown-to-html', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: 'html', encoding: 'utf-8', verified: true, ...made.summary,
    warnings: ['This is the website’s small Markdown dialect: flat lists, simple links/emphasis/code and no tables, raw HTML or image rendering. Unsupported syntax can remain literal.',
      'The standalone output has a fixed restrictive CSP and no styling, scripts, images or automatic requests. HTTP(S)/mailto links remain clickable; they are never opened by the adapter.',
      ...(made.summary.line_endings_normalized || made.summary.input_bom_removed ? ['Input line endings were normalized to LF and an initial UTF-8 BOM, when present, was omitted.'] : [])] };
}

if (!isMainThread && workerData?.kind === 'abox-markdown-html') {
  try {
    const result = convert(workerData.bytes); parentPort.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'MARKDOWN_PROCESSING_FAILED', message: 'The existing Markdown engine could not render and verify this input. No output was written.' } });
  } finally { parentPort.close(); }
}
