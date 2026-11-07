import { parseActivityXml, xmlNodes as nodes } from "./xml";
import type { XmlNode } from "./xml";

export interface TrackPoint {
  lat: number;
  lon: number;
  elevation?: number;
  time?: number;
  segment: number;
}

export interface Activity {
  name: string;
  sport: string;
  points: TrackPoint[];
  demo?: boolean;
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_POINTS = 150_000;

function content(root: XmlNode, name: string) {
  return nodes(root, name)[0]?.text.trim() || undefined;
}
function number(value: string | null | undefined) {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function timestamp(value: string | undefined) {
  if (!value) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}
function validPoint(
  lat: number | undefined,
  lon: number | undefined,
): lat is number {
  return (
    lat !== undefined &&
    lon !== undefined &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

export function parseXml(text: string, filename: string): Activity {
  const doc = parseActivityXml(text);
  const gpx = nodes(doc, "gpx").length > 0;
  const tcx = nodes(doc, "TrainingCenterDatabase").length > 0;
  if (!gpx && !tcx) throw new Error("This is not a GPX or TCX activity.");
  const points: TrackPoint[] = [];
  const groups = gpx
    ? [...nodes(doc, "trkseg"), ...nodes(doc, "rte")]
    : nodes(doc, "Track");
  let segment = 0;
  for (const group of groups) {
    segment++;
    const entries = gpx
      ? [...nodes(group, "trkpt"), ...nodes(group, "rtept")]
      : nodes(group, "Trackpoint");
    for (const entry of entries) {
      const lat = number(
        gpx ? entry.attributes.lat : content(entry, "LatitudeDegrees"),
      );
      const lon = number(
        gpx ? entry.attributes.lon : content(entry, "LongitudeDegrees"),
      );
      // A missing position is a track break, never a line through unknown space.
      if (!validPoint(lat, lon) || lon === undefined) {
        if (gpx)
          throw new Error(
            "A route point has invalid coordinates. Export the activity again.",
          );
        segment++;
        continue;
      }
      points.push({
        lat,
        lon,
        elevation: number(content(entry, gpx ? "ele" : "AltitudeMeters")),
        time: timestamp(content(entry, gpx ? "time" : "Time")),
        segment,
      });
      if (points.length > MAX_POINTS)
        throw new Error("This activity exceeds 150,000 GPS points.");
    }
  }
  return finish({
    name: content(doc, "name") || content(doc, "Name") || cleanName(filename),
    sport: gpx
      ? content(doc, "type") || "Activity"
      : nodes(doc, "Activity")[0]?.attributes.Sport || "Activity",
    points,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGeoJson(text: string, filename: string): Activity {
  const input: unknown = JSON.parse(text);
  const lines: unknown[] = [];
  let name = cleanName(filename);
  function visit(value: unknown) {
    if (!record(value)) throw new Error("Invalid GeoJSON geometry.");
    if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
      for (const feature of value.features) visit(feature);
    } else if (value.type === "Feature") {
      if (record(value.properties) && typeof value.properties.name === "string")
        name = value.properties.name;
      visit(value.geometry);
    } else if (value.type === "LineString") {
      lines.push(value.coordinates);
    } else if (
      value.type === "MultiLineString" &&
      Array.isArray(value.coordinates)
    ) {
      lines.push(...value.coordinates);
    } else throw new Error("Use GeoJSON LineString or MultiLineString routes.");
  }
  visit(input);
  const points: TrackPoint[] = [];
  for (const [segment, line] of lines.entries()) {
    if (!Array.isArray(line)) throw new Error("Invalid GeoJSON coordinates.");
    for (const coordinate of line) {
      if (!Array.isArray(coordinate))
        throw new Error("Invalid GeoJSON coordinates.");
      const [lon, lat, elevation] = coordinate;
      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !validPoint(lat, lon)
      )
        throw new Error("A route point has invalid coordinates.");
      points.push({
        lat,
        lon,
        elevation:
          typeof elevation === "number" && Number.isFinite(elevation)
            ? elevation
            : undefined,
        segment,
      });
      if (points.length > MAX_POINTS)
        throw new Error("This activity exceeds 150,000 GPS points.");
    }
  }
  return finish({ name, sport: "Activity", points });
}

export async function parseFile(file: File): Promise<Activity> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error("Choose an activity file smaller than 20 MB.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "fit") {
    const { decodeFit } = await import("./fit");
    return finish(
      await decodeFit(await file.arrayBuffer(), cleanName(file.name)),
    );
  }
  if (extension === "gpx" || extension === "tcx")
    return parseXml(await file.text(), file.name);
  if (extension === "geojson" || extension === "json")
    return parseGeoJson(await file.text(), file.name);
  throw new Error("Choose a GPX, TCX, FIT or GeoJSON activity file.");
}

function cleanName(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]/g, " ")
      .slice(0, 80) || "My activity"
  );
}
function finish(activity: Activity): Activity {
  if (activity.points.length < 2)
    throw new Error(
      "This activity needs at least two GPS points. Indoor activities without GPS cannot be mapped.",
    );
  if (activity.points.length > MAX_POINTS)
    throw new Error("This activity exceeds 150,000 GPS points.");
  return {
    ...activity,
    name: activity.name.slice(0, 80),
    sport: activity.sport.slice(0, 40),
  };
}

export function distance(a: TrackPoint, b: TrackPoint) {
  const rad = Math.PI / 180;
  const sinLat = Math.sin(((b.lat - a.lat) * rad) / 2);
  const sinLon = Math.sin(((b.lon - a.lon) * rad) / 2);
  const h =
    sinLat ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sinLon ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function statistics(points: TrackPoint[]) {
  let metres = 0;
  let ascent = 0;
  let hasElevation = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.segment !== b.segment) continue;
    metres += distance(a, b);
    if (a.elevation !== undefined && b.elevation !== undefined) {
      ascent += Math.max(0, b.elevation - a.elevation);
      hasElevation = true;
    }
  }
  const first = points[0]?.time;
  const last = points.at(-1)?.time;
  const seconds =
    first !== undefined && last !== undefined && last > first
      ? (last - first) / 1000
      : undefined;
  return { metres, ascent: hasElevation ? ascent : undefined, seconds };
}

export function trimRoute(points: TrackPoint[], metres: number) {
  if (metres <= 0) return points;
  let start = 0;
  let end = points.length - 1;
  let travelled = 0;
  while (start < end && travelled < metres) {
    if (points[start].segment === points[start + 1].segment)
      travelled += distance(points[start], points[start + 1]);
    start++;
  }
  travelled = 0;
  while (end > start && travelled < metres) {
    if (points[end].segment === points[end - 1].segment)
      travelled += distance(points[end], points[end - 1]);
    end--;
  }
  return points.slice(start, end + 1);
}

export function demoActivity(): Activity {
  // Invented route around a synthetic origin. No personal GPS data.
  const points = Array.from({ length: 520 }, (_, i) => {
    const t = (i / 519) * Math.PI * 2;
    return {
      lat: 0.015 * Math.sin(t) + 0.004 * Math.sin(t * 3),
      lon: 0.022 * Math.cos(t) + 0.005 * Math.sin(t * 5),
      elevation: 100 + 140 * (1 + Math.sin(t * 2 - 1)) + 30 * Math.sin(t * 7),
      time: Date.UTC(2026, 0, 1) + i * 8500,
      segment: 0,
    };
  });
  return { name: "Sample activity", sport: "Run", points, demo: true };
}
