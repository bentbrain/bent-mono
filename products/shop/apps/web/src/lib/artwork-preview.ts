export function artworkPreviewUrl(designId: string, revision?: string) {
  const path = `/api/design-drafts/${encodeURIComponent(designId)}/artwork/preview`;
  return revision ? `${path}?${new URLSearchParams({ revision })}` : path;
}
