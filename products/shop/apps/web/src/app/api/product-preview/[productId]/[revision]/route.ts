import { env } from '@/env';

export async function GET(_request: Request, {params}: {params: Promise<{productId:string;revision:string}>}) {
  const {productId,revision}=await params;
  if (![productId,revision].every(value=>/^[a-f0-9-]{36}$/.test(value))) return new Response(null,{status:404});
  try {
    const response=await fetch(new URL(`/v2/internal/configured-products/${productId}/preview/${revision}`,env.FOREVER_TEE_API_URL),{
      cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(8_000),headers:{'x-forever-tee-service-secret':env.FOREVER_TEE_API_SHARED_SECRET},
    });
    const headers=new Headers({'cache-control':'private, no-store','cdn-cache-control':'no-store','x-content-type-options':'nosniff'});
    for(const name of ['content-type','x-product-preview']) {
      const value=response.headers.get(name); if(value) headers.set(name,value);
    }
    return new Response(response.body,{status:response.status,headers});
  } catch {return new Response(null,{status:502,headers:{'cache-control':'no-store'}});}
}
