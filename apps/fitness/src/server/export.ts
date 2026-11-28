import { z } from "zod";
import { recordSchema } from "@bent/fitness-contracts/domain";
import { database } from "./db";
import { proposalOf } from "./store";

/**
 * The owner's records, plan proposals and photos as one `bent-fitness-v1`
 * JSON download,
 * streamed from a single read-only snapshot.
 */
export function exportResponse(owner: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await database().begin(
          "isolation level repeatable read read only",
          async (sql) => {
            controller.enqueue(
              encoder.encode(
                '{"format":"bent-fitness-v1","exportedAt":' +
                  JSON.stringify(new Date().toISOString()) +
                  ',"records":[',
              ),
            );
            let separator = "";
            for await (const rows of sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false ORDER BY updated_at`.cursor(
              25,
            )) {
              for (const row of rows) {
                const record = recordSchema.parse({
                  ...row,
                  updatedAt: z.coerce
                    .date()
                    .parse(row.updated_at)
                    .toISOString(),
                });
                controller.enqueue(
                  encoder.encode(separator + JSON.stringify(record)),
                );
                separator = ",";
              }
            }
            // Plan proposals assistants made, with their status, outside the
            // synced records.
            const proposals =
              await sql`SELECT id,status,plan,created_at,decided_at FROM fitness_plan_proposals WHERE owner_id=${owner} ORDER BY created_at`;
            controller.enqueue(
              encoder.encode(
                '],"planProposals":' +
                  JSON.stringify(proposals.map(proposalOf)) +
                  ',"photos":[',
              ),
            );
            separator = "";
            for await (const rows of sql`SELECT id,name,content_type,bytes FROM fitness_photos WHERE owner_id=${owner} ORDER BY created_at`.cursor(
              1,
            )) {
              for (const row of rows) {
                const photo = z
                  .object({
                    id: z.string(),
                    name: z.string(),
                    content_type: z.string(),
                    bytes: z.instanceof(Uint8Array),
                  })
                  .parse(row);
                controller.enqueue(
                  encoder.encode(
                    separator +
                      JSON.stringify({
                        id: photo.id,
                        name: photo.name,
                        type: photo.content_type,
                        base64: Buffer.from(photo.bytes).toString("base64"),
                      }),
                  ),
                );
                separator = ",";
              }
            }
            controller.enqueue(encoder.encode("]}"));
          },
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="fitness-export.json"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
