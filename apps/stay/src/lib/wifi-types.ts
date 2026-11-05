import { z } from "zod";

export const wifiPasswordSchema = z.strictObject({
  password: z.string().min(8).max(64),
});
export const wifiStateSchema = z.strictObject({
  password: z.string().min(8).max(64).nullable(),
});
export type WifiPassword = z.infer<typeof wifiPasswordSchema>;
