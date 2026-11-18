import { createFileRoute } from "@tanstack/react-router";
import { HistoryScreen } from "../components/app";
export const Route = createFileRoute("/_app/history")({
  head: () => ({ meta: [{ title: "History · Fitness · bent.build" }] }),
  component: HistoryScreen,
});
