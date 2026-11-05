import { runOperationsCommand } from "../src/operations-client.ts";

const [action, reason, configuredProductId] = process.argv.slice(2);
const result = await runOperationsCommand({
  action,
  configuredProductId: configuredProductId || undefined,
  operationsSecret: process.env.BENT_SHIRT_OPERATIONS_SECRET,
  reason,
  serviceSecret: process.env.FOREVER_TEE_API_SHARED_SECRET,
  workerUrl: process.env.WORKER_URL,
});

console.log(JSON.stringify(result, null, 2));
