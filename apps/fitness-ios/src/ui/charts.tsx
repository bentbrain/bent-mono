import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { FitnessChart } from "../../modules/fitness-charts";
import type { BarChartSpec, ChartColors, LineChartSpec } from "../../modules/fitness-charts";
import { AppText } from "./Text";
import { chartHint, selectionValue, stepSelection } from "./chartSelection";

/** A theme colour token as a hex string, such as `--color-primary`. */
export function useColor(name: string) {
  const value = useCSSVariable(name);
  return typeof value === "string" ? value : undefined;
}

/** The cursor and popover colours every chart shares. */
export function useSelectionColors(): ChartColors {
  return {
    cursor: useColor("--color-border-strong"),
    card: useColor("--color-card-alt"),
    text: useColor("--color-foreground"),
    muted: useColor("--color-foreground-secondary"),
  };
}

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

/**
 * A native chart that shows each point's label. Touch selects a point and
 * the popover shows its label; when the popover doesn't fit, as with large
 * text, the label shows below the chart instead. VoiceOver reads `label`
 * and adjusts the selection with a swipe up or down, reading each point.
 */
export function SelectableChart({
  chart,
  height,
  label,
  testID,
}: {
  chart: LineChartSpec | BarChartSpec;
  height: number;
  label: string;
  testID?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [request, setRequest] = useState({ index: -1, id: 0 });
  const [cardFits, setCardFits] = useState(true);
  const count = chart.labels.length;
  const current = selected !== null && selected < count ? selected : null;
  const shown = current === null ? undefined : chart.labels[current];
  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityHint={chartHint}
        accessibilityValue={{ text: selectionValue(chart.labels, current) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const next = stepSelection(current, count, event.nativeEvent.actionName);
          setSelected(next);
          setRequest((last) => ({ index: next ?? -1, id: last.id + 1 }));
        }}
        testID={testID}
        style={{ height }}
      >
        <FitnessChart
          style={StyleSheet.absoluteFill}
          {...hidden}
          chart={chart}
          selection={request}
          onSelectionChange={(event) => setSelected(event.nativeEvent.index < 0 ? null : event.nativeEvent.index)}
          onCardFit={(event) => setCardFits(event.nativeEvent.fits)}
        />
      </View>
      {shown && !cardFits ? (
        <View
          className="gap-0.5 rounded-xl bg-card-alt px-3 py-2"
          {...hidden}
          testID={testID ? `${testID}-details` : undefined}
        >
          <AppText textRole="footnote" weight="semibold">
            {shown.title}
          </AppText>
          <AppText textRole="footnote" tone="secondary">
            {shown.detail}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
