import { createServerFn } from "@tanstack/react-start";
import { mutationSchema } from "@bent/fitness-contracts/domain";
import { requireOwner } from "./auth";
import { loadRecords, saveRecord } from "./store";
import {
  assistantEndpoint,
  configurationReady,
  publicEndpoint,
  planScopeEnabled,
} from "./config";
/**
 * Whether account services are configured, and whether assistants can
 * connect to a public endpoint and sign in with plan access, so the
 * welcome page offers assistant setup.
 */
export const readiness = createServerFn({ method: "GET" }).handler(() => {
  const endpoint = assistantEndpoint();
  return {
    ready: configurationReady(),
    // The invitation names hosted chat apps, which reach public endpoints.
    assistantPlans:
      planScopeEnabled() && endpoint !== null && publicEndpoint(endpoint),
  };
});
export const load = createServerFn({ method: "GET" }).handler(async () => {
  const owner = await requireOwner();
  return { owner, records: await loadRecords(owner) };
});
export const save = createServerFn({ method: "POST" })
  .validator(mutationSchema)
  .handler(async ({ data }) => saveRecord(await requireOwner(), data));
