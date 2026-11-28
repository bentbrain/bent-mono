import { createFileRoute } from "@tanstack/react-router";
import { ProposalScreen } from "../components/plan-proposal";
export const Route = createFileRoute("/_app/proposal")({
  head: () => ({ meta: [{ title: "Plan proposal · Fitness · bent.build" }] }),
  component: ProposalScreen,
});
