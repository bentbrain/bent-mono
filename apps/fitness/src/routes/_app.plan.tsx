import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PlanScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/plan")({
  validateSearch: (search: Record<string, unknown>) => ({
    routineId: z.string().uuid().catch("").parse(search.routineId),
  }),
  component: Screen,
});
function Screen() {
  const { date, routineId } = Route.useSearch();
  return (
    <PlanScreen
      key={`${date}:${routineId}`}
      date={date ?? ""}
      routineId={routineId}
    />
  );
}
