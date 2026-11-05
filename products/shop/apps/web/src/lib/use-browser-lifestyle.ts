"use client";
import {useEffect,useState} from 'react';
import {canvasToBlob} from './recursive-image';

export function useBrowserLifestyle(productId:string|undefined,revision:string|undefined,color:string,enabled:boolean) {
  const [preview,setPreview]=useState<{key:string;url:string}>();
  const key=`${productId ?? ""}/${revision ?? ""}/${color}`;
  useEffect(()=>{
    if(!enabled||!productId||!revision)return;
    let active=true;
    const isActive=()=>active;
    let url:string|undefined;
    const canvas=document.createElement('canvas');
    const timer=window.setTimeout(()=>{
    void import('@/client/lifestyle-preview').then(async module=>{
      await module.renderLifestylePreview(canvas,productId,revision,color);
      if(!isActive())return;
      const blob=await canvasToBlob(canvas,{type:'image/webp',quality:.9});
      if(!isActive())return;
      url=URL.createObjectURL(blob);setPreview({key,url});
    }).catch(()=>undefined).finally(()=>{
      canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext();
    });
    },2_000);
    return ()=>{active=false;window.clearTimeout(timer);if(url)URL.revokeObjectURL(url);};
  },[productId,revision,color,enabled,key]);
  return enabled && preview?.key===key ? preview.url : undefined;
}
