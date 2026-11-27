import { View } from "react-native";
import { SelectableChart, useColor, useSelectionColors } from "../../ui/charts";
import type { PointLabel } from "../../ui/chartSelection";
import { chartScale } from "./summary";
import type { WeekBar } from "./summary";

type Point = { x: number; y: number };

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

/**
 * A line chart without axes, scaled to its own range so small changes stay
 * visible. An optional dashed `average` line shares the same scale, and
 * `guides` draw dotted lines at those values. Tapping or dragging across
 * it shows each point's label. VoiceOver reads `label` and each point.
 */
export function TrendChart({
  points,
  labels,
  average,
  guides = [],
  pad,
  height,
  label,
  testID,
}: {
  points: Point[];
  /** One popover label for each point. */
  labels: PointLabel[];
  average?: Point[];
  guides?: number[];
  /** Space kept above the highest and below the lowest value. */
  pad: number;
  height: number;
  label: string;
  testID?: string;
}) {
  const selection = useSelectionColors();
  const colors = {
    ...selection,
    line: useColor("--color-primary"),
    average: useColor("--color-foreground"),
    guide: useColor("--color-foreground-muted"),
  };
  const scale = chartScale(
    [...points, ...(average ?? [])].map((point) => point.y),
    pad,
  );
  return (
    <SelectableChart
      height={height}
      label={label}
      testID={testID}
      chart={{
        kind: "line",
        points,
        average,
        guides,
        yMin: scale.base,
        yMax: scale.base + scale.top,
        labels,
        colors,
      }}
    />
  );
}

/**
 * Stacked bars for each week: completed strength sessions, completed runs
 * and planned sessions not recorded. Tapping or dragging across it shows
 * each week's counts. VoiceOver reads `label` and each week; the rows
 * beside the chart list every value.
 */
export function WeekBarsChart({
  bars,
  labels,
  height,
  label,
}: {
  bars: WeekBar[];
  /** One popover label for each week, oldest first. */
  labels: PointLabel[];
  height: number;
  label: string;
}) {
  const colors = {
    strength: useColor("--color-primary"),
    runs: useColor("--color-done"),
    open: useColor("--color-border-strong"),
  };
  const selection = useSelectionColors();
  return (
    <SelectableChart
      height={height}
      label={label}
      testID="progress-week-chart"
      chart={{
        kind: "bar",
        bars: bars.map((bar) => ({ x: bar.x, y: bar.y, color: colors[bar.part] })),
        showAxes: true,
        cornerRadius: 3,
        animate: false,
        labels,
        colors: selection,
      }}
    />
  );
}

/** A small coloured square and its meaning, for chart legends. */
export function LegendSwatch({ part }: { part: WeekBar["part"] }) {
  const classes = {
    strength: "bg-primary",
    runs: "bg-done",
    open: "bg-border-strong",
  };
  return <View className={`size-2.5 rounded-sm ${classes[part]}`} {...hidden} />;
}
