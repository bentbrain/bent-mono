import { describe, expect, test } from "bun:test";
import { FitEncoder, FitBaseType } from "fit-file-parser/encoder";
import {
  demoActivity,
  distance,
  parseFile,
  parseGeoJson,
  parseXml,
  statistics,
  trimRoute,
} from "../src/activity";
import { decodeFit } from "../src/fit";
import { prepareRoute } from "../src/render";

const gpx =
  '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Synthetic run</name><type>Running</type><trkseg><trkpt lat="0" lon="0"><ele>10</ele><time>2026-01-01T00:00:00Z</time></trkpt><trkpt lat="0.01" lon="0.01"><ele>30</ele><time>2026-01-01T00:10:00Z</time></trkpt></trkseg></trk></gpx>';

function fitWithBreak(
  stopType: number | undefined,
  sessions = false,
  resumeAt = 120,
) {
  const encoder = new FitEncoder();
  const timestamp = (seconds: number) =>
    FitEncoder.toFitTimestamp(new Date(Date.UTC(2026, 0, 1) + seconds * 1000));
  function record(seconds: number, longitude: number) {
    encoder.writeMessage(20, [
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 0 },
      {
        number: 1,
        size: 4,
        baseType: FitBaseType.Sint32,
        value: Math.round((longitude * 2147483648) / 180),
      },
      {
        number: 253,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: timestamp(seconds),
      },
    ]);
  }
  function event(seconds: number, type: number) {
    encoder.writeMessage(21, [
      { number: 0, size: 1, baseType: FitBaseType.Enum, value: 0 },
      { number: 1, size: 1, baseType: FitBaseType.Enum, value: type },
      {
        number: 253,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: timestamp(seconds),
      },
    ]);
  }
  function session(start: number, end: number) {
    encoder.writeMessage(18, [
      {
        number: 2,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: timestamp(start),
      },
      {
        number: 253,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: timestamp(end),
      },
    ]);
  }
  if (stopType !== undefined) event(0, 0);
  record(0, 0);
  record(10, 0.001);
  if (stopType !== undefined) {
    event(10, stopType);
    if (resumeAt > 10) record(60, 0.05); // Paused GPS samples must not create a route.
    event(resumeAt, 0);
  }
  if (sessions) session(0, 10);
  record(resumeAt, 0.101);
  record(130, 0.102);
  if (sessions) session(resumeAt, 130);
  return Uint8Array.from(encoder.close()).buffer;
}

describe("activity import", () => {
  test("reads namespaced Strava GPX including zero coordinates, elevation and time", () => {
    const activity = parseXml(gpx, "activity.gpx");
    expect(activity.name).toBe("Synthetic run");
    expect(activity.points[0].lat).toBe(0);
    expect(statistics(activity.points)).toMatchObject({
      ascent: 20,
      seconds: 600,
    });
    expect(statistics(activity.points).metres).toBeGreaterThan(1500);
  });
  test("reads GPX routes and keeps separate track segments", () => {
    const route = parseXml(
      '<gpx><rte><rtept lat="0" lon="0"/><rtept lat="0" lon="0.01"/></rte></gpx>',
      "rte.gpx",
    );
    expect(route.points).toHaveLength(2);
    const activity = parseXml(
      '<gpx><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon=".01"/></trkseg><trkseg><trkpt lat="20" lon="20"/><trkpt lat="20" lon="20.01"/></trkseg></trk></gpx>',
      "segments.gpx",
    );
    expect(statistics(activity.points).metres).toBeLessThan(2300);
    expect(activity.points[1].segment).not.toBe(activity.points[2].segment);
  });
  test("reads TCX and breaks the route across missing positions", () => {
    const activity = parseXml(
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Lap><Track><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position><AltitudeMeters>10</AltitudeMeters></Trackpoint><Trackpoint/><Trackpoint><Position><LatitudeDegrees>20</LatitudeDegrees><LongitudeDegrees>20</LongitudeDegrees></Position></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>',
      "ride.tcx",
    );
    expect(activity.sport).toBe("Biking");
    expect(activity.points).toHaveLength(2);
    expect(statistics(activity.points).metres).toBe(0);
    expect(activity.points[0].segment).not.toBe(activity.points[1].segment);
  });
  test("rejects invalid coordinates, entities and GPS-free activities", () => {
    expect(() => parseXml(gpx.replace('lat="0"', 'lat=""'), "bad.gpx")).toThrow(
      "invalid coordinates",
    );
    expect(() =>
      parseXml(gpx.replace('lat="0"', 'lat="91"'), "bad.gpx"),
    ).toThrow("invalid coordinates");
    expect(() => parseXml("<!DOCTYPE gpx><gpx/>", "bad.gpx")).toThrow(
      "document types",
    );
    expect(() => parseXml("<gpx/>", "indoor.gpx")).toThrow("two GPS points");
  });
  test("imports GeoJSON collections with disconnected lines", () => {
    const activity = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Synthetic ride" },
            geometry: {
              type: "MultiLineString",
              coordinates: [
                [
                  [0, 0, 10],
                  [0.01, 0, 30],
                ],
                [
                  [20, 20],
                  [20.01, 20],
                ],
              ],
            },
          },
        ],
      }),
      "route.geojson",
    );
    expect(activity.name).toBe("Synthetic ride");
    expect(activity.points).toHaveLength(4);
    expect(statistics(activity.points).metres).toBeLessThan(2300);
    expect(() =>
      parseGeoJson('{"type":"Point","coordinates":[0,0]}', "point.json"),
    ).toThrow("LineString");
  });
  test("decodes a generated FIT file and rejects a corrupt original", async () => {
    const encoder = new FitEncoder();
    for (const [lat, lon, altitude, date] of [
      [0, 0, 10, "2026-01-01T00:00:00Z"],
      [119305, 119305, 30, "2026-01-01T00:10:00Z"],
    ] satisfies [number, number, number, string][]) {
      encoder.writeMessage(20, [
        { number: 0, size: 4, baseType: FitBaseType.Sint32, value: lat },
        { number: 1, size: 4, baseType: FitBaseType.Sint32, value: lon },
        {
          number: 2,
          size: 2,
          baseType: FitBaseType.Uint16,
          value: (altitude + 500) * 5,
        },
        {
          number: 253,
          size: 4,
          baseType: FitBaseType.Uint32,
          value: FitEncoder.toFitTimestamp(new Date(date)),
        },
      ]);
    }
    const data = Uint8Array.from(encoder.close());
    const activity = await decodeFit(data.buffer, "FIT ride");
    expect(activity.points).toHaveLength(2);
    expect(activity.points[1].lat).toBeCloseTo(0.01, 3);
    expect(statistics(activity.points)).toMatchObject({
      ascent: 20,
      seconds: 600,
    });
    data[15] ^= 255;
    await expect(decodeFit(data.buffer, "bad")).rejects.toThrow("damaged");
  });
  test("enforces file sizes and type before reading", async () => {
    await expect(
      parseFile(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.fit")),
    ).rejects.toThrow("20 MB");
    await expect(parseFile(new File(["hello"], "notes.txt"))).rejects.toThrow(
      "Choose a GPX",
    );
  });
  test("FIT timer pauses preserve separate legs and elapsed time", async () => {
    for (const stopType of [1, 4, 8, 9]) {
      const activity = await decodeFit(fitWithBreak(stopType), "Paused FIT");
      expect(activity.points).toHaveLength(4);
      expect(activity.points[0].segment).toBe(activity.points[1].segment);
      expect(activity.points[1].segment).not.toBe(activity.points[2].segment);
      expect(activity.points[2].segment).toBe(activity.points[3].segment);
      expect(statistics(activity.points).metres).toBeCloseTo(222.4, 0);
      expect(statistics(activity.points).seconds).toBe(130);
      expect(
        new Set(prepareRoute(activity.points).map((point) => point.segment))
          .size,
      ).toBe(2);
      expect(trimRoute(activity.points, 150).length).toBeLessThan(2);
    }
  });
  test("FIT sessions break geometry even without timer events", async () => {
    const activity = await decodeFit(
      fitWithBreak(undefined, true),
      "Multisport FIT",
    );
    expect(activity.points).toHaveLength(4);
    expect(activity.points[1].segment).not.toBe(activity.points[2].segment);
    expect(statistics(activity.points).metres).toBeCloseTo(222.4, 0);
    expect(statistics(activity.points).seconds).toBe(130);
  });
  test("FIT boundaries retain file order when timestamps coincide", async () => {
    for (const buffer of [
      fitWithBreak(4, false, 10),
      fitWithBreak(undefined, true, 10),
    ]) {
      const activity = await decodeFit(buffer, "Adjacent FIT legs");
      expect(activity.points).toHaveLength(4);
      expect(activity.points[1].time).toBe(activity.points[2].time);
      expect(activity.points[1].segment).not.toBe(activity.points[2].segment);
      expect(statistics(activity.points).metres).toBeCloseTo(222.4, 0);
    }
  });
});

describe("route geometry and privacy", () => {
  test("trims both ends and fails closed on a route shorter than the trim", () => {
    const points = Array.from({ length: 21 }, (_, i) => ({
      lat: 0,
      lon: i * 0.001,
      segment: 0,
    }));
    const trimmed = trimRoute(points, 300);
    expect(distance(points[0], trimmed[0])).toBeGreaterThanOrEqual(300);
    expect(
      distance(points[20], trimmed.at(-1) ?? points[20]),
    ).toBeGreaterThanOrEqual(300);
    expect(trimRoute(points, 2000).length).toBeLessThan(2);
    expect(points).toHaveLength(21);
  });
  test("handles the date line without making a planet-wide route", () => {
    const points = [
      { lat: 0, lon: 179.99, segment: 0 },
      { lat: 0, lon: -179.99, segment: 0 },
    ];
    expect(statistics(points).metres).toBeLessThan(2300);
    expect(prepareRoute(points).map((p) => p.x)).toEqual([-0.5, 0.5]);
  });
  test("does not create sea-level cliffs from a missing altitude", () => {
    const points = [
      { lat: 0, lon: 0, elevation: 1000, segment: 0 },
      { lat: 0, lon: 0.01, segment: 0 },
    ];
    expect(prepareRoute(points).map((p) => p.z)).toEqual([0, 0]);
    expect(statistics(points).ascent).toBeUndefined();
    expect(statistics(points).seconds).toBeUndefined();
  });
  test("bounds long-route rendering while preserving segment boundaries", () => {
    const points = Array.from({ length: 100_000 }, (_, i) => ({
      lat: i * 0.000001,
      lon: 0,
      segment: Math.floor(i / 25000),
    }));
    const prepared = prepareRoute(points);
    expect(prepared.length).toBeLessThan(1900);
    expect(new Set(prepared.map((p) => p.segment)).size).toBe(4);
    expect(
      prepareRoute(demoActivity().points).every((p) => Number.isFinite(p.z)),
    ).toBe(true);
  });
});
