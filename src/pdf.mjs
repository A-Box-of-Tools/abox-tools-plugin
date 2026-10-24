import path from 'node:path';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { PdfDocument, EncryptedPdfError } from '../vendor/abox/shared/js/pdf-reader.js';
import { readSource, assemble } from '../vendor/abox/tools/merge-pdf/src/assemble.js';
import { parseRanges, splitInto } from '../vendor/abox/tools/merge-pdf/src/plan.js';
import { writeDocument } from '../vendor/abox/shared/js/pdf-writer.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PAGES = 5000;
export const MAX_OUTPUTS = 1000;
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
