import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { localDate, settingsId } from "@bent/fitness-contracts/domain";
import { reviewPlan } from "@bent/fitness-contracts/proposal";
import { requireOwner } from "./auth";
import {
  StoreRuleError,
  decideProposal,
  loadRecords,
  pendingProposal,
} from "./store";

// The Plan screen imports this module, so it holds only server functions.

/** The pending plan proposal, checked against the settings as they are now. */
export const planProposal = createServerFn({ method: "GET" }).handler(
  async () => {
    const owner = await requireOwner();
    const proposal = await pendingProposal(owner);
    if (!proposal) return { proposal: null, check: null };
    const settings = (await loadRecords(owner)).find(
      (r) => r.id === settingsId,
    )?.data;
    if (settings?.kind !== "settings") return { proposal, check: null };
    const check = reviewPlan(
      settings,
      proposal.plan,
      localDate(settings.timezone),
    );
    return {
      proposal,
      check: {
        ok: check.ok,
        errors: check.ok ? [] : check.errors,
        warnings: check.warnings,
      },
    };
  },
);

/** Accepts or dismisses a pending proposal. Record rule failures return their message. */
export const decidePlanProposal = createServerFn({ method: "POST" })
  .validator(
    z.object({ id: z.uuid(), decision: z.enum(["accepted", "dismissed"]) }),
  )
  .handler(async ({ data }) => {
    const owner = await requireOwner();
    try {
      const decided = await decideProposal(owner, data.id, data.decision);
      return { status: decided.status, error: null };
    } catch (error) {
      if (error instanceof StoreRuleError)
        return { status: null, error: error.message };
      throw error;
    }
  });
