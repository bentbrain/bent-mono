import "server-only";
import { z } from "zod";
import { homeStateSchema, type HomeCommand } from "./home-control-types";
import { wifiStateSchema, type WifiPassword } from "./wifi-types";

async function request(
  path: "state" | "command" | "wifi",
  command?: HomeCommand | WifiPassword,
) {
  const parsed = z.url().safeParse(process.env.HOME_CONTROL_BRIDGE_URL);
  const token = process.env.HOME_CONTROL_BRIDGE_TOKEN;
  if (!parsed.success || !token)
    throw new Error("Controls are not configured.");
  const url = new URL(parsed.data);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (process.env.VERCEL && url.protocol !== "https:")
  )
    throw new Error("Invalid controls URL.");
  const response = await fetch(new URL(`/${path}`, url), {
    method: command ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: command ? JSON.stringify(command) : undefined,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Controls request failed.");
  const data: unknown = await response.json();
  return data;
}

export async function getHomeState() {
  return homeStateSchema.parse(await request("state"));
}

export async function runHomeCommand(command: HomeCommand) {
  z.object({ ok: z.literal(true) }).parse(await request("command", command));
}

export async function getWifiPassword() {
  return wifiStateSchema.parse(await request("wifi"));
}

export async function saveWifiPassword(password: WifiPassword) {
  z.object({ ok: z.literal(true) }).parse(await request("wifi", password));
}
