import type { FulfilmentEstimate } from "@/lib/fulfilment-estimate";
import { fulfilmentEstimateLines } from "@/lib/fulfilment-estimate";

export function ProductFulfilmentEstimate({
  estimate,
}: {
  estimate: FulfilmentEstimate | undefined;
}) {
  const lines = fulfilmentEstimateLines(estimate ?? {});
  if (lines.length === 0) return null;
  return (
    <div className="text-[0.68rem] leading-5" data-fulfilment-estimate>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
