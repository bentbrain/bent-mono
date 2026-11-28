import { createServerFn } from "@tanstack/react-start";
import { mutationSchema } from "@bent/fitness-contracts/domain";
import { requireOwner } from "./auth";
import { loadRecords, saveRecord } from "./store";
import { configurationReady, planScopeEnabled } from "./config";
/**
 * Whether account services are configured, and whether assistants can sign
 * in with plan access, so the welcome page offers assistant setup.
 */
export const readiness = createServerFn({ method: "GET" }).handler(() => ({
  ready: configurationReady(),
  assistantPlans: planScopeEnabled(),
}));
export const load = createServerFn({ method: "GET" }).handler(async () => {
  const owner = await requireOwner();
  return { owner, records: await loadRecords(owner) };
});
export const save = createServerFn({ method: "POST" })
  .validator(mutationSchema)
  .handler(async ({ data }) => saveRecord(await requireOwner(), data));
