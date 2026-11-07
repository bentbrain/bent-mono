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
  for (const point of messages.records ?? []) {
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
      time:
        point.timestamp instanceof Date ? point.timestamp.getTime() : undefined,
    });
  }
  const sport = messages.sessions?.[0]?.sport;
  return {
    name,
    sport: typeof sport === "string" ? sport.replaceAll("_", " ") : "Activity",
    points,
  };
}
