import { z } from "zod";

const roomSchema = z.enum(["livingRoom", "bedroom"]);
export type Room = z.infer<typeof roomSchema>;

export const homeCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("light"),
      room: roomSchema,
      value: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("vacuum"),
      action: z.enum(["start", "pause", "dock"]),
    })
    .strict(),
]);
export type HomeCommand = z.infer<typeof homeCommandSchema>;

export const homeStateSchema = z.object({
  lights: z.object({
    livingRoom: z.number().min(0).max(100).nullable(),
    bedroom: z.number().min(0).max(100).nullable(),
  }),
  vacuum: z.object({
    state: z.string().nullable(),
    battery: z.number().min(0).max(100).nullable(),
    actions: z.array(z.enum(["start", "pause", "dock"])),
  }),
});
export type HomeState = z.infer<typeof homeStateSchema>;
