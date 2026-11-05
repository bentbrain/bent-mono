import type { APIRoute } from 'astro';
export const GET: APIRoute = async ({ params, locals }) => {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}\.(png|mp4)$/.test(id))
    return new Response('Not found', { status: 404 });
  try {
    const file = await locals.emdash.storage?.download(
      `trip-private/exports/${id}`,
    );
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(file.body, {
      headers: {
        'Content-Type': id.endsWith('.mp4') ? 'video/mp4' : 'image/png',
        'Content-Disposition': `attachment; filename="japan-story-${id}"`,
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};
