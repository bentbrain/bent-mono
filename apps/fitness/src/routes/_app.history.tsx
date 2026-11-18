import { createFileRoute } from "@tanstack/react-router";
import { HistoryScreen } from "../components/app";
export const Route = createFileRoute("/_app/history")({
  component: HistoryScreen,
});
