import { createFileRoute } from "@tanstack/react-router";
import { FoodScreen } from "../components/app";
export const Route = createFileRoute("/_app/food")({
  head: () => ({ meta: [{ title: "Food · Fitness · bent.build" }] }),
  component: FoodScreen,
});
