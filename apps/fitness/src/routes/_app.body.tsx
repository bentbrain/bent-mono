import { createFileRoute } from "@tanstack/react-router";
import { BodyScreen } from "../components/app";
export const Route = createFileRoute("/_app/body")({
  head: () => ({ meta: [{ title: "Body · Fitness · bent.build" }] }),
  component: BodyScreen,
});
