import { env } from "@/env";

export async function GET(_request:Request,context:{params:Promise<{designId:string;revision:string;color:string}>}) {
  const {designId,revision,color}=await context.params;
  if(!/^[a-f0-9-]{36}$/.test(designId) || !/^[a-f0-9-]{36,64}$/.test(revision) || !/^(black|white)\.webp$/.test(color)) return new Response(null,{status:404});
  const response=await fetch(new URL(`/v2/internal/designs/${designId}/images/${revision}/${color.replace(".webp","")}`,env.FOREVER_TEE_API_URL),
    {cache:"no-store",redirect:"manual",headers:{"x-forever-tee-service-secret":env.FOREVER_TEE_API_SHARED_SECRET}});
  const headers=new Headers({"cache-control":"private, no-store","cdn-cache-control":"no-store","x-content-type-options":"nosniff"});
  for(const name of ["content-type","content-length","etag","retry-after"]) {const value=response.headers.get(name);if(value) headers.set(name,value);}
  return new Response(response.body,{status:response.status,headers});
}
