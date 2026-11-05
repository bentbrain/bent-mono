const PERMANENT_ERROR_TAGS = new Set([
  "DesignNotFound",
  "InvalidRequest",
  "ProductNotFound",
]);

export function retryServerMutation(
  failureCount: number,
  error: unknown,
) {
  if (isExplicitlyNonRetryable(error)) return false;
  const tag = getErrorTag(error);
  return (
    failureCount < 3 &&
    (tag === undefined || !PERMANENT_ERROR_TAGS.has(tag))
  );
}

function isExplicitlyNonRetryable(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === false;
}

export function serverMutationRetryDelay(attemptIndex: number) {
  return Math.min(1_000 * 2 ** attemptIndex, 5_000);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getErrorTag(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    typeof error._tag !== "string"
  ) {
    return undefined;
  }
  return error._tag;
}
