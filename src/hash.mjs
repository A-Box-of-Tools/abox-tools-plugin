import { open, realpath, stat } from 'node:fs/promises';
import { hashFile, Unreadable } from '../vendor/abox/tools/hash-checksum/src/hash.js';
import { localPath } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_HASH_BYTES = 8 * 1024 ** 3;

export async function hashLocalFile(args, { signal } = {}) {
  signal?.throwIfAborted();
  const input = localPath(await realpath(localPath(args.input_path)));
  if (!(await stat(input)).isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
  const file = await open(input, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new AdapterError('INPUT_NOT_FILE', 'The input must be a regular file.');
    if (before.size > MAX_HASH_BYTES) throw new AdapterError('INPUT_SIZE', `Checksum inputs may contain at most ${MAX_HASH_BYTES} bytes.`);
    // A Blob-shaped reader lets the unchanged website engine stream bounded chunks.
    const source = {
      size: before.size,
      slice(start, end) {
        return { async arrayBuffer() {
          const bytes = Buffer.alloc(end - start);
          let at = 0;
          while (at < bytes.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(bytes, at, bytes.length - at, start + at);
            if (!bytesRead) throw new AdapterError('INPUT_CHANGED', 'The file became shorter while its checksums were calculated.');
            at += bytesRead;
          }
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } };
      },
    };
    const hashes = await hashFile(source, args.algorithms, { signal });
    signal?.throwIfAborted();
    const after = await file.stat();
    const current = await stat(input);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || current.dev !== after.dev || current.ino !== after.ino) {
      throw new AdapterError('INPUT_CHANGED', 'The file changed while its checksums were calculated. Try again with a stable file.');
    }
    return { ok: true, operation: 'hash-file', input_path: input, input_bytes: before.size, hashes };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Unreadable && error.cause instanceof AdapterError) throw error.cause;
    throw error;
  } finally {
    await file.close();
  }
}
