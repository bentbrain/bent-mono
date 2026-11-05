import {rotateAroundOrigin,type CameraQuarter} from '@apartment-hotel/scene-engine';
import {baseHeight,productFor,type Item} from './editorState';
import {placementSurfaces} from './surfaces';
export function surfacePosition(item:Item,items:readonly Item[]){
 if(!item.supportId)return null;
 const surface=placementSurfaces(items).find(s=>(s.owner===item.supportId||'fixed/'+s.owner===item.supportId)&&(!item.supportSurface||s.id===item.supportSurface)&&Math.abs(s.height-baseHeight(item))<.002);
 const p=productFor(item.productId);if(!surface||!p)return null;
 const rotation=items.find(i=>i.id===surface.owner)?.rotation??0;
 const inverse:CameraQuarter=rotation===1?3:rotation===3?1:rotation;
 const offset=rotateAroundOrigin({x:item.x-surface.x-surface.w/2,z:item.z-surface.z-surface.d/2},inverse);
 const across=rotation%2?surface.d:surface.w,deep=rotation%2?surface.w:surface.d,turned=(item.rotation+rotation)%2;
 return {surface,rotation,x:offset.x,z:offset.z,maxX:Math.max(0,(across-(turned?(p.baseD??p.d):(p.baseW??p.w)))/2),maxZ:Math.max(0,(deep-(turned?(p.baseW??p.w):(p.baseD??p.d)))/2)};
}
/** Offset in the support's own directions, preserving its exact shelf and height. */
export function slideOnSurface(item:Item,items:readonly Item[],x:number,z:number):Item{
 const support=surfacePosition(item,items);if(!support)return item;
 const offset=rotateAroundOrigin({x,z},support.rotation);
 return {...item,x:support.surface.x+support.surface.w/2+offset.x,z:support.surface.z+support.surface.d/2+offset.z};
}
