export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export function errorResult(error) {
  const code = error?.name === 'AbortError' ? 'CANCELLED'
    : error?.code === 'EEXIST' ? 'OUTPUT_EXISTS'
    : error?.name === 'ZodError' ? 'INVALID_ARGUMENTS'
      : typeof error?.code === 'string' ? error.code : 'OPERATION_FAILED';
  const message = code === 'OUTPUT_EXISTS'
    ? 'An output already exists. Choose a new path; existing files are never overwritten.'
    : error?.message ?? String(error);
  return { ok: false, error: { code, message } };
}
