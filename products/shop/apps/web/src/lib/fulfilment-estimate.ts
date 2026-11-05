export interface BusinessDayEstimate {
  readonly maximumBusinessDays: number;
  readonly minimumBusinessDays: number;
}

export interface FulfilmentEstimate {
  readonly production?: BusinessDayEstimate;
  readonly standardDelivery?: BusinessDayEstimate;
}

function businessDayEstimateText(estimate: BusinessDayEstimate) {
  return `${String(estimate.minimumBusinessDays)} to ${String(estimate.maximumBusinessDays)} business days`;
}

export function fulfilmentEstimateLines(estimate: FulfilmentEstimate) {
  const lines: string[] = [];
  if (estimate.production) {
    lines.push(`- production: ${businessDayEstimateText(estimate.production)}`);
  }
  if (estimate.standardDelivery) {
    lines.push(`- shipping: ${businessDayEstimateText(estimate.standardDelivery)}`);
  }
  return lines;
}
