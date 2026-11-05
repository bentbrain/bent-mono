import type { APIRoute } from 'astro';
export const POST: APIRoute = async ({ request, locals }) => {
  const isCancelled = () => request.signal.aborted;
  const form = await request.formData().catch(() => undefined);
  if (!form)
    return Response.json({ error: 'Incomplete export' }, { status: 400 });
  const file = form.get('file'),
    storage = locals.emdash.storage;
  if (
    !(file instanceof File) ||
    !storage ||
    !['image/png', 'video/mp4'].includes(file.type) ||
    file.size > 32 * 1024 * 1024
  )
    return Response.json({ error: 'Invalid export' }, { status: 400 });
  if (isCancelled()) return new Response(null, { status: 499 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isCancelled()) return new Response(null, { status: 499 });
  const id = crypto.randomUUID(),
    extension = file.type === 'image/png' ? 'png' : 'mp4';
  await storage.upload({
    key: `trip-private/exports/${id}.${extension}`,
    body: bytes,
    contentType: file.type,
  });
  if (isCancelled()) {
    await storage.delete(`trip-private/exports/${id}.${extension}`);
    return new Response(null, { status: 499 });
  }
  return Response.json({ url: `/api/trip/exports/${id}.${extension}` });
};
