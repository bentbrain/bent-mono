import { Cause, Data, Option, Runtime } from "effect";

interface D1ErrorDetails {
  readonly databaseErrorCategory: "busy" | "constraint" | "capacity" | "d1_error" | "unknown";
  readonly databaseErrorCode: "SQLITE_BUSY" | "SQLITE_LOCKED" | "SQLITE_CONSTRAINT" |
    "SQLITE_FULL" | "SQLITE_TOOBIG" | "D1_ERROR" | "D1_EXEC_ERROR" | "unknown";
}

export class PrintifyOrderDatabaseError extends Data.TaggedError(
  "PrintifyOrderDatabaseError",
)<{
  readonly operation: string;
  readonly diagnostic?: D1ErrorDetails;
}> {}

function databaseOperation(operation: string) {
  switch (operation) {
    case "fence expired Printify order mutations": return "fence_expired_leases";
    case "read Printify order candidates": return "read_order_candidates";
    case "read Printify order candidate lines": return "read_order_candidate_lines";
    case "ensure Printify order rows": return "ensure_order_rows";
    case "claim Printify order": return "claim_order";
    case "store Printify order ID": return "store_order_id";
    case "finalize verified Printify order": return "finalize_verified_order";
    case "finalize submitted Printify order": return "finalize_submitted_order";
    case "reset Printify order": return "reset_order";
    case "fail Printify order": return "fail_order";
    default: return undefined;
  }
}

// Read data properties only. Never execute a cause's getters or serialize it.
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function safeD1ErrorDetails(cause: unknown): D1ErrorDetails {
  // D1 may wrap its underlying rejection. Bound traversal, including cycles.
  for (let depth = 0; depth < 4; depth++) {
    const code = ownValue(cause, "code");
    switch (code) {
      case "SQLITE_BUSY":
      case "SQLITE_LOCKED": return { databaseErrorCategory: "busy", databaseErrorCode: code };
      case "SQLITE_CONSTRAINT": return { databaseErrorCategory: "constraint", databaseErrorCode: code };
      case "SQLITE_FULL":
      case "SQLITE_TOOBIG": return { databaseErrorCategory: "capacity", databaseErrorCode: code };
      case "D1_ERROR":
      case "D1_EXEC_ERROR": return { databaseErrorCategory: "d1_error", databaseErrorCode: code };
    }
    cause = ownValue(cause, "cause");
  }
  return { databaseErrorCategory: "unknown", databaseErrorCode: "unknown" };
}

export function safePrintifyOrderDatabaseDetails(error: unknown) {
  const failure = Runtime.isFiberFailure(error)
    ? Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId]))
    : error;
  if (!(failure instanceof PrintifyOrderDatabaseError) || !failure.diagnostic) return {};
  const operation = databaseOperation(failure.operation);
  if (!operation) return {};
  return { databaseOperation: operation, ...failure.diagnostic };
}
