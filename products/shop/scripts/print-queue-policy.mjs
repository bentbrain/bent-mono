import { isDeepStrictEqual } from "node:util";

export async function verifyPrintQueue(cf, environment) {
  if (!["development", "production"].includes(environment)) throw new Error("Unknown print queue environment.");
  const name = `forever-tee-print-assets-${environment}`;
  const worker = environment === "production" ? "forever-tee-api" : "forever-tee-api-development";
  const bindings = (await cf.settings()).bindings?.filter(value => value.name === "PRINT_ASSET_JOBS");
  if (bindings?.length !== 1 || bindings[0].type !== "queue" || bindings[0].queue_name !== name) {
    throw new Error("Print queue binding differs from the reviewed environment.");
  }
  const consumers = await cf.printConsumers();
  if (!Array.isArray(consumers) || consumers.length !== 1 || consumers[0].type !== "worker" ||
      (consumers[0].script ?? consumers[0].service) !== worker ||
      !isDeepStrictEqual(consumers[0].settings, {
        batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 5, retry_delay: 15,
      })) throw new Error("Print queue consumer differs from the reviewed capacity and retry policy.");
  return { printQueueVerified: true, queue: name, concurrency: 5 };
}
