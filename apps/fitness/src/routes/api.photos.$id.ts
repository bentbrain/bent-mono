import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { database } from "../server/db";
import { requireOwner } from "../server/auth";
export const Route = createFileRoute("/api/photos/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const owner = await requireOwner();
          const id = z.string().uuid().parse(params.id);
          const [row] =
            await database()`SELECT content_type,bytes FROM fitness_photos WHERE owner_id=${owner} AND id=${id}`;
          if (!row) return new Response("Photo not found.", { status: 404 });
          return new Response(
            Buffer.from(z.instanceof(Uint8Array).parse(row.bytes)),
            {
              headers: {
                "Content-Type": z
                  .enum(["image/jpeg", "image/png", "image/webp"])
                  .parse(row.content_type),
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
              },
            },
          );
        } catch {
          return new Response(
            "Sign in with an invited account to view this photo.",
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
