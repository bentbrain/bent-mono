import "server-only";
import { z } from "zod";
import type { HomeCommand, HomeState, Room } from "./home-control-types";

// Match the guest dashboard's existing room targets, preserving its lighting automations.
// Guests can never supply an entity ID, service name or Home Assistant URL.
const roomEntities: Record<Room, string> = {
  livingRoom: "input_number.living_room_dial_lamp_target",
  bedroom: "input_number.bedroom_dial_lamp_target",
};
const vacuumEntity = "vacuum.vacuum";
const vacuumServices = {
  start: "start",
  pause: "pause",
  dock: "return_to_base",
};
const entitySchema = z.object({
  state: z.string(),
  attributes: z.object({
    battery_level: z.number().min(0).max(100).nullable().optional(),
    supported_features: z.number().int().nonnegative().optional(),
  }),
});

function configuration() {
  const token = process.env.HOME_ASSISTANT_TOKEN;
  const parsed = z.url().safeParse(process.env.HOME_ASSISTANT_URL);
  if (!token || !parsed.success)
    throw new Error("Home Assistant is not configured.");
  const url = new URL(parsed.data);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (process.env.VERCEL && url.protocol !== "https:")
  )
    throw new Error("Invalid Home Assistant URL.");
  return { token, url };
}

async function request(
  path: string,
  body?: { entity_id: string; value?: number },
) {
  const config = configuration();
  const response = await fetch(new URL(`/api/${path}`, config.url), {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Home Assistant request failed.");
  const data: unknown = await response.json();
  return data;
}

async function entity(id: string) {
  const data = await request(`states/${id}`);
  return entitySchema.parse(data);
}

function percentage(state: string) {
  if (!state.trim()) return null;
  const value = Number(state);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export async function getHomeState(): Promise<HomeState> {
  const [livingRoom, bedroom, vacuum] = await Promise.all([
    entity(roomEntities.livingRoom).catch(() => null),
    entity(roomEntities.bedroom).catch(() => null),
    entity(vacuumEntity).catch(() => null),
  ]);
  if (!livingRoom && !bedroom && !vacuum)
    throw new Error("Controls unavailable.");
  const vacuumAvailable =
    vacuum !== null && !["unknown", "unavailable"].includes(vacuum.state);
  const features = vacuum?.attributes.supported_features ?? 0;
  const actions: HomeState["vacuum"]["actions"] = [];
  // Home Assistant VacuumEntityFeature flags: START=8192, PAUSE=4, RETURN_HOME=16.
  if (vacuumAvailable && features & 8192) actions.push("start");
  if (vacuumAvailable && features & 4) actions.push("pause");
  if (vacuumAvailable && features & 16) actions.push("dock");
  return {
    lights: {
      livingRoom: livingRoom ? percentage(livingRoom.state) : null,
      bedroom: bedroom ? percentage(bedroom.state) : null,
    },
    vacuum: {
      state: vacuumAvailable ? vacuum.state : null,
      battery: vacuumAvailable
        ? (vacuum.attributes.battery_level ?? null)
        : null,
      actions,
    },
  };
}

export async function runHomeCommand(command: HomeCommand) {
  if (command.type === "light") {
    const target = roomEntities[command.room];
    if (percentage((await entity(target)).state) === null)
      throw new Error("Light unavailable.");
    await request("services/input_number/set_value", {
      entity_id: target,
      value: command.value,
    });
  } else {
    const state = await getHomeState();
    if (!state.vacuum.actions.includes(command.action))
      throw new Error("Vacuum action unavailable.");
    await request(`services/vacuum/${vacuumServices[command.action]}`, {
      entity_id: vacuumEntity,
    });
  }
}
