import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RunScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/run")({
  head: () => ({ meta: [{ title: "Run · Fitness · bent.build" }] }),
  validateSearch: (search: Record<string, unknown>): { runId?: string } => ({
    runId: z.string().uuid().optional().catch(undefined).parse(search.runId),
  }),
  component: Screen,
});
function Screen() {
  const { date, runId } = Route.useSearch();
  return <RunScreen key={`${date}:${runId}`} date={date ?? ""} runId={runId} />;
}
