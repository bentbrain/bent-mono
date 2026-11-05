import {useEffect,useRef,type RefObject} from 'react';
import {HOME_VIEW,constrainView,transformGesture,type Point,type ViewTransform} from './navigation';
interface Tap {point:Point;at:number}

export function useSceneNavigation(room:RefObject<HTMLDivElement|null>,canvas:RefObject<HTMLCanvasElement|null>,onInteraction:(active:boolean)=>void,generation=0){
 const retainedView=useRef<ViewTransform>({...HOME_VIEW});
 useEffect(()=>{
  const area=room.current,image=canvas.current;if(!area||!image)return;
  let view:ViewTransform={...retainedView.current},origin=view,starting:Point[]=[],frame=0;
  let tap:Tap|null=null,lastTap:Tap|null=null;
  const pointers=new Map<number,Point>();
  const size=()=>({width:image.clientWidth,height:image.clientHeight});
  const point=(event:PointerEvent):Point=>{const rect=area.getBoundingClientRect();return{x:event.clientX-rect.left-rect.width/2,y:event.clientY-rect.top-rect.height/2};};
  const paint=()=>{frame=0;image.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.scale})`;area.dataset.zoom=view.scale.toFixed(2);};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(paint);};
  const rebase=()=>{origin=view;starting=[...pointers.values()].slice(0,2);};
  const down=(event:PointerEvent)=>{
   if(event.pointerType!=='touch')return;
   if(pointers.size===0)onInteraction(true);
   const position=point(event);
   tap=pointers.size===0?{point:position,at:performance.now()}:null;
   if(pointers.size>0)lastTap=null;
   area.setPointerCapture(event.pointerId);pointers.set(event.pointerId,position);rebase();
  };
  const move=(event:PointerEvent)=>{
   if(!pointers.has(event.pointerId))return;
   const position=point(event);
   if(tap&&Math.hypot(position.x-tap.point.x,position.y-tap.point.y)>8){tap=null;lastTap=null;}
   pointers.set(event.pointerId,position);view=transformGesture(origin,starting,[...pointers.values()].slice(0,2),size());schedule();
  };
  const end=(event:PointerEvent)=>{
   if(!pointers.delete(event.pointerId))return;
   const now=performance.now();
   if(event.type==='pointerup'&&tap&&now-tap.at<250){
    if(lastTap&&now-lastTap.at<350&&Math.hypot(tap.point.x-lastTap.point.x,tap.point.y-lastTap.point.y)<30){view={...HOME_VIEW};lastTap=null;schedule();}
    else lastTap={point:tap.point,at:now};
   }
   tap=null;rebase();if(pointers.size===0)onInteraction(false);
  };
  const resize=new ResizeObserver(()=>{if(pointers.size>0)onInteraction(false);view=constrainView(view,size());pointers.clear();tap=null;lastTap=null;rebase();schedule();});
  resize.observe(area);resize.observe(image);
  area.addEventListener('pointerdown',down);area.addEventListener('pointermove',move);
  area.addEventListener('pointerup',end);area.addEventListener('pointercancel',end);area.addEventListener('lostpointercapture',end);
  return()=>{
   retainedView.current=view;resize.disconnect();cancelAnimationFrame(frame);onInteraction(false);
   area.removeEventListener('pointerdown',down);area.removeEventListener('pointermove',move);
   area.removeEventListener('pointerup',end);area.removeEventListener('pointercancel',end);area.removeEventListener('lostpointercapture',end);
  };
 },[room,canvas,onInteraction,generation]);
}
