import { describe, expect, test } from "bun:test";
import { chartHint, selectionValue, stepSelection } from "../src/ui/chartSelection";
import { strengthLabels } from "../src/screens/progress/summary";

describe("chart selection for VoiceOver", () => {
  test("swiping up and down moves through the points and stops at the ends", () => {
    expect(stepSelection(null, 3, "increment")).toBe(0);
    expect(stepSelection(null, 3, "decrement")).toBe(2);
    expect(stepSelection(0, 3, "increment")).toBe(1);
    expect(stepSelection(2, 3, "increment")).toBe(2);
    expect(stepSelection(1, 3, "decrement")).toBe(0);
    expect(stepSelection(0, 3, "decrement")).toBe(0);
  });

  test("a selection past the data starts again, and an empty chart selects nothing", () => {
    expect(stepSelection(5, 3, "increment")).toBe(0);
    expect(stepSelection(5, 3, "decrement")).toBe(2);
    expect(stepSelection(null, 0, "increment")).toBeNull();
    expect(stepSelection(1, 3, "activate")).toBe(1);
  });

  test("reads the selected point's title and each line, or nothing without a selection", () => {
    const labels = strengthLabels(
      {
        key: "squat:reps:0",
        name: "Goblet squat",
        mode: "reps",
        side: false,
        points: [
          { date: "2026-11-02", loadKg: 10, value: 8 },
          { date: "2026-11-04", loadKg: 12, value: 8 },
          { date: "2026-11-06", loadKg: 12, value: 8 },
        ],
      },
      "kg",
    );
    // A three-session chart reads its middle session too.
    expect(selectionValue(labels, 1)).toBe("Wed 4 Nov: 12 kg × 8, +2 kg since Mon 2 Nov");
    expect(selectionValue(labels, 2)).toBe("Fri 6 Nov: 12 kg × 8, No change since Wed 4 Nov");
    expect(selectionValue(labels, null)).toBe("");
    expect(selectionValue(labels, 7)).toBe("");
    expect(chartHint).toBe("Swipe up or down to hear each point.");
  });
});
