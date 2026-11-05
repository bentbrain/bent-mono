import "server-only";
import { get } from "@vercel/blob";
import { z } from "zod";

const homeControlsSchema = z.object({ url: z.url() }).strict();

export async function getPrivateHomeControlsUrl() {
  if (process.env.HOME_CONTROLS_URL) return process.env.HOME_CONTROLS_URL;
  const result = await get("guide/home-controls.json", {
    access: "private",
    useCache: false,
  });
  if (!result) return undefined;
  if (result.statusCode !== 200)
    throw new Error("Private controls configuration unavailable.");
  const value: unknown = await new Response(result.stream).json();
  return homeControlsSchema.parse(value).url;
}
