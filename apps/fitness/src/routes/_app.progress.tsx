import { createFileRoute } from "@tanstack/react-router";
import { ProgressScreen } from "../components/progress-screen";
export const Route = createFileRoute("/_app/progress")({
  head: () => ({ meta: [{ title: "Progress · Fitness · bent.build" }] }),
  component: ProgressScreen,
});
