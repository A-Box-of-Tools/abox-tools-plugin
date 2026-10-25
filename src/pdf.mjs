import path from 'node:path';
import { mkdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { readSource, assemble } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { parseRanges, splitInto } from '../vendor/abox/tools/merge-pdf/src/plan.js';
import { writeDocument } from '../vendor/abox/shared/js/pdf-writer.js';
import { normalizeRotation } from '../vendor/abox/shared/js/pdf-pages.js';
import { localPath, MAX_INPUT_BYTES, readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PAGES = 5000;
export const MAX_OUTPUTS = 1000;
export const MAX_MERGE_INPUTS = 32;
export const MAX_PAGE_SELECTION_LENGTH = 10000;
const phrase = (key, values = {}) => `${key}${Object.keys(values).length ? `: ${JSON.stringify(values)}` : ''}`;

export async function splitPdf(args, { signal } = {}) {
  const input = await readInput(args.input_path);
  const outputDir = await newOutput(args.output_dir);
  let doc;
  try {
    doc = await PdfDocument.open(new Uint8Array(input.data));
  } catch (error) {
    if (error instanceof EncryptedPdfError) {
      throw new AdapterError('ENCRYPTED_PDF', 'Encrypted PDFs are unsupported, including those with an empty password.');
    }
    throw new AdapterError('INVALID_PDF', `The PDF could not be read: ${error.message}`);
  }
  const source = readSource(doc, path.basename(input.path));
  if (!source.pages.length || source.pages.length > MAX_PAGES) {
    throw new AdapterError('PDF_PAGE_LIMIT', `PDFs must have 1 to ${MAX_PAGES} pages.`);
  }
  const entries = source.pages.map((_, index) => ({ source, index, rotate: 0 }));
  let groups;
  if (args.mode === 'ranges') {
    groups = args.ranges.map((text) => {
      const parsed = parseRanges(text, entries.length, phrase);
      if (parsed.error || !parsed.pages.length) {
        throw new AdapterError('INVALID_PAGE_RANGE', `Invalid page range ${JSON.stringify(text)} for ${entries.length} pages.`);
      }
      return { entries: parsed.pages.map(page => entries[page - 1]), pages: parsed.pages };
    });
  } else {
    groups = splitInto(entries, { mode: args.mode === 'every' ? 'every' : 'each', size: args.pages_per_file })
      .map(group => ({ ...group, pages: group.entries.map(entry => entry.index + 1) }));
  }
  if (groups.length > MAX_OUTPUTS) throw new AdapterError('OUTPUT_LIMIT', `At most ${MAX_OUTPUTS} output PDFs may be created per call.`);

  // Reserve an empty new directory so a failure cannot overwrite a previous run.
  await mkdir(outputDir);
  const outputs = [];
  let manifestPath = null;
  let manifestWritten = false;
  try {
    for (const [index, group] of groups.entries()) {
      signal?.throwIfAborted();
      const built = assemble(group.entries, { bookmarks: args.keep_bookmarks, t: phrase });
      const blob = await writeDocument(built.build, { signal });
      const data = new Uint8Array(await blob.arrayBuffer());
      const check = await PdfDocument.open(data);
      if (check.countPages() !== group.pages.length) {
        throw new AdapterError('VERIFICATION_FAILED', 'An output PDF had an unexpected page count.');
      }
      const name = `part-${String(index + 1).padStart(3, '0')}.pdf`;
      const output = path.join(outputDir, name);
      signal?.throwIfAborted();
      await writeNew(output, data);
      outputs.push({ output_path: output, pages: group.pages, page_count: group.pages.length, output_bytes: data.length, verified: true });
    }
    signal?.throwIfAborted();
    if (outputs.length > 20) {
      manifestPath = path.join(outputDir, 'manifest.json');
      await writeNew(manifestPath, `${JSON.stringify({ input_path: input.path, outputs }, null, 2)}\n`);
      manifestWritten = true;
    }
  } catch (error) {
    // Only files recorded by this call belong to us; never recursively remove a directory supplied by a caller.
    for (const output of outputs) await rm(output.output_path, { force: true }).catch(() => {});
    if (manifestWritten) await rm(manifestPath, { force: true }).catch(() => {});
    await rmdir(outputDir).catch(() => {});
    throw error;
  }
  return {
    ok: true, operation: 'split-pdf', input_path: input.path, input_pages: entries.length,
    output_dir: outputDir, outputs: outputs.slice(0, 20), output_count: outputs.length,
    outputs_truncated: outputs.length > 20, manifest_path: manifestPath,
    verified: true, repaired_input: Boolean(doc.repaired),
    warnings: [
      'The source engine omits document metadata, tagged reading order, page labels, attachments, and unsupported actions.',
      'Splitting changes the document and invalidates digital signatures.',
    ],
  };
}

async function pdfOutput(value) {
  const output = await newOutput(value);
  if (path.extname(output).toLowerCase() !== '.pdf') {
    throw new AdapterError('OUTPUT_EXTENSION', 'Use an output filename ending in .pdf.');
  }
  return output;
}

function bookmarkSetting(args) {
  if (args.keep_bookmarks !== undefined && typeof args.keep_bookmarks !== 'boolean') {
    throw new AdapterError('INVALID_ARGUMENTS', 'keep_bookmarks must be a boolean.');
  }
  return args.keep_bookmarks ?? true;
}

async function pdfSource(input, label) {
  let doc;
  let source;
  try {
    doc = await PdfDocument.open(new Uint8Array(input.data));
    source = readSource(doc, label);
  } catch (error) {
    if (error instanceof EncryptedPdfError) {
      throw new AdapterError('ENCRYPTED_PDF', 'Encrypted PDFs are unsupported, including those with an empty password.');
    }
    throw new AdapterError('INVALID_PDF', `The PDF could not be read: ${error.message}`);
  }
  if (!source.pages.length || source.pages.length > MAX_PAGES) {
    throw new AdapterError('PDF_PAGE_LIMIT', `PDFs must have 1 to ${MAX_PAGES} pages.`);
  }
  return { source, repaired: Boolean(doc.repaired) };
}

async function mergeInputPaths(values, signal) {
  if (!Array.isArray(values) || values.length < 2 || values.length > MAX_MERGE_INPUTS) {
    throw new AdapterError('PDF_INPUT_LIMIT', `Merging requires 2 to ${MAX_MERGE_INPUTS} input PDFs.`);
  }
  const paths = [];
  let total = 0;
  // Reject a large batch before retaining any PDF bytes; readInput checks each file again when it opens it.
  for (const value of values) {
    signal?.throwIfAborted();
    const input = localPath(await realpath(localPath(value)));
    const info = await stat(input);
    if (!info.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
    if (!info.size || info.size > MAX_INPUT_BYTES) {
      throw new AdapterError('INPUT_SIZE', `Input files must contain 1 to ${MAX_INPUT_BYTES} bytes.`);
    }
    total += info.size;
    if (total > MAX_INPUT_BYTES) {
      throw new AdapterError('PDF_TOTAL_SIZE', `The combined PDF inputs must not exceed ${MAX_INPUT_BYTES} bytes.`);
    }
    paths.push(input);
  }
  return paths;
}

async function writePdf(entries, output, bookmarks, signal, verify = null) {
  signal?.throwIfAborted();
  let built;
  try { built = assemble(entries, { bookmarks, t: phrase }); }
  catch (error) {
    // The upstream collision warning references a translator outside its scope; keep that known failure actionable.
    if (error instanceof ReferenceError && error.message === 't is not defined') {
      throw new AdapterError('UNSUPPORTED_PDF_FORMS', 'PDFs with colliding form field names cannot be combined by the current source engine. Use PDFs with distinct field names or noninteractive copies.');
    }
    throw error;
  }
  const blob = await writeDocument(built.build, { signal });
  const data = new Uint8Array(await blob.arrayBuffer());
  signal?.throwIfAborted();
  let checked;
  try { checked = await PdfDocument.open(data); }
  catch { throw new AdapterError('VERIFICATION_FAILED', 'The output PDF could not be reopened.'); }
  if (checked.countPages() !== entries.length) {
    throw new AdapterError('VERIFICATION_FAILED', 'The output PDF had an unexpected page count.');
  }
  if (verify) await verify(checked);
  signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    output_bytes: data.length, page_count: entries.length,
    form_widgets: built.fields, links: built.links, engine_note_count: built.notes.length,
  };
}

function editWarnings(action, engineNotes) {
  return [
    'The source engine omits document metadata, tagged reading order, page labels, attachments, and unsupported actions.',
    `${action} changes the document and invalidates digital signatures.`,
    ...(engineNotes ? ['The source engine reported additional link, action, or form limitations.'] : []),
  ];
}

export async function mergePdf(args, { signal } = {}) {
  signal?.throwIfAborted();
  const bookmarks = bookmarkSetting(args);
  const output = await pdfOutput(args.output_path);
  const paths = await mergeInputPaths(args.input_paths, signal);
  const entries = [];
  const inputs = [];
  let inputBytes = 0;
  for (const [index, value] of paths.entries()) {
    signal?.throwIfAborted();
    const input = await readInput(value);
    inputBytes += input.data.length;
    if (inputBytes > MAX_INPUT_BYTES) {
      throw new AdapterError('PDF_TOTAL_SIZE', `The combined PDF inputs must not exceed ${MAX_INPUT_BYTES} bytes.`);
    }
    // The assembler also keys form roots by this label, so equal basenames must remain distinct.
    const { source, repaired } = await pdfSource(input, `${index + 1}. ${path.basename(input.path)}`);
    if (entries.length + source.pages.length > MAX_PAGES) {
      throw new AdapterError('PDF_PAGE_LIMIT', `The combined PDF inputs must have at most ${MAX_PAGES} pages.`);
    }
    for (let page = 0; page < source.pages.length; page++) entries.push({ source, index: page, rotate: 0 });
    inputs.push({ input_path: input.path, input_bytes: input.data.length, page_count: source.pages.length, repaired_input: repaired });
  }
  const made = await writePdf(entries, output, bookmarks, signal);
  return {
    ok: true, operation: 'merge-pdf', input_count: inputs.length, inputs,
    input_bytes: inputBytes, input_pages: entries.length, output_path: output,
    ...made, keep_bookmarks: bookmarks, verified: true,
    warnings: editWarnings('Merging', made.engine_note_count),
  };
}

function pageOrder(text, total) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PAGE_SELECTION_LENGTH) {
    throw new AdapterError('INVALID_PAGE_RANGE', `Provide a page selection containing 1 to ${MAX_PAGE_SELECTION_LENGTH} characters.`);
  }
  const pages = [];
  // Terms form an ordered sequence, while each term retains the website's ascending range and keyword grammar.
  // Parsing the entire string at once would turn it into a sorted set and silently lose repeated pages.
  for (const term of text.split(/[,;]+/).map(part => part.trim()).filter(Boolean)) {
    const parsed = parseRanges(term, total, phrase);
    if (parsed.error || !parsed.pages.length) {
      throw new AdapterError('INVALID_PAGE_RANGE', `Invalid page selection ${JSON.stringify(term)} for ${total} pages.`);
    }
    if (pages.length + parsed.pages.length > MAX_PAGES) {
      throw new AdapterError('PDF_PAGE_LIMIT', `The selected output must have at most ${MAX_PAGES} pages.`);
    }
    pages.push(...parsed.pages);
  }
  if (!pages.length) throw new AdapterError('INVALID_PAGE_RANGE', 'Select at least one page.');
  return pages;
}

export async function selectPdfPages(args, { signal } = {}) {
  signal?.throwIfAborted();
  const bookmarks = bookmarkSetting(args);
  const output = await pdfOutput(args.output_path);
  const input = await readInput(args.input_path);
  const { source, repaired } = await pdfSource(input, path.basename(input.path));
  const pages = pageOrder(args.pages, source.pages.length);
  const entries = pages.map(page => ({ source, index: page - 1, rotate: 0 }));
  const made = await writePdf(entries, output, bookmarks, signal);
  return {
    ok: true, operation: 'select-pdf-pages', input_path: input.path,
    input_bytes: input.data.length, input_pages: source.pages.length, output_path: output,
    ...made, page_order: pages.slice(0, 100), page_order_truncated: pages.length > 100,
    keep_bookmarks: bookmarks, repaired_input: repaired, verified: true,
    warnings: editWarnings('Selecting or rearranging pages', made.engine_note_count),
  };
}

export async function rotatePdf(args, { signal } = {}) {
  signal?.throwIfAborted();
  if (![90, 180, 270].includes(args.degrees)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'degrees must be 90, 180, or 270 clockwise.');
  }
  const selection = args.pages === undefined ? 'all' : args.pages;
  if (typeof selection !== 'string' || !selection.trim() || selection.length > MAX_PAGE_SELECTION_LENGTH) {
    throw new AdapterError('INVALID_PAGE_RANGE', `Provide a page selection containing 1 to ${MAX_PAGE_SELECTION_LENGTH} characters.`);
  }
  const bookmarks = bookmarkSetting(args);
  const output = await pdfOutput(args.output_path);
  const input = await readInput(args.input_path);
  const { source, repaired } = await pdfSource(input, path.basename(input.path));
  const selected = parseRanges(selection, source.pages.length, phrase);
  if (selected.error || !selected.pages.length) {
    throw new AdapterError('INVALID_PAGE_RANGE', `Invalid page selection for ${source.pages.length} pages.`);
  }
  const wanted = new Set(selected.pages);
  const entries = source.pages.map((_, index) => ({ source, index, rotate: wanted.has(index + 1) ? args.degrees : 0 }));
  const made = await writePdf(entries, output, bookmarks, signal, checked => {
    const pages = readSource(checked, path.basename(output)).pages;
    if (pages.length !== entries.length || pages.some((page, index) =>
      page.rotate !== normalizeRotation(source.pages[index].rotate + entries[index].rotate))) {
      throw new AdapterError('VERIFICATION_FAILED', 'The output PDF did not retain the expected page rotations.');
    }
  });
  return {
    ok: true, operation: 'rotate-pdf', input_path: input.path,
    input_bytes: input.data.length, input_pages: source.pages.length, output_path: output,
    ...made, degrees: args.degrees, rotated_page_count: selected.pages.length,
    rotated_pages: selected.pages.slice(0, 100), rotated_pages_truncated: selected.pages.length > 100,
    keep_bookmarks: bookmarks, repaired_input: repaired, rotation_verified: true, verified: true,
    warnings: editWarnings('Rotating pages', made.engine_note_count),
  };
}
