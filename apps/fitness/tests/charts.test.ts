import { describe, expect, test } from "bun:test";
import type { StrengthSeries } from "@bent/fitness-contracts/progress";
import {
  foodDayDetail,
  strengthChange,
  strengthDetail,
  weighInDetail,
  weightChange,
} from "../src/components/chart-details";
import {
  keySelection,
  nearestIndex,
  cardFits,
  placeCard,
  spokenDetail,
  touchIntent,
} from "../src/components/chart-popover";

describe("chart popover selection", () => {
  test("picks the point closest to the pointer, the first on a tie", () => {
    expect(nearestIndex([], 10)).toBeNull();
    expect(nearestIndex([30], 500)).toBe(0);
    expect(nearestIndex([30, 120, 300], 100)).toBe(1);
    expect(nearestIndex([30, 120, 300], 210)).toBe(1);
    expect(nearestIndex([30, 120, 300], 211)).toBe(2);
    expect(nearestIndex([30, 120, 300], -40)).toBe(0);
  });

  test("arrow keys, Home and End move the selection; Escape clears it", () => {
    expect(keySelection("ArrowRight", null, 4)).toBe(0);
    expect(keySelection("ArrowLeft", null, 4)).toBe(3);
    expect(keySelection("ArrowRight", 1, 4)).toBe(2);
    expect(keySelection("ArrowRight", 3, 4)).toBe(3);
    expect(keySelection("ArrowLeft", 0, 4)).toBe(0);
    expect(keySelection("ArrowDown", 0, 4)).toBe(1);
    expect(keySelection("ArrowUp", 2, 4)).toBe(1);
    expect(keySelection("Home", 2, 4)).toBe(0);
    expect(keySelection("End", 0, 4)).toBe(3);
    expect(keySelection("Escape", 2, 4)).toBeNull();
    // Keys the chart leaves alone keep their usual behaviour.
    expect(keySelection("Escape", null, 4)).toBeUndefined();
    expect(keySelection("Tab", 1, 4)).toBeUndefined();
    expect(keySelection("ArrowRight", null, 0)).toBeUndefined();
  });

  test("places the card beside the point and inside the chart", () => {
    const chart = { cardWidth: 150, cardHeight: 60, width: 340, height: 120 };
    // Right of the point when it fits.
    expect(placeCard({ ...chart, anchorX: 40, anchorY: 60 })).toEqual({
      left: 52,
      top: 30,
    });
    // Left of the point near the right edge.
    expect(placeCard({ ...chart, anchorX: 300, anchorY: 60 })).toEqual({
      left: 138,
      top: 30,
    });
    // Level with the point, kept within the top and bottom.
    expect(placeCard({ ...chart, anchorX: 40, anchorY: 5 }).top).toBe(0);
    expect(placeCard({ ...chart, anchorX: 40, anchorY: 118 }).top).toBe(60);
    // A phone-width chart with no room on either side keeps the card in view.
    expect(
      placeCard({ ...chart, width: 200, anchorX: 100, anchorY: 60 }),
    ).toEqual({ left: 0, top: 30 });
    expect(
      placeCard({ ...chart, width: 160, anchorX: 150, anchorY: 60 }).left,
    ).toBe(0);
    // A card taller than the chart starts at its top.
    expect(
      placeCard({ ...chart, height: 40, anchorX: 40, anchorY: 20 }).top,
    ).toBe(0);
  });

  test("a touch scrubs only once it moves sideways, and a vertical move scrolls", () => {
    // Small movements stay a possible tap, committed on release.
    expect(touchIntent(0, 0)).toBe("pending");
    expect(touchIntent(5, -6)).toBe("pending");
    // Sideways movement selects points under the finger.
    expect(touchIntent(9, 3)).toBe("scrub");
    expect(touchIntent(-20, 12)).toBe("scrub");
    // Vertical movement, or a diagonal that is mostly vertical, scrolls.
    expect(touchIntent(2, 12)).toBe("scroll");
    expect(touchIntent(-10, -10)).toBe("scroll");
    expect(touchIntent(3, 3, 2)).toBe("scroll");
  });

  test("reads the card as one sentence", () => {
    expect(
      spokenDetail({
        title: "Mon 5 Jan 2026",
        rows: [
          { label: "Weigh-in", value: "70.3 kg" },
          { label: "Since Sun 4 Jan", value: "−0.2 kg" },
        ],
      }),
    ).toBe("Mon 5 Jan 2026: Weigh-in 70.3 kg, Since Sun 4 Jan −0.2 kg.");
  });
});

describe("chart popover fit", () => {
  test("a card that is taller or wider than its chart shows below it", () => {
    expect(
      cardFits({ width: 150, height: 54 }, { width: 300, height: 54 }),
    ).toBe(true);
    expect(
      cardFits({ width: 150, height: 74 }, { width: 300, height: 54 }),
    ).toBe(false);
    expect(
      cardFits({ width: 320, height: 40 }, { width: 300, height: 54 }),
    ).toBe(false);
  });
});

describe("chart popover text", () => {
  const weights = [
    { date: "2026-01-04", kg: 70.5 },
    { date: "2026-01-05", kg: 70.25 },
    { date: "2026-01-07", kg: 71.2 },
  ];

  test("a weigh-in shows its value, its average and the change", () => {
    expect(weighInDetail(weights, 0, "kg", { kg: 70.5, count: 1 })).toEqual({
      title: "Sun 4 Jan 2026",
      rows: [
        { label: "Weigh-in", value: "70.5 kg", marker: "line" },
        { label: "Average of 1", value: "70.5 kg", marker: "dash" },
      ],
    });
    expect(weighInDetail(weights, 2, "kg", { kg: 70.65, count: 3 })).toEqual({
      title: "Wed 7 Jan 2026",
      rows: [
        { label: "Weigh-in", value: "71.2 kg", marker: "line" },
        { label: "Average of 3", value: "70.7 kg", marker: "dash" },
        { label: "Since Mon 5 Jan", value: "+1.0 kg" },
      ],
    });
    expect(weighInDetail(weights, 1, "lb").rows).toEqual([
      { label: "Weigh-in", value: "154.9 lb", marker: "line" },
      { label: "Since Sun 4 Jan", value: "−0.6 lb" },
    ]);
    expect(weighInDetail(weights, 5, "kg")).toEqual({ title: "", rows: [] });
  });

  test("weight changes carry a sign, and a rounded-away change is none", () => {
    expect(weightChange(0.44, "kg")).toBe("+0.4 kg");
    expect(weightChange(-1.25, "kg")).toBe("−1.3 kg");
    expect(weightChange(0.02, "kg")).toBe("No change");
    expect(weightChange(1, "lb")).toBe("+2.2 lb");
  });

  const squat: StrengthSeries = {
    key: "squat:reps:0",
    name: "Goblet squat",
    mode: "reps",
    side: false,
    load: "dumbbell",
    points: [
      { date: "2026-01-05", loadKg: 10, value: 8 },
      { date: "2026-01-07", loadKg: 12, value: 8 },
      { date: "2026-01-09", loadKg: 12, value: 10 },
      { date: "2026-01-12", loadKg: 12, value: 9 },
    ],
  };

  test("a session shows its best set and the change from the session before", () => {
    expect(strengthDetail(squat, 0, "kg")).toEqual({
      title: "Mon 5 Jan 2026",
      rows: [
        { label: "Best set", value: "10 kg × 8", marker: "line" },
        { label: "Session", value: "First in this chart" },
      ],
    });
    expect(strengthDetail(squat, 1, "kg").rows[1]).toEqual({
      label: "Since Mon 5 Jan",
      value: "+2 kg",
    });
    expect(strengthDetail(squat, 2, "kg").rows[1]?.value).toBe("+2 reps");
    expect(strengthDetail(squat, 3, "kg").rows[1]?.value).toBe("−1 rep");
    expect(strengthDetail(squat, 1, "lb").rows).toEqual([
      { label: "Best set", value: "26.46 lb × 8", marker: "line" },
      { label: "Since Mon 5 Jan", value: "+4.41 lb" },
    ]);
  });

  test("timed and sided exercises say so", () => {
    const plank: StrengthSeries = {
      key: "plank:seconds:0",
      name: "Plank",
      mode: "seconds",
      side: false,
      load: "bodyweight",
      points: [
        { date: "2026-01-05", loadKg: 0, value: 30 },
        { date: "2026-01-07", loadKg: 0, value: 45 },
        { date: "2026-01-09", loadKg: 0, value: 45 },
      ],
    };
    expect(strengthDetail(plank, 1, "kg").rows).toEqual([
      { label: "Longest hold", value: "45 s", marker: "line" },
      { label: "Since Mon 5 Jan", value: "+15 s" },
    ]);
    expect(strengthDetail(plank, 2, "kg").rows[1]?.value).toBe("No change");
    const row = { ...squat, side: true };
    expect(strengthDetail(row, 1, "kg").rows[0]?.value).toBe(
      "12 kg × 8 each side",
    );
    expect(
      strengthChange(
        { date: "2026-01-05", loadKg: 12, value: 8 },
        { date: "2026-01-07", loadKg: 10, value: 12 },
        squat,
        "kg",
      ),
    ).toBe("−2 kg");
  });

  test("a food day shows calories against the target and protein", () => {
    expect(
      foodDayDetail("2026-01-05", { calories: 1850.4, protein: 121.6 }, 2200),
    ).toEqual({
      title: "Mon 5 Jan 2026",
      rows: [
        { label: "Calories", value: "1850 kcal", marker: "bar" },
        { label: "Target", value: "2200 kcal", marker: "target" },
        { label: "Left", value: "350 kcal" },
        { label: "Protein", value: "122 g" },
      ],
    });
    expect(
      foodDayDetail("2026-01-05", { calories: 2400, protein: 0 }, 2200).rows[2],
    ).toEqual({ label: "Over", value: "200 kcal" });
  });
});
