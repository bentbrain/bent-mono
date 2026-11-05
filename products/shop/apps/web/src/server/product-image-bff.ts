import "server-only";
import { env } from "@/env";

export async function storedProductImageResponse({productId,color,view="flat",revision,width=1500,method="GET"}: {
  productId:string; color:string; view?:"flat"|"lifestyle"; revision?:string; width?:number; method?:string;
}) {
  if (!/^[a-f0-9-]{36}$/.test(productId) || !/^(black|white|cream)\.(webp|png)$/.test(color) ||
    ![192,384,768,960,1200,1500].includes(width) || (revision !== undefined && !/^[a-f0-9-]{36}$/.test(revision))) return new Response(null,{status:404});
  const [colour,format] = color.split(".");
  if(!colour) return new Response(null,{status:404});
  const upstream = new URL(`/v2/internal/configured-products/${productId}/images/${view}/${colour}`,env.FOREVER_TEE_API_URL);
  upstream.searchParams.set("width",String(width)); upstream.searchParams.set("format",format ?? "webp");
  if(revision) upstream.searchParams.set("revision",revision);
  try {
    // The Worker may fulfil the first GET within a bounded two-second wait.
    // Longer jobs keep the existing client polling and late-result recovery.
    const started=performance.now();
    const response=await fetch(upstream,{method,cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(8_000),
        headers:{"x-forever-tee-service-secret":env.FOREVER_TEE_API_SHARED_SECRET}});
    const headers=new Headers({"cache-control":"private, no-store","cdn-cache-control":"no-store","x-content-type-options":"nosniff"});
    for(const name of ["content-type","content-length","etag","retry-after","server-timing"]) {
      const value=response.headers.get(name); if(value) headers.set(name,value);
    }
    headers.append("server-timing",`image-bff;dur=${(performance.now()-started).toFixed(1)}`);
    return new Response(method==="HEAD" ? null : response.body,{status:response.status,headers});
  } catch {return new Response(null,{status:502,headers:{"cache-control":"no-store"}});}
}
