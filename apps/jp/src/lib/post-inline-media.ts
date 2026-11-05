// Post-only assets are registered media, never trip-library content records.
// The original remains under trip-private; only this display JPEG may be shared.
export function isPostInlinePhoto(media: {
  filename: string;
  mimeType: string;
}) {
  return (
    media.mimeType === 'image/jpeg' &&
    /^post-inline-[0-9a-f-]{36}\.jpg$/.test(media.filename)
  );
}
