import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import {
  ensureConfiguredProductPrintAssets,
  reconcileConfiguredProductPrintAssets,
} from "./print-assets";
import { isAuthenticatedOperationsRequest } from "./service-auth";

const PRINT_ASSET_REFRESH_PATH =
  "/v2/internal/operations/print-assets-refresh";

interface PrintAssetReconciliationEnv {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImagesBinding;
}

export async function handlePrintAssetReconciliationRequest(
  request: Request,
  env: PrintAssetReconciliationEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== PRINT_ASSET_REFRESH_PATH) {
    return undefined;
  }
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "POST",
    });
  }
  if (!(await isAuthenticatedOperationsRequest(request, env))) {
    return apiError(
      401,
      "UNAUTHORIZED",
      "Operations authentication is required.",
    );
  }
  const configuredProductId = url.searchParams.get("configuredProductId");
  if (configuredProductId !== null && !isUuid(configuredProductId)) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "configuredProductId must be a UUID.",
    );
  }
  try {
    const result = configuredProductId === null
      ? await reconcileConfiguredProductPrintAssets(env)
      : await ensureConfiguredProductPrintAssets(
        env,
        configuredProductId,
      ).then(() => ({ productsFailed: 0, productsReconciled: 1 }));
    if (result.productsFailed > 0) {
      return apiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Some configured product print assets could not be prepared.",
      );
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Configured product print assets could not be reconciled.",
    );
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}

export async function runScheduledPrintAssetReconciliation(
  env: PrintAssetReconciliationEnv,
) {
  try {
    const result = await reconcileConfiguredProductPrintAssets(env);
    if (result.productsFailed > 0) {
      console.error("bent.shop print asset reconciliation failed", result);
    } else if (result.productsReconciled > 0) {
      console.info("bent.shop print assets reconciled", result);
    }
  } catch (error) {
    console.error("bent.shop print asset reconciliation failed", {
      ...safeErrorDetails(error),
    });
  }
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    headers ? { headers, status } : { status },
  );
}
