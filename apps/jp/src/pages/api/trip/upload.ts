import type { APIRoute } from 'astro';
import { z } from 'zod';
import { extractMetadata } from '../../../lib/metadata';
import { isShortVideoDuration } from '../../../lib/video-duration';

const itemResult = z.object({
  item: z.object({ id: z.string(), storageKey: z.string() }),
});
export const POST: APIRoute = async ({ request, locals }) => {
  const storage = locals.emdash.storage,
    user = locals.user;
  if (!storage || !user)
    return Response.json({ error: 'Storage unavailable' }, { status: 503 });
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 100 * 1024 * 1024)
    return Response.json({ error: 'Upload is too large' }, { status: 413 });
  const form = await request.formData(),
    original = form.get('original'),
    display = form.get('display'),
    poster = form.get('poster'),
    purpose = form.get('purpose');
  if (purpose !== null && purpose !== 'post')
    return Response.json(
      { error: 'Unsupported upload purpose' },
      { status: 400 },
    );
  if (
    !(original instanceof File) ||
    !(display instanceof File) ||
    !(poster instanceof File) ||
    original.size > 64 * 1024 * 1024 ||
    display.size > 32 * 1024 * 1024 ||
    poster.size > 4 * 1024 * 1024
  )
    return Response.json(
      { error: 'Choose a photo or a short video, up to 64 MB' },
      { status: 400 },
    );
  if (
    !['image/jpeg', 'video/mp4'].includes(display.type) ||
    poster.type !== 'image/jpeg'
  )
    return Response.json(
      { error: 'Unsupported preview format' },
      { status: 400 },
    );
  const video = display.type === 'video/mp4';
  if (purpose === 'post' && video)
    return Response.json(
      { error: 'Choose a photo for this post' },
      { status: 400 },
    );
  try {
    const metadata = await extractMetadata(original, video);
    if (
      video &&
      (!('duration' in metadata) || !isShortVideoDuration(metadata.duration))
    )
      return Response.json(
        { error: 'Videos must be 10 seconds or shorter' },
        { status: 400 },
      );
    const id = crypto.randomUUID(),
      originalKey = `trip-private/originals/${id}`;
    await storage.upload({
      key: originalKey,
      body: new Uint8Array(await original.arrayBuffer()),
      contentType: 'application/octet-stream',
    });
    async function upload(file: File, suffix: string) {
      const bytes = new Uint8Array(await file.arrayBuffer()),
        key = `${purpose === 'post' ? 'trip-inline' : 'trip'}/${id}/${suffix}`;
      if (file.type === 'image/jpeg' && (bytes[0] !== 255 || bytes[1] !== 216))
        throw new Error('Invalid image');
      if (file.type === 'video/mp4') await extractMetadata(file, true);
      await storage?.upload({ key, body: bytes, contentType: file.type });
      const result = await locals.emdash.handleMediaCreate({
        filename: suffix,
        mimeType: file.type,
        size: file.size,
        storageKey: key,
        authorId: user?.id,
      });
      if (!result.success) throw new Error('Could not register media');
      const item = itemResult.parse(result.data).item;
      return { id: item.id, url: `/_emdash/api/media/file/${item.storageKey}` };
    }
    const asset = await upload(
      display,
      purpose === 'post'
        ? `post-inline-${id}.jpg`
        : video
          ? 'video.mp4'
          : 'photo.jpg',
    );
    if (purpose === 'post')
      return Response.json(
        {
          asset: {
            ...asset,
            url: `/_emdash/api/media/asset/${asset.id}/post-inline-${id}.jpg`,
          },
          sourceUrl: asset.url,
        },
        { status: 201 },
      );
    const thumbnail = video ? await upload(poster, 'poster.jpg') : asset;
    const result = await locals.emdash.handleContentCreate('media_items', {
      slug: id,
      data: {
        title: original.name,
        kind: video ? 'video' : 'photo',
        asset,
        poster: { id: thumbnail.id, src: thumbnail.url },
        ...metadata,
        place: '',
        categories: [],
        original_key: originalKey,
        source_url: asset.url,
        poster_url: thumbnail.url,
      },
      authorId: user.id,
      actor: { id: user.id, role: user.role },
    });
    return Response.json(result, { status: result.success ? 201 : 400 });
  } catch (error) {
    console.error(
      'Trip upload failed',
      error instanceof Error ? error.name : 'Unknown error',
    );
    return Response.json(
      { error: 'Upload failed. Check the original file and try again.' },
      { status: 400 },
    );
  }
};
