export function artworkPreviewUrl(designId: string, revision?: string) {
  const baseUrl = process.env["NEXT_PUBLIC_FOREVER_TEE_API_URL"];
  if (!baseUrl) throw new Error("The bent.shop API URL is unavailable.");
  const url = new URL(
    `/v1/designs/${encodeURIComponent(designId)}/artwork/preview`,
    baseUrl,
  );
  if (revision) url.searchParams.set("revision", revision);
  url.searchParams.set("access", "revocable-v1");
  return url.toString();
}
