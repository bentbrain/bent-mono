import { rotateAroundOrigin, type CameraQuarter } from '@apartment-hotel/scene-engine';
import { fillPixelPolygon, drawPixelLine, drawPixelPolygonOutline } from './roomRenderer';
import {CENTER,ZONES,WALLS, type Point,type Rect,type Wall} from './plan';
import {FIXED_FITTINGS,FIXED_MODEL_IDS,fixedSpriteSize} from './fixedFittings';
import {isWallCutAway} from './wallVisibility';
import {bounds,type Item,placeable,productFor} from './editorState';
import {CAT_ANIMATIONS,type Cat} from './pets';
export type {Cat,CatAnimation} from './pets';
import {lightState,LIGHT_LOCATIONS,type Hass} from './ha';
export const SPRITE_VERSION = 7;
export type WallDisplay='full'|'cutaway'|'low'|'hidden';
export const DEFAULT_WALL_DISPLAY:WallDisplay='cutaway';
export const WIDTH=960,HEIGHT=720;
export type Pixel={x:number;y:number};
export function project(p:Point,q:CameraQuarter,h=0):Pixel {const r=rotateAroundOrigin({x:p.x-CENTER.x,z:p.z-CENTER.z},q);return{x:Math.round(WIDTH/2+(r.x-r.z)*48),y:Math.round(365+(r.x+r.z)*24-h*60.72)};}
export function unproject(p:Pixel,q:CameraQuarter):Point {const x=(p.x-WIDTH/2)/48,z=(p.y-365)/24;const inv:CameraQuarter=q===1?3:q===3?1:q;const r=rotateAroundOrigin({x:(z+x)/2,z:(z-x)/2},inv);return{x:r.x+CENTER.x,z:r.z+CENTER.z};}
export function rectPoints(r:Rect,q:CameraQuarter,h=0):Pixel[]{return[{x:r.x,z:r.z},{x:r.x+r.w,z:r.z},{x:r.x+r.w,z:r.z+r.d},{x:r.x,z:r.z+r.d}].map(p=>project(p,q,h));}
const images=new Map<string,HTMLImageElement>();
export async function loadSprites(base:string):Promise<void>{
 const jobs:Promise<void>[]=[];
 for(const name of ['dyvlinge','perjohan','byakorre','kirribilli','okensand','gullsudare','sofa','table','vacuum','pearl-v3','maree-v3',...FIXED_MODEL_IDS])for(const anim of name==='pearl-v3'||name==='maree-v3'?CAT_ANIMATIONS:['idle'])for(const dir of ['north','east','south','west']){
 const key=`${name}-${anim}-${dir}`;jobs.push(new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{images.set(key,img);resolve();};img.onerror=()=>reject(Error(`Could not load ${key}`));img.src=`${base}/${key}.png?v=${SPRITE_VERSION}`;}));
 }await Promise.all(jobs);
}
const DIRS=['north','east','south','west'];
function sprite(ctx:CanvasRenderingContext2D,id:string,p:Point,rotation:CameraQuarter,q:CameraQuarter,anim='idle',frame=0,height=0):void {
 const dir=DIRS[(rotation+q)%4];const img=images.get(`${id}-${anim}-${dir}`);if(!img)return;const s=project(p,q,height),size=id==='pearl-v3'||id==='maree-v3'?96:fixedSpriteSize(id);ctx.drawImage(img,frame*size,0,size,size,s.x-size/2,s.y-size*.75,size,size);
}
function line(ctx:CanvasRenderingContext2D,a:Point,b:Point,q:CameraQuarter,color:string,h=0,width=1){drawPixelLine(ctx,project(a,q,h),project(b,q,h),color,width);}
function wall(ctx:CanvasRenderingContext2D,w:Wall,q:CameraQuarter,mode:WallDisplay){
 if(mode==='hidden')return;
 const n=rotateAroundOrigin(w.normal,q),rear=n.x<0||n.z<0;
 // Near exterior walls end at the floor in cutaway view. A raised cap on a
 // short return projects into the adjacent full-height wall like floating trim.
 if(mode==='cutaway'&&isWallCutAway(w,q))return;
 const length=Math.hypot(w.b.x-w.a.x,w.b.z-w.a.z);
 const at=(t:number):Point=>({x:w.a.x+(w.b.x-w.a.x)*t,z:w.a.z+(w.b.z-w.a.z)*t});
 const plane=(lo:number,hi:number,color:string)=>fillPixelPolygon(ctx,[project(w.a,q,lo),project(w.b,q,lo),project(w.b,q,hi),project(w.a,q,hi)],color);
 const edge=(lo:number,hi:number,color:string,width=1)=>{drawPixelLine(ctx,project(w.a,q,lo),project(w.b,q,lo),color,width);drawPixelLine(ctx,project(w.a,q,hi),project(w.b,q,hi),color,width);};
 const height=mode==='full'?(w.kind==='robe'?2.4:w.kind==='rail'?1.05:2.7):w.kind==='robe'?(mode==='low'||rear?.2:2.4):w.kind==='rail'?1.05:mode==='low'?.2:2.7;
 const face=Math.abs(n.x)>.5?'#e5e3dc':'#f6f5ee';
 const solid=(lo:number,hi:number)=>{
  plane(lo,hi,face);
  const thick={x:w.normal.x*.13,z:w.normal.z*.13};
  const backA={x:w.a.x+thick.x,z:w.a.z+thick.z},backB={x:w.b.x+thick.x,z:w.b.z+thick.z};
  fillPixelPolygon(ctx,[project(w.a,q,hi),project(w.b,q,hi),project(backB,q,hi),project(backA,q,hi)],'#ffffff');
  fillPixelPolygon(ctx,[project(w.b,q,lo),project(backB,q,lo),project(backB,q,hi),project(w.b,q,hi)],'#c7c8be');
  drawPixelLine(ctx,project(backA,q,hi),project(backB,q,hi),'#a3a49b');
  edge(lo,lo+.07,'#b7b8b0',2);
 };
 if(w.kind==='glass'||w.kind==='rail'){
  const top=w.kind==='rail'?1.05:height>.3?2.42:.12;
  // Three broad sliding leaves. Balustrade uses glass panels, never pickets.
  const divisions=w.kind==='glass'?3:4;
  edge(0,top,'#303c3d',3);edge(.045,.085,'#798889');
  for(let i=0;i<=divisions;i++)drawPixelLine(ctx,project(at(i/divisions),q),project(at(i/divisions),q,top),'#303c3d',i===0||i===divisions?3:2);
  if(top>.4){
   for(let i=0;i<divisions;i++){
    const a=at((i+.20)/divisions),b=at((i+.40)/divisions);
    drawPixelLine(ctx,project(a,q,top*.72),project(b,q,top*.87),'#d2ece8',2);
    drawPixelLine(ctx,project(a,q,top*.61),project(b,q,top*.76),'#b0d5d4');
   }
   if(w.kind==='glass'){const p=at(1/3);drawPixelLine(ctx,project(p,q,.95),project(p,q,1.13),'#d5dad1',2);}
  }
  return;
 }
 if(w.kind==='window'){
  if(height<.4){solid(0,height);return;}
  // Bedroom clerestory, measured proportionally from photos 05 and 06.
  solid(0,1.65);solid(2.16,2.7);
  plane(1.65,2.16,'#a8d6dd');edge(1.65,2.16,'#303c3d',4);
  for(let i=0;i<=4;i++)drawPixelLine(ctx,project(at(i/4),q,1.65),project(at(i/4),q,2.16),'#303c3d',3);
  edge(2.22,2.27,'#4e5656',3);edge(1.60,1.63,'#ffffff',2);return;
 }
 if(w.kind==='closed-door'){
  solid(0,height);
  if(height>.3){plane(.04,2.35,'#303635');edge(.04,2.35,'#4e5656',2);
   for(let i=1;i<(w.leaves??1);i++){const p=at(i/(w.leaves??1));drawPixelLine(ctx,project(p,q,.04),project(p,q,2.35),'#4e5656',2);}
   for(const t of (w.leaves===2?[.46,.54]:[.82])){const p=project(at(t),q,1.05);ctx.fillStyle='#d9ddd4';ctx.fillRect(p.x-1,p.y-4,2,8);}
  }return;
 }
 if(w.kind==='robe'){

  plane(0,height,'#4b514f');edge(0,height,'#303635',2);
  for(let i=1;i<4;i++){const p=at(i/4);drawPixelLine(ctx,project(p,q),project(p,q,height),'#343b39');}
  if(height>.5)for(const t of [.235,.265,.735,.765]){const p=project(at(t),q,1.05);ctx.fillStyle='#d9ddd4';ctx.fillRect(p.x-1,p.y-2,3,4);}return;
 }
 solid(0,height);
 // The photographed vanity wall is charcoal; the shower end wall is white.
 if(w.a.z===5.65&&w.a.x>=6.3){
  plane(.08,height-.06,'#626865');
  for(let z=.3;z<height-.06;z+=.3)edge(z,z,'#89908b');
  for(let t=.6;t<length;t+=.6)drawPixelLine(ctx,project(at(t/length),q,.08),project(at(t/length),q,height-.06),'#89908b');
 }
}
export interface RenderOptions {q:CameraQuarter;items:readonly Item[];selected:string|null;ghost:Item|null;grid:boolean;labels:boolean;walls:WallDisplay;fittings?:boolean;cats:readonly Cat[];frame:number;hass:Hass|undefined;devices:boolean;vacuum:Point|null}
export function render(ctx:CanvasRenderingContext2D,o:RenderOptions){
 ctx.imageSmoothingEnabled=false;ctx.fillStyle='#86d4e8';ctx.fillRect(0,0,WIDTH,HEIGHT);
 // Hard pixel contact shadow under the apartment slab.
 for(const z of ZONES){const points=rectPoints(z,o.q).map(p=>({x:p.x,y:p.y+9}));fillPixelPolygon(ctx,points,'#277f7e');}
 for(const z of ZONES){
  const poly=rectPoints(z,o.q);
  fillPixelPolygon(ctx,poly,z.material==='oak'?'#ac805d':z.material==='carpet'?'#71766f':z.material==='tile'?'#515954':'#b2b5a5');
  drawPixelPolygonOutline(ctx,poly,'#696e62');
  if(z.material==='carpet'){
   for(let dx=0;dx<z.w;dx+=.5)for(let dz=0;dz<z.d;dz+=.5){
    const ix=Math.round(dx*2),iz=Math.round(dz*2),colors=['#676e65','#7d8479','#8b9185','#5b645c'];
    const color=colors[(ix*7+iz*3)%4]??'#71766f';
    const patch={x:z.x+dx,z:z.z+dz,w:Math.min(.5,z.w-dx),d:Math.min(.5,z.d-dz)};fillPixelPolygon(ctx,rectPoints(patch,o.q),color);
    if((ix+iz)%2===0){patch.w*=.3;fillPixelPolygon(ctx,rectPoints(patch,o.q),'#91978b');}
   }
  }else{
   const step=z.material==='oak'?.18:z.material==='tile'?.3:.6;
   const grout=z.material==='oak'?'#8e694d':z.material==='tile'?'#7e8780':'#8d9488';
   for(let dz=step;dz<z.d;dz+=step)line(ctx,{x:z.x,z:z.z+dz},{x:z.x+z.w,z:z.z+dz},o.q,grout);
   for(let dz=0;dz<z.d;dz+=step)for(let dx=z.material==='oak'?(Math.round(dz/step)%3)*.45+.6:step;dx<z.w;dx+=z.material==='oak'?1.8:step)line(ctx,{x:z.x+dx,z:z.z+dz},{x:z.x+dx,z:z.z+Math.min(z.d,dz+step)},o.q,grout);
  }
  if(o.grid){for(let dx=.25;dx<z.w;dx+=.25)line(ctx,{x:z.x+dx,z:z.z},{x:z.x+dx,z:z.z+z.d},o.q,'#ead39d');for(let dz=.25;dz<z.d;dz+=.25)line(ctx,{x:z.x,z:z.z+dz},{x:z.x+z.w,z:z.z+dz},o.q,'#ead39d');}
 }
 const layers:{depth:number;draw:()=>void}[]=[];
 // Rear planes precede their attached objects along the whole wall run.
 for(const w of WALLS){
  if(w.kind==='robe'&&o.fittings!==false)continue;
  const n=rotateAroundOrigin(w.normal,o.q),rear=n.x<0||n.z<0;
  const a=project(w.a,o.q),b=project(w.b,o.q);
  layers.push({depth:rear?Math.min(a.y,b.y)-1:Math.max(a.y,b.y)+1,draw:()=>wall(ctx,w,o.q,o.walls)});
 }
 if(o.fittings!==false)for(const f of FIXED_FITTINGS){
  if(f.render===false)continue;
  if(f.wallNormal){const n=rotateAroundOrigin(f.wallNormal,o.q);if(f.id==='overheads'&&o.walls!=='full'&&(o.walls!=='cutaway'||(n.x>=0&&n.z>=0)))continue;}
  const p=project(f,o.q);layers.push({depth:p.y,draw:()=>sprite(ctx,f.model,f,f.rotation,o.q)});
 }
 for(const item of o.items){const p=project(item,o.q);layers.push({depth:p.y,draw:()=>{if(item.id===o.selected){const points=rectPoints(bounds(item),o.q);fillPixelPolygon(ctx,points,'#52c7bd');drawPixelPolygonOutline(ctx,points,'#277f7e');}if(item.productId!=='vacuum'||!o.hass||['docked','charging'].includes(o.hass.states[item.entityId]?.state??'')){sprite(ctx,item.productId,item,item.rotation,o.q);}else{drawPixelPolygonOutline(ctx,rectPoints(bounds(item),o.q),'#277f7e');const d=project(item,o.q);ctx.fillStyle='#4a3857';ctx.font='8px monospace';ctx.textAlign='center';ctx.fillText('DOCK',d.x,d.y);}
 if(productFor(item.productId)?.category==='Lighting'){const state=lightState(o.hass?.states[item.entityId]);const s=project(item,o.q,productFor(item.productId)?.h??1);ctx.fillStyle=state.state==='on'?state.color:state.state==='off'?'#251d2f':'#8f3c55';ctx.fillRect(s.x-3,s.y,6,4);}}});}
 for(const cat of o.cats){
  const p=project(cat,o.q),height=cat.height??0;let depth=p.y;
  if(height>.05&&cat.surfaceOwner){
   const support=o.items.find(i=>i.id===cat.surfaceOwner)??FIXED_FITTINGS.find(f=>f.id===cat.surfaceOwner);
   if(support)depth=Math.max(depth,project(support,o.q).y+1);
   if(['fridge','pantry','sink','dishwasher','bench','overheads'].includes(cat.surfaceOwner))depth=Math.max(depth,project({x:.36,z:3.6},o.q).y+1);
  }
  layers.push({depth,draw:()=>{
   if(cat.animation!=='jump')fillPixelPolygon(ctx,rectPoints({x:cat.x-.10,z:cat.z-.13,w:.2,d:.26},o.q,height+.005),'#626865');
   sprite(ctx,`${cat.id}-v3`,cat,cat.direction,o.q,cat.animation,cat.frame??o.frame%8,height);
  }});
 }
 if(o.vacuum){const p=o.vacuum;layers.push({depth:project(p,o.q).y,draw:()=>sprite(ctx,'vacuum',p,0,o.q)});}
 layers.sort((a,b)=>a.depth-b.depth).forEach(l=>l.draw());
 if(o.devices)for(const light of LIGHT_LOCATIONS){const state=lightState(o.hass?.states[light.id]);const p=project(light,o.q,1.6);ctx.fillStyle=state.state==='on'?state.color:state.state==='off'?'#251d2f':'#8f3c55';ctx.fillRect(p.x-4,p.y-3,8,6);ctx.fillStyle='#fffef3';ctx.fillRect(p.x-2,p.y-2,4,1);if(state.state==='on'){ctx.fillStyle=state.color;ctx.fillRect(p.x-8,p.y+7,16,Math.max(1,Math.round(state.brightness*3)));}}
 if(o.labels){ctx.font='9px monospace';ctx.textAlign='center';for(const z of ZONES.filter(z=>['bedroom','living','balcony','bathroom'].includes(z.id))){const p=project({x:z.x+z.w/2,z:z.z+z.d/2},o.q);const t=z.name.toUpperCase();ctx.fillStyle='#fffef3';ctx.fillRect(p.x-t.length*3-4,p.y-7,t.length*6+8,13);ctx.fillStyle='#4a3857';ctx.fillText(t,p.x,p.y+3);}}
 if(o.ghost){const p=rectPoints(bounds(o.ghost),o.q);drawPixelPolygonOutline(ctx,p,placeable(o.ghost,o.items)?'#277f7e':'#8f3c55');sprite(ctx,o.ghost.productId,o.ghost,o.ghost.rotation,o.q);}
}

export function projectPlan(p:Point):Pixel{return{x:Math.round(180+p.x*64),y:Math.round(90+p.z*64)};}
export function unprojectPlan(p:Pixel):Point{return{x:(p.x-180)/64,z:(p.y-90)/64};}
export function renderPlan(ctx:CanvasRenderingContext2D,items:readonly Item[],selected:string|null,fittings=true,ghost:Item|null=null,compact=false){
 ctx.fillStyle='#f3f1e8';ctx.fillRect(0,0,WIDTH,HEIGHT);ctx.imageSmoothingEnabled=false;
 for(const z of ZONES){const p=projectPlan(z);ctx.fillStyle=z.material==='oak'?'#dcc5a9':z.material==='carpet'?'#a3aaa1':z.material==='tile'?'#8b958c':'#c9d5c4';ctx.fillRect(p.x,p.y,Math.round(z.w*64),Math.round(z.d*64));
  if(!['hall','cupboard'].includes(z.id)){ctx.fillStyle='#303c3d';ctx.textAlign='center';ctx.font='12px monospace';ctx.fillText(z.name,p.x+z.w*32,p.y+z.d*32);ctx.font='10px monospace';if(!compact)ctx.fillText(z.label,p.x+z.w*32,p.y+z.d*32+16);}
 }
 for(const w of WALLS){const a=projectPlan(w.a),b=projectPlan(w.b);const glass=w.kind==='glass'||w.kind==='window'||w.kind==='rail';drawPixelLine(ctx,a,b,glass?'#277f7e':'#303c3d',glass?3:7);}
 if(fittings)for(const f of FIXED_FITTINGS.filter(f=>f.blocksFloor)){
  const r=f.footprint,p=projectPlan(r);ctx.fillStyle=f.model.startsWith('kitchen')?'#737976':'#fff5d6';ctx.fillRect(p.x,p.y,r.w*64,r.d*64);
  drawPixelPolygonOutline(ctx,[p,{x:p.x+r.w*64,y:p.y},{x:p.x+r.w*64,y:p.y+r.d*64},{x:p.x,y:p.y+r.d*64}],'#303c3d');
  ctx.fillStyle=f.model.startsWith('kitchen')?'#ffffff':'#303c3d';ctx.font='9px monospace';ctx.textAlign='center';if(!compact)ctx.fillText(f.label,p.x+r.w*32,p.y+r.d*32+3,Math.max(20,r.w*64-4));
 }
 for(const item of items){const r=bounds(item),p=projectPlan(r);ctx.fillStyle=selected===item.id?'#52c7bd':'#fffef3';ctx.fillRect(p.x,p.y,r.w*64,r.d*64);drawPixelPolygonOutline(ctx,[p,{x:p.x+r.w*64,y:p.y},{x:p.x+r.w*64,y:p.y+r.d*64},{x:p.x,y:p.y+r.d*64}],'#4a3857');ctx.fillStyle='#251d2f';ctx.font='10px monospace';ctx.textAlign='center';if(!compact)ctx.fillText(productFor(item.productId)?.name??item.productId,p.x+r.w*32,p.y+r.d*32,Math.max(20,r.w*64));}
 if(ghost){const r=bounds(ghost),p=projectPlan(r),color=placeable(ghost,items)?'#0647ff':'#c40035';ctx.save();ctx.globalAlpha=.22;ctx.fillStyle=color;ctx.fillRect(p.x,p.y,r.w*64,r.d*64);ctx.restore();ctx.strokeStyle=color;ctx.lineWidth=3;ctx.strokeRect(p.x,p.y,r.w*64,r.d*64);ctx.fillStyle=color;ctx.textAlign='center';ctx.font='12px monospace';ctx.fillText(placeable(ghost,items)?'Place here':'No room here',p.x+r.w*32,p.y-10);}
 ctx.textAlign='left';ctx.fillStyle='#4e5656';ctx.font='11px monospace';if(!compact)ctx.fillText('Published plan orientation · dimensions in metres · walls traced from the sales drawing',100,650);
 drawPixelLine(ctx,{x:180,y:610},{x:308,y:610},'#303c3d',3);ctx.fillText('2 m',180,632);
}
