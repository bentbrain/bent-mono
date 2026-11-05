import {
  fulfilmentEstimateLines,
  type FulfilmentEstimate,
} from "@/lib/fulfilment-estimate";

export function ShippingTimingCopy({
  estimate,
}: {
  estimate: FulfilmentEstimate;
}) {
  const lines = fulfilmentEstimateLines(estimate);
  if (lines.length === 0) {
    return <p>Current production and shipping estimates are temporarily unavailable.</p>;
  }
  return (
    <div data-fulfilment-estimate>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
