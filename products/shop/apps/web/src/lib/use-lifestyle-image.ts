"use client";
import { useQuery } from "@tanstack/react-query";

export function useLifestyleImage(productId:string|undefined,color:string,enabled:boolean) {
  const url=`/api/configured-product-lifestyle/${encodeURIComponent(productId ?? "")}/${encodeURIComponent(color.toLowerCase())}.webp`;
  return useQuery({
    queryKey:["lifestyle-image",productId,color.toLowerCase()],enabled:enabled && Boolean(productId),
    queryFn:async({signal})=>{
      const response=await fetch(url,{method:"HEAD",cache:"no-store",signal});
      if(response.status===202) return {status:"pending"};
      if(response.status>=500) throw new Error("Product image unavailable.");
      if(!response.ok) return {status:"unavailable"};
      return {status:"ready",url};
    },
    staleTime:60_000,gcTime:300_000,retry:2,
    refetchInterval:query=>query.state.data?.status==="pending" ? (query.state.dataUpdateCount<10 ? 500 : 2000) : query.state.status==="error" ? 15_000 : false,
  });
}
