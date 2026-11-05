type KVNamespace = import('@cloudflare/workers-types').KVNamespace;
type R2Bucket = import('@cloudflare/workers-types').R2Bucket;
type D1Database = import('@cloudflare/workers-types').D1Database;
type ImagesBinding =
  import('./lib/serve-responsive-image').DisplayImagesBinding;

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}

type ExportedHandlerScheduledHandler<
  E = unknown,
  P = unknown,
> = import('@cloudflare/workers-types').ExportedHandlerScheduledHandler<E, P>;
type ExportedHandlerFetchHandler<
  E = unknown,
  M = unknown,
  P = unknown,
> = import('@cloudflare/workers-types').ExportedHandlerFetchHandler<E, M, P>;

declare namespace App {
  interface Locals {
    privateMediaRender?: boolean;
    publishedTripMedia?: import('./lib/model').TripMedia[];
  }
}
