import type { CameraQuarter } from '@apartment-hotel/scene-engine';
import { FIXED_FITTINGS }  from './fixedFittings';
import { WALLS,ENTRY_RACK_Z, type Rect, type Point, fitsRoom, overlap } from './plan';
import {footprintsOverlap} from './footprints';
import {FIXED_SURFACES,furnitureSurfaces,fitsSupport} from './supportGeometry';
import audited from '../data/furniture-audit.json';
import bedding from '../data/bedding.json';
import photoObjects from '../data/photo-objects.json';
export const BEDDING=bedding;
export interface Finish {id:string;name:string;color:string}
export interface Product { id:string; baseModel?:string; name:string; detail:string; w:number; d:number; h:number; category:'Furniture'|'Lighting'|'Devices'; source:string; purchased:boolean; approximate?:boolean; url?:string; note?:string; placement?:string; defaultElevation?:number; supportHeight?:number; finishes?:readonly Finish[]; emitter?:number; supportShape?:string; contactShape?:string; baseW?:number; baseD?:number }
export const CATALOG:readonly Product[]=[
 ...photoObjects.map((p):Product=>({defaultElevation:0,placement:'floor',detail:'Scene model',source:'Scene model',purchased:false,approximate:true,...p,finishes:audited.find(a=>a.id===p.baseModel)?.finishes??p.finishes??[],category:p.category==='Lighting'?'Lighting':'Furniture'})),
 ...audited.map((p):Product=>({detail:'Scene model',source:'Scene model',purchased:false,...p,category:p.category==='Lighting'?'Lighting':'Furniture'})),
 {id:'vacuum',name:'Robot vacuum',detail:'Ecovacs · Approximate robot shape',w:.4,d:.4,h:.2,category:'Devices',purchased:false,source:'Home Assistant · model identity unconfirmed',approximate:true},
 {id:'okensand',name:'ÖKENSAND',detail:'IKEA · Beech / white · 3 E14 bulbs',w:.48,d:.48,h:1.54,category:'Lighting',purchased:false,source:'Scene model'},
 {id:'sofa',name:'Two-seat sofa',detail:'Generic · Editable placeholder',w:2.1,d:.9,h:.94,category:'Furniture',purchased:false,source:'Generic model, not a confirmed purchase',approximate:true,supportHeight:.59},
 {id:'table',name:'Dining table',detail:'Generic · Oak',w:1.3,d:.8,h:.77,category:'Furniture',purchased:false,source:'Generic model, not a confirmed purchase',approximate:true,supportHeight:.77},
];
export interface Item {id:string;productId:string;x:number;z:number;rotation:CameraQuarter;entityId:string;elevation?:number;finish?:string;materialColor?:string;materialGloss?:number;supportId?:string;seatPad?:boolean;bedding?:string;supportSurface?:string}
export function productFor(id:string):Product|undefined{return CATALOG.find(p=>p.id===id);}
export function bounds(item:Item):Rect {const p=productFor(item.productId);const w=p?.w??.5,d=p?.d??.5;return {x:item.x-(item.rotation%2?d:w)/2,z:item.z-(item.rotation%2?w:d)/2,w:item.rotation%2?d:w,d:item.rotation%2?w:d};}
export function overlapsFitting(item:Item):boolean{
 const heights:Record<string,number>={fridge:2.7,pantry:2.7,sink:.91,dishwasher:.91,oven:.97,bench:.91,vanity:.89,toilet:.86,shower:2.7};
 return FIXED_FITTINGS.some(f=>f.blocksFloor&&baseHeight(item)<(heights[f.id]??1)-.002&&overlap(bounds(item),f.footprint));
}
export function withSupport(item:Item,supportId?:string):Item{const copy={...item};if(supportId)copy.supportId=supportId;else{delete copy.supportId;delete copy.supportSurface;}return copy;}
export function baseHeight(item:Item):number{return item.elevation??productFor(item.productId)?.defaultElevation??0;}
export function nesting(item:Item,other:Item):boolean{return item.productId.startsWith('stoppino-')&&other.productId.startsWith('stoppino-')&&item.productId!==other.productId&&item.rotation===other.rotation&&Math.hypot(item.x-other.x,item.z-other.z)<.002&&baseHeight(item)===0&&baseHeight(other)===0;}
export function collides(item:Item,other:Item):boolean{
 if(item.id===other.id||nesting(item,other)||!overlap(bounds(item),bounds(other)))return false;
 if((item.supportId===other.id&&supported(item,[other]))||(other.supportId===item.id&&supported(other,[item])))return false;
 const p=productFor(item.productId),q=productFor(other.productId);
 if(p&&q&&!footprintsOverlap(item,p,other,q))return false;
 if((p?.placement==='rug')!==(q?.placement==='rug'))return false;
 return baseHeight(item)<baseHeight(other)+(q?.h??1)-.002&&baseHeight(other)<baseHeight(item)+(p?.h??1)-.002;
}
function supported(item:Item,items:readonly Item[]):boolean{
 if(!item.supportId)return true;const p=productFor(item.productId);if(!p)return false;
 const parent=items.find(i=>i.id===item.supportId),product=parent?productFor(parent.productId):undefined;
 const surfaces=parent&&product?furnitureSurfaces(parent,product):FIXED_SURFACES.filter(s=>'fixed/'+s.owner===item.supportId);
 return surfaces.some(s=>(!item.supportSurface||s.id===item.supportSurface)&&Math.abs(baseHeight(item)-s.height)<.002&&fitsSupport(item,p,s));
}
export function placeable(item:Item,items:readonly Item[],checkFittings=true):boolean{
 const p=productFor(item.productId),height=baseHeight(item);
 if(p?.placement==='entry-door')return height>=1.2&&height+p.h<=2.5&&item.rotation===2&&Math.abs(item.z-ENTRY_RACK_Z)<.002&&item.x-p.w/2>=3.65&&item.x+p.w/2<=4.6&&!items.some(i=>collides(item,i));
 return supported(item,items)&&Number.isFinite(item.x)&&Number.isFinite(item.z)&&Number.isFinite(height)&&height>=0&&height+(p?.h??0)<=2.7&&(!checkFittings||!overlapsFitting(item))&&fitsRoom(bounds(item))&&!items.some(i=>collides(item,i));
}
/** Carry objects resting on a moved piece, retaining their individual identities. */
export function moveItem(items:readonly Item[],next:Item):Item[]{
 const before=items.find(i=>i.id===next.id);if(!before)return [...items,next];
 const dx=next.x-before.x,dz=next.z-before.z,dh=baseHeight(next)-baseHeight(before),turn=(next.rotation-before.rotation+4)%4;
 const moved=new Set([next.id]);let result=items.map(i=>i.id===next.id?next:i);
 for(let depth=0;depth<items.length;depth++){
  const children=result.filter(i=>i.supportId&&moved.has(i.supportId)&&!moved.has(i.id));if(!children.length)break;
  for(const child of children){const x=child.x-before.x,z=child.z-before.z,t=turn*Math.PI/2;const rotation=(child.rotation+turn)%4;const changed:Item={...child,x:before.x+dx+x*Math.cos(t)-z*Math.sin(t),z:before.z+dz+x*Math.sin(t)+z*Math.cos(t),elevation:baseHeight(child)+dh,rotation:rotation===1?1:rotation===2?2:rotation===3?3:0};result=result.map(i=>i.id===child.id?changed:i);moved.add(child.id);}
 }
 return result;
}
export function wallPosition(item:Item):Item{
 if(productFor(item.productId)?.placement==='entry-door')return {...item,x:Math.max(3.91,Math.min(4.34,item.x)),z:ENTRY_RACK_Z,rotation:2};
 if(productFor(item.productId)?.placement!=='wall')return item;
 const depth=productFor(item.productId)?.d??.03;let best=item,distance=Infinity;
 for(const wall of WALLS.filter(w=>w.kind==='outer'||w.kind==='inner')){
  const vertical=wall.a.x===wall.b.x;
  for(const side of [-1,1]){
   const face=(vertical?wall.a.x:wall.a.z)+(vertical?wall.normal.x:wall.normal.z)*.06+side*(.06+.004+depth/2);
   const low=vertical?Math.min(wall.a.z,wall.b.z):Math.min(wall.a.x,wall.b.x),high=vertical?Math.max(wall.a.z,wall.b.z):Math.max(wall.a.x,wall.b.x);
   const half=(productFor(item.productId)?.w??1)/2;
   if(high-low<half*2)continue;
   const along=Math.max(low+half,Math.min(high-half,vertical?item.z:item.x));
   const candidate:Item={...item,x:vertical?face:along,z:vertical?along:face,rotation:vertical?(side===1?3:1):(side===1?0:2)};
   if(!fitsRoom(bounds(candidate)))continue;
   const d=Math.hypot(candidate.x-item.x,candidate.z-item.z);if(d<distance){distance=d;best=candidate;}
  }
 }
 return best;
}
export function snap(p:Point):Point{return{x:Math.round(p.x*20)/20,z:Math.round(p.z*20)/20};}
export function parseItems(raw:string,stored=false):Item[]{
 const data:unknown=JSON.parse(raw);if(!Array.isArray(data)||data.length>200)throw Error('Choose an Apartment Hotel layout with at most 200 items.');
 const items:Item[]=[];
 for(const value of data){const v:unknown=value;if(typeof v!=='object'||v===null||!('id'in v)||typeof v.id!=='string'||!('productId'in v)||typeof v.productId!=='string'||!productFor(v.productId)||!('x'in v)||typeof v.x!=='number'||!Number.isFinite(v.x)||!('z'in v)||typeof v.z!=='number'||!Number.isFinite(v.z)||!('rotation'in v)||(v.rotation!==0&&v.rotation!==1&&v.rotation!==2&&v.rotation!==3)||!('entityId'in v)||typeof v.entityId!=='string')throw Error('This layout has an invalid item.');
 const item:Item={id:v.id,productId:v.productId,x:v.x,z:v.z,rotation:v.rotation,entityId:v.entityId};
 if(productFor(item.productId)?.placement==='entry-door'&&Math.abs(item.z-6.98)<.002)item.z=ENTRY_RACK_Z;
 if('elevation'in v){if(typeof v.elevation!=='number'||!Number.isFinite(v.elevation)||v.elevation<0||v.elevation>2.7)throw Error('Invalid mounting height.');item.elevation=v.elevation;}
 if('finish'in v){if(typeof v.finish!=='string'||!productFor(v.productId)?.finishes?.some(f=>f.id===v.finish)&&!(['era300','era300-stand','arc-ultra','sub4'].includes(v.productId)&&v.finish==='black'))throw Error('Invalid material finish.');item.finish=['era300','era300-stand','arc-ultra','sub4'].includes(v.productId)?'white':v.finish;}
 if('bedding'in v){if(v.productId!=='kirribilli'||typeof v.bedding!=='string'||!BEDDING.some(b=>b.id===v.bedding))throw Error('Invalid bedding set.');item.bedding=v.bedding;}
 if('materialColor'in v){if(typeof v.materialColor!=='string'||!/^#[0-9a-fA-F]{6}$/.test(v.materialColor))throw Error('Invalid material colour.');item.materialColor=v.materialColor.toLowerCase();}
 if('materialGloss'in v){if(typeof v.materialGloss!=='number'||!Number.isFinite(v.materialGloss)||v.materialGloss<0||v.materialGloss>1)throw Error('Invalid material gloss.');item.materialGloss=v.materialGloss;}
 if('seatPad'in v){if(typeof v.seatPad!=='boolean')throw Error('Invalid seat pad option.');item.seatPad=v.seatPad;}
 if('supportSurface'in v){if(typeof v.supportSurface!=='string')throw Error('Invalid support surface.');item.supportSurface=v.supportSurface;}
 if('supportId'in v){if(typeof v.supportId!=='string')throw Error('Invalid support.');item.supportId=v.supportId;}
 if(items.some(i=>i.id===item.id))throw Error('This layout overlaps a wall, door or another item.');items.push(item);
 }
 // Older Stoppino placements used the rim height; their supported objects follow the recessed top.
 for(const item of items){const parent=items.find(i=>i.id===item.supportId),p=parent?productFor(parent.productId):undefined;if(parent&&p?.id.startsWith('stoppino-')&&p.supportHeight!==undefined&&Math.abs(baseHeight(item)-baseHeight(parent)-p.h)<.002)item.elevation=baseHeight(parent)+p.supportHeight;}
 for(const item of items){if(!stored&&!placeable(item,items,false))throw Error('This layout overlaps a wall, door or another item, or does not fit its support.');const seen=new Set([item.id]);let id=item.supportId;while(id){if(id.startsWith('fixed/')&&FIXED_SURFACES.some(s=>'fixed/'+s.owner===id))break;const parent=items.find(i=>i.id===id);if(!parent||seen.has(id))throw Error('Invalid support relationship.');seen.add(id);id=parent.supportId;}}
 return items;
}
