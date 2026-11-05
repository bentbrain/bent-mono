import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { getRequestContext } from 'emdash';
import { ensureLocalIconSchema } from './lib/category-icon-dev';
import {
  imageUnavailable,
  serveResponsiveImage,
} from './lib/serve-responsive-image';
import { serveMapPhoto } from './lib/map-image';
import { publishedMediaAccess } from './lib/published-media-access';

export const onRequest = defineMiddleware(async (context, next) => {
  if (import.meta.env.DEV) await ensureLocalIconSchema(env.DB);
  let path = context.url.pathname;
  for (let depth = 0; depth < 4 && path.includes('%'); depth++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      return path.startsWith('/media-preview/') ||
        path.startsWith('/map-photo/')
        ? imageUnavailable()
        : new Response('Not found', { status: 404 });
    }
  }
  if (path.includes('%'))
    return path.startsWith('/media-preview/') || path.startsWith('/map-photo/')
      ? imageUnavailable()
      : new Response('Not found', { status: 404 });
  if (!import.meta.env.DEV) {
    if (path === '/owner/setup') {
      const key = context.url.searchParams.get('key');
      if (!key || !env.SETUP_TOKEN || key !== env.SETUP_TOKEN)
        return new Response('Not found', { status: 404 });
      context.cookies.set('jp_setup', key, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 900,
      });
      return context.redirect('/_emdash/admin/setup');
    }
    if (
      (path.startsWith('/_emdash/api/setup') ||
        path.startsWith('/_emdash/admin/setup')) &&
      (!env.SETUP_TOKEN ||
        context.cookies.get('jp_setup')?.value !== env.SETUP_TOKEN)
    )
      return new Response('Not found', { status: 404 });
    if (context.locals.user && context.locals.user.email !== env.OWNER_EMAIL)
      return new Response('Owner account required', { status: 403 });
  }
  const owner = Boolean(context.locals.user && context.locals.user.role >= 50);
  const cmsContext = getRequestContext();
  const previewRequest =
    context.url.searchParams.has('_preview') ||
    Boolean(cmsContext?.preview || cmsContext?.editMode);
  // Native preview tokens also affect collection queries on galleries and maps.
  // Require the owner before any route or redirect can render staged content.
  if (previewRequest && !owner) {
    if (context.cache.enabled) context.cache.set(false);
    return new Response('Not found', {
      status: 404,
      headers: {
        'Cache-Control': 'private, no-store',
        'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
      },
    });
  }
  const privateRender =
    previewRequest ||
    (owner && context.cookies.get('emdash-edit-mode')?.value === 'true');
  context.locals.privateMediaRender = privateRender;
  if (path === '/map-photo' || path.startsWith('/map-photo/')) {
    context.cache.set(false);
    return serveMapPhoto(context.request, path, env, privateRender);
  }
  if (path === '/media-preview' || path.startsWith('/media-preview/')) {
    context.cache.set(false);
    return serveResponsiveImage(context.request, path, env, privateRender);
  }
  // Refuse the generic transform endpoint. Only bounded live display previews
  // may be transformed through the dedicated route above.
  if (path === '/_image') return new Response('Not found', { status: 404 });
  if (
    path.startsWith('/_emdash/api/media/file/trip-private/') ||
    (path.startsWith('/_emdash/api/media/file/category-icons/') && !owner)
  )
    return new Response('Not found', { status: 404 });
  const mediaFile = /^\/_emdash\/api\/media\/(file|asset)\/(.+)$/.exec(path);
  if (mediaFile) {
    context.cache.set(false);
    if (!owner) {
      const key = mediaFile[2] || '';
      const allowed = await publishedMediaAccess(
        env.DB,
        mediaFile[1] === 'asset' ? 'asset' : 'file',
        mediaFile[1] === 'asset' ? key.split('/')[0] || '' : key,
      );
      if (!allowed)
        return new Response('Not found', {
          status: 404,
          headers: { 'Cache-Control': 'private, no-store' },
        });
    }
  }
  const postLifecycle =
    /^\/_emdash\/api\/content\/posts\/([^/]+)(\/unpublish)?\/?$/.exec(path);
  const postAction = Boolean(
    postLifecycle &&
    ((postLifecycle[2] && context.request.method === 'POST') ||
      (!postLifecycle[2] && context.request.method === 'DELETE')),
  );
  const ownerRoute =
    path === '/categories' ||
    path.startsWith('/categories/') ||
    path.startsWith('/owner') ||
    path.startsWith('/api/trip') ||
    postAction;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method);
  const management =
    /^\/_emdash\/api\/(admin\/users|users|invites|auth\/(invite|signup)|settings\/signup)(?:\/|$)/.test(
      path,
    );
  if (management) return new Response('Single-owner site', { status: 403 });
  if (ownerRoute) {
    const user = context.locals.user;
    if (!user || user.role < 50)
      return path.startsWith('/api/') || postAction
        ? Response.json({ error: 'Sign in required' }, { status: 401 })
        : context.redirect('/_emdash/admin/login?redirect=/owner');
    if (
      mutation &&
      (context.request.headers.get('X-EmDash-Request') !== '1' ||
        context.request.headers.get('Origin') !== context.url.origin)
    )
      return Response.json({ error: 'Request rejected' }, { status: 403 });
  }
  if (
    postAction &&
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(postLifecycle?.[1] || '')
  )
    return Response.json({ error: 'Post required' }, { status: 400 });
  const publicPosts = path === '/' || path.startsWith('/posts/');
  const newsletterConfirmation = path.startsWith('/newsletter/confirm');
  if (
    (owner ||
      ownerRoute ||
      publicPosts ||
      privateRender ||
      newsletterConfirmation) &&
    context.cache.enabled
  )
    context.cache.set(false);
  const response = await next();
  if (
    owner ||
    ownerRoute ||
    mediaFile ||
    publicPosts ||
    privateRender ||
    newsletterConfirmation
  ) {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('CDN-Cache-Control', 'no-store');
    response.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (newsletterConfirmation)
    response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});
