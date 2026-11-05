import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  validIconAsset,
  type IconAsset,
} from '../../../../../lib/icon-library';

export const GET: APIRoute = async ({ params }) => {
  const id = params.id || '';
  const file = params.file || '';
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}\.png$/.test(file))
    return new Response('Not found', { status: 404 });
  const asset = await env.DB.prepare(
    'SELECT * FROM jp_icon_assets WHERE storage_key=?',
  )
    .bind(`category-icons/${id}/${file}`)
    .first<IconAsset>();
  const bytes = asset ? await validIconAsset(env, asset) : undefined;
  return bytes
    ? new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
    : new Response('Not found', { status: 404 });
};
