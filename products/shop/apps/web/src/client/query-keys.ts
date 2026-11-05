export function designQueryKey(designId: string) {
  return ["design", designId];
}

export function artworkPreviewQueryKey(designId: string, revision?: string) {
  const prefix = ["design", designId, "artwork-preview"];
  return revision ? [...prefix, revision] : prefix;
}
