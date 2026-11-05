// Shared by all requests/DO instances hosted by this isolate. Leave 32 MiB of
// the 128 MiB isolate ceiling for runtime, application state and stream plumbing.
export const PRINT_BUFFER_BUDGET = 96 * 1024 * 1024;
// One 5 MiB multipart part plus bounded BYOB stream buffers and hash state.
// Non-byte streams must separately reserve their maximum ingress chunk.
export const PRINT_STREAM_BUFFER_BYTES = 6 * 1024 * 1024;

export class PrintMemoryCapacityError extends Error {
  constructor() { super("Print buffer capacity is currently occupied."); }
}

export function isPrintMemoryCapacityError(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof PrintMemoryCapacityError) return true;
    visited.add(error);
    error = error.cause;
  }
  return false;
}

export function createPrintBufferAdmission(limit = PRINT_BUFFER_BUDGET) {
  let occupied = 0;
  return {
    reserve(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) {
        throw new Error("Print buffer reservation exceeds the supported limit.");
      }
      if (occupied + bytes > limit) throw new PrintMemoryCapacityError();
      occupied += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        occupied -= bytes;
      };
    },
    get occupied() { return occupied; },
  };
}

export const printBufferAdmission = createPrintBufferAdmission();
