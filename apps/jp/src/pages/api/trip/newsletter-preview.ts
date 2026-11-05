import type { APIRoute } from 'astro';
import { z } from 'zod';

export const GET: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return new Response('Sign in required', { status: 401 });
  const result = await locals.emdash.handlePluginApiRoute(
    'japan-newsletter',
    'GET',
    'preview',
    request,
    locals.user,
  );
  if (!result.success)
    return new Response('Preview unavailable', { status: 503 });
  const { html } = z.object({ html: z.string() }).parse(result.data);
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' https://jp.bent.build; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    },
  });
};
