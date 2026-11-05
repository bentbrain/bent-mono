import type {CameraQuarter} from '@apartment-hotel/scene-engine';
import {baseHeight,productFor,snap,wallPosition,withSupport,type Item} from './editorState';
import {placementSurfaces} from './surfaces';
import {fitsSupport,type Surface} from './supportGeometry';
import {inside,type Point} from './plan';
import {project,projectPlan,unproject,unprojectPlan} from './scene';
/** Keep the grabbed point under the pointer when dragging tall objects or edges. */
export function placementPointerOffset(item:Item,pixel:{x:number;y:number},q:CameraQuarter,plan=false):{x:number;y:number}{
 const product=productFor(item.productId);
 const height=product?.placement==='small'?baseHeight(item):product?.placement==='wall'||product?.placement==='entry-door'?baseHeight(item)+product.h/2:0;
 const anchor=plan?projectPlan(item):project(item,q,height);
 return {x:pixel.x-anchor.x,y:pixel.y-anchor.y};
}
export function onSurface(item:Item,surface:Surface):Item{
 return {...item,x:surface.x+surface.w/2,z:surface.z+surface.d/2,elevation:surface.height,supportId:surface.owner==='dishwasher'||surface.owner==='bench'||surface.owner==='sink'||surface.owner==='overheads'||surface.owner==='toilet'||surface.owner==='robe'?'fixed/'+surface.owner:surface.owner,supportSurface:surface.id};
}
/** Project the click onto each real support height instead of always onto the floor. */
export function placementAt(item:Item,pixel:{x:number;y:number},q:CameraQuarter,items:readonly Item[],plan=false,wallPoint?:Point,surfaceHit?:{owner:string;height:number}|null):Item{
 const product=productFor(item.productId),floor=plan?unprojectPlan(pixel):unproject(pixel,q);
 if(product?.placement==='small'){
  for(const surface of [...placementSurfaces(items)].sort((a,b)=>Number(items.some(i=>i.id===b.owner))-Number(items.some(i=>i.id===a.owner))||b.height-a.height)){
   if(surfaceHit===null)continue;
   if(surfaceHit&&((surfaceHit.owner!==surface.owner&&!(surfaceHit.owner==='kitchen-run'&&['dishwasher','bench','sink'].includes(surface.owner)))||Math.abs(surfaceHit.height-surface.height)>.04))continue;
   if(surface.owner===item.id)continue;
   const point=plan?floor:unproject({x:pixel.x,y:pixel.y+surface.height*60.72},q);
   if(!inside(point,surface))continue;
   const candidate={...onSurface(item,surface),...point};
   return fitsSupport(candidate,product,surface)?candidate:onSurface(item,surface);
  }
 }
 if(product?.placement==='wall'||product?.placement==='entry-door'){
  const point=wallPoint??(plan?floor:unproject({x:pixel.x,y:pixel.y+(baseHeight(item)+product.h/2)*60.72},q));
  return wallPosition({...withSupport(item),...snap(point)});
 }
 return {...withSupport(item),...snap(floor),...(product?.placement==='small'?{elevation:0}:{})};
}
