"use client";
import type {BaseProductSlug} from '@forever-tee/contracts/product-projection';
import { useLayoutEffect, useRef } from 'react';
import { previewFrameKey, retainPreviewFrame, restorePreviewFrame } from '@/client/product-preview-frame';
import { renderFlatPreview } from '@/client/product-preview';

export function BrowserProductPreview({productId,revision,color,baseProductSlug,view='flat',onReady}: {
  baseProductSlug?:BaseProductSlug;productId:string;revision:string;color:string;view?:'flat'|'lifestyle';onReady:()=>void;
}) {
  const ref=useRef<HTMLCanvasElement>(null);
  useLayoutEffect(()=>{
    const canvas=ref.current;if(!canvas)return;
    const key=previewFrameKey(productId,revision,color,view);
    if(restorePreviewFrame(key,canvas)) {
      canvas.dataset['previewReady']='true';
      onReady();
      return;
    }
    let active=true;
    const timer=window.setTimeout(()=>{
    const render=view==='flat' ? renderFlatPreview(canvas,productId,revision,color,baseProductSlug) :
      import('@/client/lifestyle-preview').then(module=>module.renderLifestylePreview(canvas,productId,revision,color));
    void render.then(()=>{
      if(!active)return;
      retainPreviewFrame(key,canvas,canvas.width,canvas.height);
      canvas.dataset['previewReady']='true';
      // Readiness means a drawn frame, not a dispatched job or decoded source.
      requestAnimationFrame(()=>{if(active)onReady();});
    }).catch(()=>undefined); // Keep waiting for the authoritative server image if the backup fails.
    },2_000);
    return ()=>{active=false;window.clearTimeout(timer);};
  },[productId,revision,color,view,onReady,baseProductSlug]);
  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 size-full object-contain" data-browser-preview={view} />;
}
