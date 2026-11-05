export interface CategoryIconDiagnostic {
  stage:
    | 'generation'
    | 'transport'
    | 'status'
    | 'body'
    | 'json'
    | 'shape'
    | 'base64'
    | 'png'
    | 'mask'
    | 'identity'
    | 'r2'
    | 'd1';
  reason:
    | 'outcome'
    | 'exception'
    | 'request_failed'
    | 'timeout'
    | 'response_received'
    | 'missing_body'
    | 'read_failed'
    | 'invalid_json'
    | 'invalid_shape'
    | 'invalid_base64'
    | 'invalid_png'
    | 'normalized'
    | 'invalid_mask'
    | 'processing_failed'
    | 'write_failed'
    | 'ready'
    | 'lease_lost';
  httpStatus?: number;
  providerRequestId?: string;
}

// Keep only the provider's conventional opaque request identifier. Unknown
// formats are omitted rather than truncating or logging arbitrary header text.
export function categoryIconRequestId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length === 36 &&
    /^req_[a-f0-9]{32}$/u.test(value)
    ? value
    : undefined;
}

/** One deliberately payload-free terminal event. Logging must never affect work. */
export function emitCategoryIconDiagnostic(
  started: number,
  detail: CategoryIconDiagnostic,
) {
  try {
    const elapsed = performance.now() - started;
    const requestId = categoryIconRequestId(detail.providerRequestId);
    console.info({
      event: 'category_icon_generation',
      operationId: crypto.randomUUID(),
      stage: detail.stage,
      reason: detail.reason,
      ...(Number.isInteger(detail.httpStatus) &&
      typeof detail.httpStatus === 'number' &&
      detail.httpStatus >= 100 &&
      detail.httpStatus <= 599
        ? { httpStatus: detail.httpStatus }
        : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
      elapsedMs: Number.isFinite(elapsed)
        ? Math.min(3_600_000, Math.max(0, Math.round(elapsed)))
        : 0,
    });
  } catch {
    // A diagnostic sink failure must not fail a generation or alter its state.
  }
}
