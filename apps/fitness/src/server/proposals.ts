import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { localDate, settingsId } from "@bent/fitness-contracts/domain";
import { planChanges, reviewPlan } from "@bent/fitness-contracts/proposal";
import { requireOwner } from "./auth";
import {
  ProposalReviewStale,
  StoreRuleError,
  decideProposal,
  loadRecords,
  pendingProposal,
} from "./store";

// The Plan proposal screen imports this module, so it holds only server
// functions.

/**
 * The pending plan proposal with its checks and the other settings it
 * changes, all from one read of the settings, and that read's revision.
 * Accepting sends the revision back, so it applies only to the settings
 * the owner reviewed.
 */
export const planProposal = createServerFn({ method: "GET" }).handler(
  async () => {
    const owner = await requireOwner();
    const proposal = await pendingProposal(owner);
    if (!proposal) return { proposal: null, review: null };
    const record = (await loadRecords(owner)).find((r) => r.id === settingsId);
    if (record?.data.kind !== "settings") return { proposal, review: null };
    const settings = record.data;
    const check = reviewPlan(
      settings,
      proposal.plan,
      localDate(settings.timezone),
    );
    return {
      proposal,
      review: {
        revision: record.revision,
        ok: check.ok,
        errors: check.ok ? [] : check.errors,
        warnings: check.warnings,
        changes: planChanges(settings, proposal.plan),
      },
    };
  },
);

/**
 * Accepts or dismisses a pending proposal. Record rule failures return their
 * message; `stale` means the settings changed after the review loaded.
 */
export const decidePlanProposal = createServerFn({ method: "POST" })
  .validator(
    z.discriminatedUnion("decision", [
      z.object({
        id: z.uuid(),
        decision: z.literal("accepted"),
        reviewedRevision: z.number().int().nonnegative(),
      }),
      z.object({ id: z.uuid(), decision: z.literal("dismissed") }),
    ]),
  )
  .handler(async ({ data }) => {
    const owner = await requireOwner();
    try {
      const decided = await decideProposal(
        owner,
        data.id,
        data.decision === "accepted"
          ? { status: "accepted", reviewedRevision: data.reviewedRevision }
          : { status: "dismissed" },
      );
      return { status: decided.status, error: null, stale: false };
    } catch (error) {
      if (error instanceof StoreRuleError)
        return {
          status: null,
          error: error.message,
          stale: error instanceof ProposalReviewStale,
        };
      throw error;
    }
  });
