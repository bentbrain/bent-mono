import {rotateAroundOrigin} from '@apartment-hotel/scene-engine';
import {FIXED_SURFACES,furnitureSurfaces,type Surface} from './supportGeometry';
export type {Surface} from './supportGeometry';
import {baseHeight,bounds,productFor,type Item} from './editorState';
import {FIXED_FITTINGS} from './fixedFittings';
import {fitsRoom,inside,onFloor,overlap,wallBounds,WALLS,ZONES,type Point,type Rect} from './plan';

export interface Volume extends Rect {owner:string;bottom:number;top:number}
export interface Landing extends Point {id:string;height:number;owner:string;surface:string;softFloor?:boolean;clearance?:number}
export interface PetGraph {nodes:Map<string,Landing>;edges:Map<string,string[]>;surfaces:readonly Surface[];volumes:readonly Volume[]}
// Keep cats below tall shelf and cupboard tops, including indirect jumps.
const MAX_CAT_SURFACE_HEIGHT=1.25;
const PAW=.075,BODY=.29;
// The reviewed cat is 78 cm nose-to-tail; turning must also clear the wall.
export const CAT_WALL_RADIUS=.42;

export function placementSurfaces(items:readonly Item[],fittings=true):Surface[]{return [...(fittings?FIXED_SURFACES:[]),...items.flatMap(item=>{const p=productFor(item.productId);return p?furnitureSurfaces(item,p):[];})];}

function transformRect(r:Rect,item:Item):Rect {
 const corners=[{x:r.x,z:r.z},{x:r.x+r.w,z:r.z},{x:r.x,z:r.z+r.d},{x:r.x+r.w,z:r.z+r.d}].map(p=>rotateAroundOrigin(p,item.rotation));
 const xs=corners.map(p=>p.x+item.x),zs=corners.map(p=>p.z+item.z);
 return{x:Math.min(...xs),z:Math.min(...zs),w:Math.max(...xs)-Math.min(...xs),d:Math.max(...zs)-Math.min(...zs)};
}


function volumesFor(items:readonly Item[]):Volume[]{
 const heights:Record<string,number>={shower:2.7,fridge:2.7,pantry:2.7,robe:2.4,sink:.91,dishwasher:.91,oven:.97,bench:.91,vanity:.89,toilet:.86,'laundry-basin':.90};
 const volumes:Volume[]=FIXED_FITTINGS.filter(f=>f.blocksFloor&&f.id!=='toilet').map(f=>({...f.footprint,owner:f.id,bottom:0,top:heights[f.id]??1}));
 volumes.push({owner:'overheads',x:.06,z:3.2,w:.34,d:2.5,bottom:1.55,top:2.3},{owner:'robe',x:4.8,z:0,w:.6,d:2.65,bottom:0,top:2.4},{owner:'shower-screen',x:8.11,z:4.775,w:.02,d:.77,bottom:0,top:2.12});
 volumes.push({owner:'toilet',x:7.41,z:4.91,w:.4,d:.68,bottom:0,top:.512},{owner:'toilet',x:7.415,z:5.36,w:.39,d:.20,bottom:.5,top:.86});
 for(const item of items){
  if(productFor(item.productId)?.placement==='rug')continue;
  const add=(r:Rect,top:number,bottom=0)=>volumes.push({...transformRect(r,item),owner:item.id,bottom:baseHeight(item)+bottom,top:baseHeight(item)+top});
  if(item.productId==='kirribilli'){
   add({x:-.78,z:-1.06,w:1.56,d:2.12},.64);add({x:-.78,z:-1.045,w:1.56,d:.09},.96);
  }else if(item.productId==='sofa'){
   add({x:-1.05,z:-.45,w:2.1,d:.9},.59);add({x:-1.05,z:-.45,w:2.1,d:.18},.94);
   for(const x of [-1.07,.85])add({x,z:-.425,w:.22,d:.85},.74);
  }else if(item.productId==='dyvlinge'||item.productId==='dyvlinge-dressed'){
   add({x:-.315,z:-.375,w:.63,d:.75},.43);add({x:-.315,z:-.35,w:.63,d:.18},.71);
  }else if(item.productId==='byakorre'){
   for(const level of [.30,.66,1.025,1.39])add({x:-.85,z:-.16,w:1.7,d:.32},level,level-.018);
   for(const x of [-.40,.38])for(const z of [-.15,.13])add({x,z,w:.02,d:.02},1.57);
  }else if(item.productId==='fireside'||item.productId==='fireside-dressed'){
   add({x:-.9,z:-.5,w:1.8,d:1},.36);add({x:-.9,z:-.5,w:1.8,d:.28},.7);
  }else if(item.productId==='casalino'){
   add({x:-.285,z:-.31,w:.57,d:.62},.43);add({x:-.285,z:-.31,w:.57,d:.16},.72);
  }else volumes.push({...bounds(item),owner:item.id,bottom:baseHeight(item),top:baseHeight(item)+(productFor(item.productId)?.h??1)});
 }

 return volumes;
}
function bodyClear(p:Point,height:number,volumes:readonly Volume[],support=''):boolean{
 const r={x:p.x-PAW,z:p.z-PAW,w:PAW*2,d:PAW*2};
 return !volumes.some(v=>v.owner!==support&&height<v.top-.018&&height+BODY>v.bottom+.01&&overlap(r,v));
}
function wallClear(p:Point,height:number):boolean{
 return !WALLS.some(w=>{
  const top=w.kind==='robe'?2.4:w.kind==='rail'?1.05:2.7;if(height>=top+.02)return false;
  return overlap({x:p.x-CAT_WALL_RADIUS,z:p.z-CAT_WALL_RADIUS,w:CAT_WALL_RADIUS*2,d:CAT_WALL_RADIUS*2},wallBounds(w));
 });
}
export function flightPoint(a:Landing,b:Landing,t:number):Point&{height:number}{
 const travel=t*t*(3-2*t);
 let height=a.height+(b.height-a.height)*t+Math.sin(Math.PI*t)*(.3+Math.abs(b.height-a.height)*.65);
 // Confined shelves need a crouched entry below the board above them.
 if((b.clearance??Infinity)<.4&&b.height>=a.height){
  height=t<.45?a.height+(b.height+.015-a.height)*Math.sin(t/.45*Math.PI/2):b.height+.015*Math.cos((t-.45)/.55*Math.PI/2);
 }else if((a.clearance??Infinity)<.4&&a.height>=b.height){
  height=t<.55?a.height+.015*Math.sin(t/.55*Math.PI):a.height+(b.height-a.height)*((t-.55)/.45)**2;
 }
 return{x:a.x+(b.x-a.x)*travel,z:a.z+(b.z-a.z)*travel,height};
}
export function jumpClear(a:Landing,b:Landing,volumes:readonly Volume[]):boolean{
 if(b.height-a.height>1.65||a.height-b.height>2.5||Math.hypot(a.x-b.x,a.z-b.z)>1.35)return false;
 for(let i=1;i<24;i++){
  const p=flightPoint(a,b,i/24);
  if(!onFloor(p)||p.z<1.5||!wallClear(p,p.height))return false;
  // Support geometry is still checked during flight; only endpoints stand on it.
  if(!bodyClear(p,p.height,volumes))return false;
 }
 return true;
}
export function buildPetGraph(items:readonly Item[],fittings=true):PetGraph {
 const softFloors=[...ZONES.filter(z=>z.material==='carpet'),...items.filter(i=>productFor(i.productId)?.placement==='rug').map(bounds)];
 const surfaces=placementSurfaces(items,fittings).filter(s=>s.height<=MAX_CAT_SURFACE_HEIGHT),volumes=volumesFor(items),nodes=new Map<string,Landing>(),edges=new Map<string,string[]>();
 for(let ix=0;ix<36;ix++)for(let iz=6;iz<28;iz++){
  const p={x:ix*.25+.125,z:iz*.25+.125};
  if(!fitsRoom({x:p.x-PAW,z:p.z-PAW,w:PAW*2,d:PAW*2},false)||!wallClear(p,0)||!bodyClear(p,0,volumes))continue;
  const id=`floor:${ix}:${iz}`;nodes.set(id,{...p,id,height:0,owner:'floor',surface:'floor',softFloor:softFloors.some(r=>inside(p,r))});edges.set(id,[]);
 }
 for(const s of surfaces){
  const nx=Math.max(1,Math.floor(s.w/.25)),nz=Math.max(1,Math.floor(s.d/.25));
  for(let ix=0;ix<nx;ix++)for(let iz=0;iz<nz;iz++){
   const p={x:s.x+s.w*(ix+.5)/nx,z:s.z+s.d*(iz+.5)/nz};
   if(!inside(p,s,PAW)||!wallClear(p,s.height)||!bodyClear(p,s.height,volumes))continue;
   const id=`${s.id}:${ix}:${iz}`;nodes.set(id,{...p,id,height:s.height,owner:s.owner,surface:s.id,...(s.clearance!==undefined?{clearance:s.clearance}:{})});edges.set(id,[]);
  }
 }
 const floor=[...nodes.values()].filter(n=>n.owner==='floor'),raised=[...nodes.values()].filter(n=>n.owner!=='floor');
 for(const n of floor){
  const ix=Math.round((n.x-.125)/.25),iz=Math.round((n.z-.125)/.25);
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
   if(dx===undefined||dz===undefined)continue;
   const other=nodes.get(`floor:${ix+dx}:${iz+dz}`);if(!other)continue;
   const mid={x:(n.x+other.x)/2,z:(n.z+other.z)/2};
   if(wallClear(mid,0)&&bodyClear(mid,0,volumes))edges.get(n.id)?.push(other.id);
  }
 }
 for(const a of raised)for(const b of nodes.values()){
  if(a.id===b.id||Math.hypot(a.x-b.x,a.z-b.z)>1.35)continue;
  if(a.surface===b.surface&&Math.hypot(a.x-b.x,a.z-b.z)<.42){const mid={x:(a.x+b.x)/2,z:(a.z+b.z)/2};if(wallClear(mid,a.height)&&bodyClear(mid,a.height,volumes))edges.get(a.id)?.push(b.id);continue;}
  if(jumpClear(a,b,volumes))edges.get(a.id)?.push(b.id);
  if(b.owner==='floor'&&jumpClear(b,a,volumes))edges.get(b.id)?.push(a.id);
 }
 return{nodes,edges,surfaces,volumes};
}
export function routeTo(graph:PetGraph,start:string,end:string):string[]{
 const queue=[start],prev=new Map<string,string>();prev.set(start,'');
 for(let head=0;head<queue.length;head++){
  const id=queue[head];if(id===undefined)continue;
  if(id===end){const route:string[]=[];let current=end;while(current!==start){route.unshift(current);const p=prev.get(current);if(p===undefined)return[];current=p;}return route;}
  for(const next of graph.edges.get(id)??[])if(!prev.has(next)){prev.set(next,id);queue.push(next);}
 }
 return[];
}
