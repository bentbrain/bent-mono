import {rotateAroundOrigin} from '@apartment-hotel/scene-engine';
import type {Item,Product} from './editorState';
import type {Rect} from './plan';
export interface Surface extends Rect {id:string;owner:string;height:number;use:'seat'|'top';clearance?:number;round?:boolean}
export const FIXED_SURFACES:readonly Surface[]=[
  {id:'counter-work',owner:'dishwasher',x:.10,z:3.93,w:.5,d:.54,height:.91,use:'top'},
  {id:'counter-end',owner:'bench',x:.10,z:5.13,w:.5,d:.54,height:.91,use:'top'},
  {id:'counter-drainer',owner:'sink',x:.10,z:2.73,w:.5,d:.23,height:.914,use:'top'},
  {id:'upper-top',owner:'overheads',x:.08,z:3.23,w:.28,d:2.44,height:2.3,use:'top'},
  {id:'toilet-seat',owner:'toilet',x:7.45,z:4.98,w:.32,d:.34,height:.512,use:'seat'},
  {id:'robe-top',owner:'robe',x:4.85,z:.06,w:.49,d:2.52,height:2.4,use:'top'},
];
function transformRect(r:Rect,item:Item):Rect {
 const corners=[{x:r.x,z:r.z},{x:r.x+r.w,z:r.z},{x:r.x,z:r.z+r.d},{x:r.x+r.w,z:r.z+r.d}].map(p=>rotateAroundOrigin(p,item.rotation));
 const xs=corners.map(p=>p.x+item.x),zs=corners.map(p=>p.z+item.z);
 return{x:Math.min(...xs),z:Math.min(...zs),w:Math.max(...xs)-Math.min(...xs),d:Math.max(...zs)-Math.min(...zs)};
}

/** The same support surfaces can be used for placing small objects in a 3D editor. */
export function furnitureSurfaces(item:Item,p:Product):Surface[]{
 if(p.baseModel){const {baseModel,...base}=p;return furnitureSurfaces({...item,productId:baseModel},base);}
 const surfaces:Surface[]=[];

 {
  if(p.supportHeight===undefined)return [];
  let r:Rect={x:-p.w/2+.03,z:-p.d/2+.03,w:p.w-.06,d:p.d-.06},height=p.supportHeight,use:Surface['use']='top';
  if(item.productId==='dyvlinge'){r={x:-.22,z:-.11,w:.44,d:.39};height=.43;use='seat';}
  if(item.productId==='sofa'){r={x:-.79,z:-.20,w:1.58,d:.56};height=.59;use='seat';}
  if(item.productId==='kirribilli'){r={x:-.71,z:-.86,w:1.42,d:1.84};height=.64;use='seat';}
  if(item.productId==='perjohan'){r={x:-.46,z:-.115,w:.92,d:.23};height=.45;use='seat';}
  if(item.productId==='fireside'){r={x:-.83,z:-.04,w:1.66,d:.39};height=.36;use='seat';}
  if(item.productId==='casalino'){r={x:-.22,z:-.12,w:.44,d:.33};height=item.seatPad?.46:.436;use='seat';}
  if(item.productId==='numero-high'||item.productId==='numero-low'){r={x:-.29,z:-.02,w:.58,d:.32};height=.33;use='seat';}
  if(item.productId==='byakorre'){
   for(const [index,level] of [.30,.66,1.025,1.39].entries())surfaces.push({...transformRect(r,item),id:`${item.id}-shelf-${index}`,owner:item.id,height:(item.elevation??p.defaultElevation??0)+level,use:'top',...(index<3?{clearance:.335}:{})});
  }else surfaces.push({...transformRect(r,item),id:`${item.id}-support`,owner:item.id,round:p.supportShape==='round',height:(item.elevation??p.defaultElevation??0)+height,use});
 }
 return surfaces;
}

export function fitsSupport(item:Item,p:Product,s:Surface):boolean{
 const w=item.rotation%2?(p.baseD??p.d):(p.baseW??p.w),d=item.rotation%2?(p.baseW??p.w):(p.baseD??p.d);
 if(p.h>(s.clearance??Infinity)+.001)return false;
 if(s.round&&p.contactShape==='round')return Math.hypot(item.x-s.x-s.w/2,item.z-s.z-s.d/2)+Math.max(w,d)/2<=Math.min(s.w,s.d)/2+.001;
 for(const x of [item.x-w/2,item.x+w/2])for(const z of [item.z-d/2,item.z+d/2]){
  if(s.round){if(((x-s.x-s.w/2)/(s.w/2))**2+((z-s.z-s.d/2)/(s.d/2))**2>1.002)return false;}
  else if(x<s.x-.001||x>s.x+s.w+.001||z<s.z-.001||z>s.z+s.d+.001)return false;
 }
 return true;
}
