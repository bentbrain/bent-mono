import { runOperationsCommand } from "../src/operations-client.ts";

const { ACTION: action, REASON: reason, CONFIGURED_PRODUCT_ID: configuredProductId } = process.env;
if (!process.env.BENT_SHIRT_OPERATIONS_SECRET || !process.env.FOREVER_TEE_API_SHARED_SECRET ||
    new URL(process.env.WORKER_URL).protocol !== "https:" ||
    ["pause-sales", "resume-sales"].includes(action) && !reason ||
    configuredProductId && (action !== "refresh-print-assets" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredProductId))) {
  throw new Error("Operations authentication, HTTPS Worker and valid operation inputs are required.");
}
const result = await runOperationsCommand({
  action,
  configuredProductId: configuredProductId || undefined,
  operationsSecret: process.env.BENT_SHIRT_OPERATIONS_SECRET,
  reason,
  serviceSecret: process.env.FOREVER_TEE_API_SHARED_SECRET,
  workerUrl: process.env.WORKER_URL,
});

console.log(JSON.stringify(result, null, 2));
