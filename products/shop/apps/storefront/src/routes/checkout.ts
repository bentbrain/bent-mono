import { createFileRoute } from "@tanstack/react-router";
import { GET } from "../server/checkout";
export const Route = createFileRoute("/checkout")({
  server: { handlers: { GET: ({ request }) => GET(request) } },
});
