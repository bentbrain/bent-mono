import { z } from "zod";

export type JsonValue =
  boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
