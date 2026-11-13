// Start parses numeric and boolean query values before route validation. The
// validated search must survive its next serialization and navigation intact.
export function launchSearch(search: Record<string, unknown>) {
  return {
    upload: enabled(search["upload"]),
    camera: enabled(search["camera"]),
  };
}
function enabled(value: unknown) {
  return value === "1" || value === 1 || value === true;
}
