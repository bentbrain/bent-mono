import { createFileRoute } from "@tanstack/react-router";
import { assistantGuide } from "../server/guide";
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(assistantGuide(), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
