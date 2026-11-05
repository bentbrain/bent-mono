export interface PrintExecutionDispatchEnv {
  readonly DB: D1Database;
  readonly PRINT_EXECUTION_MODE?: string;
  readonly PRINT_EXECUTIONS?: {
    getByName(name: string, options?: { locationHint: "oc" }): { fetch(request: Request): Promise<Response> };
  };
}

export function usesDurablePrintExecution(env: PrintExecutionDispatchEnv) {
  return env.PRINT_EXECUTION_MODE === "durable-object";
}

// The outbox already exists before either delivery path is attempted. A 202
// acknowledges durable scheduling only; verified D1 assets still gate purchase.
export async function dispatchPrintExecution(env: PrintExecutionDispatchEnv, productId: string) {
  if (!usesDurablePrintExecution(env)) return false;
  if (!env.PRINT_EXECUTIONS) throw new Error("Print execution binding is unavailable.");
  const product = await env.DB.prepare(`SELECT design_revision_id FROM products
    WHERE id = ? AND design_revision_id IS NOT NULL`).bind(productId)
    .first<{ design_revision_id: string }>();
  if (!product) throw new Error("Print execution revision is unavailable.");
  // D1 lives in Sydney. The first caller may be an overseas browser or CI;
  // prefer Oceania instead of permanently placing this object near that caller.
  const response = await env.PRINT_EXECUTIONS.getByName(product.design_revision_id, { locationHint: "oc" }).fetch(new Request(
    `https://print-execution.internal/wake?product=${productId}&revision=${product.design_revision_id}`,
    { method: "POST", signal: AbortSignal.timeout(3_000) },
  ));
  await response.body?.cancel();
  if (response.status !== 202) throw new Error("Print execution scheduling failed.");
  return true;
}
