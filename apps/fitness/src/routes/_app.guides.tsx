import { createFileRoute } from "@tanstack/react-router";
import { GuidesScreen } from "../components/app";
export const Route = createFileRoute("/_app/guides")({
  component: GuidesScreen,
});
