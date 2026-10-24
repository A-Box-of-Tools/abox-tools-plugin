import { readBytes, serialize, outputType } from '../vendor/abox/tools/exif-editor/src/container.js';
import { prepareCleanCopy } from '../vendor/abox/tools/exif-editor/src/clean-copy.js';
import { readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { AdapterError } from './errors.mjs';

export function metadataSummary(item) {
  return {
    exif_tags: item.exif?.ok ? Object.values(item.exif.groups).reduce((sum, entries) => sum + entries.length, 0) : 0,
    exif_present: Boolean(item.meta.exif),
    icc_present: Boolean(item.meta.icc),
    xmp_present: Boolean(item.meta.xmp),
    iptc_present: Boolean(item.meta.iptc),
    comments: item.meta.comments.length,
    text_chunks: item.meta.text.length,
    extra_blocks: item.meta.extras.length,
    display_markers: item.meta.notes.map(note => note.label),
  };
}

export async function supportedImage(data) {
  const item = await readBytes(new Uint8Array(data));
  if (!item.ok || !['jpeg', 'png', 'webp'].includes(item.kind)) {
    throw new AdapterError('UNSUPPORTED_IMAGE', 'Version 0.1 supports JPEG, PNG, and WebP containers.');
  }
  return item;
}

export async function removeExif(args, { signal } = {}) {
  const input = await readInput(args.input_path);
  const output = await newOutput(args.output_path);
  const item = await supportedImage(input.data);
  requireExtension(output, outputType(item.kind).mime);
  const prepared = prepareCleanCopy({ ...item, name: input.path }, {
    keepOrientation: args.keep_orientation,
    keepIcc: args.keep_icc,
  });
  const data = serialize(item, prepared.plan);
  const checked = await readBytes(data);
  if (!checked.ok || checked.kind !== item.kind) {
    throw new AdapterError('VERIFICATION_FAILED', 'The cleaned image container could not be read.');
  }
  const after = metadataSummary(checked);
  const retainedTags = checked.exif?.ok ? Object.values(checked.exif.groups).flat() : [];
  const orientationOnly = !after.exif_present || (args.keep_orientation && checked.exif?.ok
    && retainedTags.length === 1 && checked.exif.groups.ifd0.length === 1 && retainedTags[0].tag === 0x0112);
  if (!orientationOnly || after.xmp_present
      || after.iptc_present || after.comments || after.text_chunks || after.extra_blocks
      || (!args.keep_icc && after.icc_present)) {
    throw new AdapterError('VERIFICATION_FAILED', 'The cleaned image did not pass its metadata inventory check.');
  }
  signal?.throwIfAborted();
  await writeNew(output, data);
  return {
    ok: true, operation: 'remove-exif', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: item.kind,
    verified: true, before: metadataSummary(item), after,
    policy: { keep_orientation: args.keep_orientation, keep_icc: args.keep_icc },
    warnings: [
      ...(after.exif_present ? ['An orientation-only EXIF block remains as requested.'] : []),
      ...(after.icc_present ? ['The ICC color profile remains as requested.'] : []),
      ...(!args.keep_orientation ? ['Removing orientation can change how some viewers rotate the image.'] : []),
      ...(!args.keep_icc ? ['Removing an ICC profile can change displayed colors.'] : []),
    ],
  };
}
