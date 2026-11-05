import { z } from 'zod';

export async function uploadPostPhoto(
  file: File,
  progress: (stage: string) => void,
) {
  const { prepareMedia } = await import('./prepare-media');
  const prepared = await prepareMedia(file, progress);
  const body = new FormData();
  body.set('purpose', 'post');
  body.set('original', file);
  body.set('display', prepared.display);
  body.set('poster', prepared.poster);
  progress('uploading photo');
  const response = await fetch('/api/trip/upload', {
    method: 'POST',
    headers: { 'X-EmDash-Request': '1' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error('Photo upload failed. Paste or choose the photo again.');
  return z
    .object({ asset: z.object({ id: z.string(), url: z.string() }) })
    .parse(await response.json()).asset;
}
