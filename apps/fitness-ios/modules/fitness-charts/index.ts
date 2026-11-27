import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";

/** What the popover says for one point: a short title and one or more lines. */
type ChartLabel = { title: string; detail: string };

/** The chart's colours as hex strings, from the theme tokens. */
export type ChartColors = {
  line?: string;
  average?: string;
  guide?: string;
  target?: string;
  cursor?: string;
  card?: string;
  text?: string;
  muted?: string;
};

type Common = {
  /** One label for each point, or each bar position in order. */
  labels: ChartLabel[];
  colors: ChartColors;
};

/**
 * A line without axes over `yMin` to `yMax`, with an optional dashed
 * average line and dotted guides at the given values.
 */
export type LineChartSpec = Common & {
  kind: "line";
  points: { x: number; y: number }[];
  average?: { x: number; y: number }[];
  guides?: number[];
  yMin: number;
  yMax: number;
};

/** Bars, stacked where they share an `x`, with an optional dashed target line. */
export type BarChartSpec = Common & {
  kind: "bar";
  bars: { x: string; y: number; color?: string }[];
  target?: number;
  showAxes: boolean;
  cornerRadius: number;
  animate: boolean;
};

/** The native chart's props. */
export type FitnessChartProps = ViewProps & {
  chart: LineChartSpec | BarChartSpec;
  /** Selects a point from JavaScript, such as a VoiceOver adjustment. Give each request a new `id`; -1 clears. */
  selection?: { index: number; id: number };
  /** A touch or a data change moved the selection; -1 means none. */
  onSelectionChange?: (event: { nativeEvent: { index: number } }) => void;
  /** Whether the popover fits inside the chart. When it doesn't, it is hidden, so show the details elsewhere. */
  onCardFit?: (event: { nativeEvent: { fits: boolean } }) => void;
};

/**
 * A Swift Charts chart. Tapping, long-pressing or dragging sideways
 * across it selects the nearest point, draws a cursor and shows its label
 * with a selection haptic; tapping the selected point again clears it.
 */
export const FitnessChart: ComponentType<FitnessChartProps> = requireNativeView("FitnessCharts");
