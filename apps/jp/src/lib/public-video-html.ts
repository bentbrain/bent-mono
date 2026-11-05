import type { Response } from '@cloudflare/workers-types';

// Use the native Workers parser and its response types at the runtime boundary.
declare const HTMLRewriter: typeof import('@cloudflare/workers-types').HTMLRewriter;

export function deferPublicVideoMetadata(response: Response): Response {
  if (!response.headers.get('Content-Type')?.startsWith('text/html'))
    return response;
  // Covers native CMS/provider video markup without replacing its renderer.
  // Owner previews and exports omit the public playback marker.
  return new HTMLRewriter()
    .on('body[data-public-video-playback] video', {
      element(video) {
        video.setAttribute('preload', 'none');
      },
    })
    .transform(response);
}
