// Keep nominal ten-second captures intact when their frame timing runs slightly over.
const maximumDuration = 10.2;

export function isShortVideoDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= maximumDuration
  );
}
