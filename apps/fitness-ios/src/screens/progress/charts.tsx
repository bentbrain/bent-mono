import { Chart, Host } from "@expo/ui/swift-ui";
import { StyleSheet, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { chartScale } from "./summary";
import type { WeekBar } from "./summary";

type Point = { x: number; y: number };

function useColor(name: string) {
  const value = useCSSVariable(name);
  return typeof value === "string" ? value : undefined;
}

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

/**
 * A line chart without axes, scaled to its own range so small changes stay
 * visible. An optional dashed `average` line shares the same scale, and
 * `guides` draw dotted lines at those values. VoiceOver reads `label`.
 */
export function TrendChart({
  points,
  average,
  guides = [],
  pad,
  height,
  label,
  testID,
}: {
  points: Point[];
  average?: Point[];
  guides?: number[];
  /** Space kept above the highest and below the lowest value. */
  pad: number;
  height: number;
  label: string;
  testID?: string;
}) {
  const primary = useColor("--color-primary");
  const ink = useColor("--color-foreground");
  const muted = useColor("--color-foreground-muted");
  const scale = chartScale([...points, ...(average ?? [])].map((point) => point.y), pad);
  // Both charts include the same invisible frame, so their scales match.
  const frame = [
    { x: "frame-bottom", y: 0, color: "transparent" },
    { x: "frame-top", y: scale.top, color: "transparent" },
  ];
  const guideLines = (color: string | undefined) => guides.map((y, index) => ({ x: `guide-${index}`, y: scale.shift(y), color }));
  const shifted = (values: Point[]) => values.map((point) => ({ x: point.x, y: scale.shift(point.y) }));
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID={testID} style={{ height }}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
        <Host style={{ height, width: "100%" }}>
          <Chart
            type="line"
            data={shifted(points)}
            showGrid={false}
            animate={false}
            lineStyle={{ color: primary, width: 3, pointStyle: "circle", pointSize: 28 }}
            referenceLines={[...frame, ...guideLines(muted)]}
            ruleStyle={{ lineWidth: 1, dashArray: [2, 6] }}
          />
        </Host>
      </View>
      {average ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
          <Host style={{ height, width: "100%" }}>
            <Chart
              type="line"
              data={shifted(average)}
              showGrid={false}
              animate={false}
              lineStyle={{ color: ink, width: 2.5, dashArray: [8, 5], pointSize: 0.1 }}
              referenceLines={[...frame, ...guideLines("transparent")]}
              ruleStyle={{ lineWidth: 1 }}
            />
          </Host>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Stacked bars for each week: completed strength sessions, completed runs
 * and planned sessions not recorded. VoiceOver reads `label`; the rows
 * beside the chart list every value.
 */
export function WeekBarsChart({ bars, height, label }: { bars: WeekBar[]; height: number; label: string }) {
  const colors = {
    strength: useColor("--color-primary"),
    runs: useColor("--color-done"),
    open: useColor("--color-border-strong"),
  };
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID="progress-week-chart" style={{ height }}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
        <Host style={{ height, width: "100%" }}>
          <Chart
            type="bar"
            data={bars.map((bar) => ({ x: bar.x, y: bar.y, color: colors[bar.part] }))}
            showGrid
            animate={false}
            barStyle={{ cornerRadius: 3 }}
          />
        </Host>
      </View>
    </View>
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
