import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ExercisesScreen } from "../components/exercises";
export const Route = createFileRoute("/_app/guides")({
  head: () => ({ meta: [{ title: "Exercises · Fitness · bent.build" }] }),
  validateSearch: (search: Record<string, unknown>): { exercise?: string } => ({
    exercise: z
      .string()
      .regex(/^[a-z]{2,20}$/)
      .optional()
      .catch(undefined)
      .parse(search.exercise),
  }),
  component: Screen,
});
function Screen() {
  const { exercise } = Route.useSearch();
  return <ExercisesScreen key={exercise ?? ""} exercise={exercise} />;
}
