import FitParser from "fit-file-parser";
import type { Activity, TrackPoint } from "./activity";

export async function decodeFit(
  buffer: ArrayBuffer,
  name: string,
): Promise<Activity> {
  const parser = new FitParser({
    force: false,
    strict: true,
    mode: "list",
    lengthUnit: "m",
    includeRawMessages: [18, 20, 21],
  });
  let messages;
  try {
    messages = await parser.parseAsync(buffer);
  } catch {
    throw new Error(
      "This FIT file is damaged or incomplete. Export the original activity again.",
    );
  }
  const points: TrackPoint[] = [];
  let segment = 0;
  let paused = false;
  // The retained message order disambiguates records and timer/session events
  // sharing a timestamp, and preserves boundaries even without record times.
  for (const message of messages.raw_messages ?? []) {
    if (message.global_message_number === 18) {
      segment++;
      paused = false;
      continue;
    }
    if (message.global_message_number === 21) {
      const event = messages.events?.[message.message_index];
      if (event?.event !== "timer") continue;
      if (event.event_type === "start") {
        segment++;
        paused = false;
      } else if (
        ["stop", "stop_all", "stop_disable", "stop_disable_all"].includes(
          String(event.event_type),
        )
      ) {
        segment++;
        paused = true;
      }
      continue;
    }
    const point = messages.records?.[message.message_index];
    if (message.global_message_number !== 20 || !point || paused) continue;
    const time =
      point.timestamp instanceof Date ? point.timestamp.getTime() : undefined;
    const lat = point.position_lat;
    const lon = point.position_long;
    if (
      lat === undefined ||
      lon === undefined ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      segment++;
      continue;
    }
    const elevation = point.enhanced_altitude ?? point.altitude;
    points.push({
      lat,
      lon,
      segment,
      elevation:
        elevation !== undefined && Number.isFinite(elevation)
          ? elevation
          : undefined,
      time,
    });
  }
  const sport = messages.sessions?.[0]?.sport;
  return {
    name,
    sport: typeof sport === "string" ? sport.replaceAll("_", " ") : "Activity",
    points,
  };
}
