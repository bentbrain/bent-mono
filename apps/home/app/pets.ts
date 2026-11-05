import type {CameraQuarter} from '@apartment-hotel/scene-engine';
import {flightPoint,routeTo,type Landing,type PetGraph} from './surfaces';
import type {Point} from './plan';
export type CatAnimation='idle'|'walk'|'sit'|'sleep'|'groom'|'jump'|'crouch';
export const CAT_ANIMATIONS:readonly CatAnimation[]=['idle','walk','sit','sleep','groom','jump','crouch'];
export interface Cat extends Point {id:'pearl'|'maree';direction:CameraQuarter;animation:CatAnimation;height?:number;surfaceOwner?:string;frame?:number}
export type PetActivity='wander'|'explore'|'watch'|'groom'|'sleep'|'play';
interface Motion {from:Landing;to:Landing;elapsed:number;duration:number;jump:boolean}
export interface Pet extends Cat {
 height:number;node:string;route:string[];motion:Motion|null;pause:number;clock:number;
 activity:PetActivity;energy:number;curiosity:number;grooming:number;
 recent:string[];favourite:string|null;
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
function nearest(graph:PetGraph,p:Point,floorOnly=false):Landing|undefined {
 let best:Landing|undefined,dist=Infinity;
 for(const n of graph.nodes.values()){
  if(floorOnly&&n.owner!=='floor')continue;
  const d=Math.hypot(n.x-p.x,n.z-p.z);if(d<dist){dist=d;best=n;}
 }
 return best;
}
export function createPet(id:Pet['id'],graph:PetGraph,p:Point):Pet {
 const node=nearest(graph,p,true);
 return{id,x:node?.x??p.x,z:node?.z??p.z,height:0,node:node?.id??'',route:[],motion:null,pause:id==='pearl'?1:2.5,clock:0,direction:2,animation:'sit',frame:0,surfaceOwner:'floor',activity:'watch',energy:id==='pearl'?.68:.82,curiosity:id==='pearl'?.55:.75,grooming:.2,recent:[],favourite:null};
}
function facing(a:Point,b:Point):CameraQuarter {
 return Math.abs(b.x-a.x)>Math.abs(b.z-a.z)?b.x>a.x?1:3:b.z>a.z?2:0;
}
/** Temporary navigation for a chosen destination. There are no authored patrols. */
export function sendPetTo(pet:Pet,target:string,graph:PetGraph):Pet {
 if(pet.motion)return pet;
 const route=routeTo(graph,pet.node,target);
 return route.length?{...pet,route,pause:0,activity:'explore'}:pet;
}
function weighted<T>(values:readonly {value:T;weight:number}[],random:()=>number):T|undefined {
 let draw=random()*values.reduce((sum,v)=>sum+v.weight,0);
 for(const item of values){draw-=item.weight;if(draw<0)return item.value;}
 return values.at(-1)?.value;
}
function comfort(node:Landing,graph:PetGraph):number {
 const s=graph.surfaces.find(s=>s.id===node.surface);
 return node.owner==='toilet'?.1:s?.use==='seat'?1:node.softFloor?.7:.08;
}
function settle(pet:Pet,node:Landing,random:()=>number):Pet {
 const activity=pet.activity;
 const duration=activity==='sleep'?150+random()*270:activity==='groom'?12+random()*18:3+random()*5;
 const animation:CatAnimation=activity==='sleep'?'sleep':(node.clearance??Infinity)<.4?'crouch':activity==='groom'?'groom':activity==='watch'||node.height>0?'sit':'idle';
 return{...pet,pause:duration,clock:0,animation,frame:animation==='crouch'?3:0,recent:[node.surface,...pet.recent.filter(s=>s!==node.surface)].slice(0,8),favourite:activity==='sleep'&&node.owner!=='floor'?node.surface:pet.favourite};
}
function decide(pet:Pet,graph:PetGraph,random:()=>number,occupied:readonly string[],night=false):Pet {
 const standing=graph.nodes.get(pet.node);if(!standing)return pet;
 const activity:PetActivity=pet.energy<.24?'sleep':weighted<PetActivity>([
  {value:'sleep',weight:8+(1-pet.energy)**2*4},
  {value:'groom',weight:.18+pet.grooming**2*.8},
  {value:'watch',weight:.12},
  {value:'wander',weight:.05},
  {value:'explore',weight:.08},
  {value:'play',weight:night&&pet.energy>.65?.15:0},
 ],random)??'watch';
 const next={...pet,activity,clock:0};
 if(activity==='groom'&&(standing.clearance??Infinity)>.4)return settle(next,standing,random);
 if(activity==='sleep'&&pet.activity!=='sleep'&&comfort(standing,graph)>=.7)return settle(next,standing,random);
 if(activity==='watch'&&random()<.55)return settle({...next,direction:random()<.5?pet.direction:facing(pet,{x:4,z:3.5})},standing,random);
 // Sample places, not a fixed sequence. Normalise per surface so a large bed
 // or the many floor nodes do not overwhelm a small seat or shelf.
 const groups=new Map<string,Landing[]>();
 for(const n of graph.nodes.values()){
  if(n.id===pet.node||occupied.includes(n.id))continue;
  if(activity==='sleep'&&(comfort(n,graph)<.7||(pet.activity==='sleep'&&n.owner!=='floor'&&n.surface===standing.surface)))continue;
  const distance=Math.hypot(n.x-pet.x,n.z-pet.z);
  if((activity==='wander'||activity==='play')&&(n.owner!=='floor'||distance>3))continue;
  const key=n.owner==='floor'?(activity==='sleep'?'soft-floor':`floor:${Math.floor(n.x)}:${Math.floor(n.z)}`):n.surface;
  const group=groups.get(key)??[];group.push(n);groups.set(key,group);
 }
 const candidates=[...groups.values()].flatMap(group=>{
  const n=group[Math.floor(random()*group.length)];if(!n)return[];
  const distance=Math.hypot(n.x-pet.x,n.z-pet.z),novelty=pet.recent.includes(n.surface)?.25:1;
  let weight:number;
  if(activity==='sleep')weight=(n.softFloor?.6:comfort(n,graph)**3*5)*(n.surface===pet.favourite?1.2:1)/(1+distance*.15);
  else if(activity==='watch')weight=(n.height>.3?2:0.15)/(1+distance);
  else if(activity==='explore')weight=novelty*(n.height>0?2:.35)/(1+distance*.2);
  else weight=.2+Math.min(distance,2);
  return[{value:n,weight}];
 });
 for(let attempt=0;attempt<24&&candidates.length;attempt++){
  const target=weighted(candidates,random);if(!target)break;
  const route=routeTo(graph,pet.node,target.id);
  if(route.length&&!occupied.includes(route[0]??''))return{...next,route,pause:0};
  const index=candidates.findIndex(c=>c.value.id===target.id);candidates.splice(index,1);
 }
 return settle({...next,activity:'sleep'},standing,random);
}
export function stepPet(previous:Pet,dt:number,graph:PetGraph,random:()=>number=Math.random,occupied:readonly string[]=[],night=false):Pet {
 const sleeping=!previous.motion&&!previous.route.length&&previous.pause>0&&previous.activity==='sleep';
 const grooming=!previous.motion&&!previous.route.length&&previous.pause>0&&previous.activity==='groom';
 const active=previous.motion!==null;
 const pet:Pet={...previous,
  energy:clamp(previous.energy+dt*(sleeping?.0003:active?(previous.activity==='play'?-.009:-.001):-.00003)),
  curiosity:clamp(previous.curiosity+dt*(active?-.006:sleeping?.00003:.0002)),
  grooming:clamp(previous.grooming+dt*(grooming?-.01:.0001)),
 };
 const standing=graph.nodes.get(pet.node),destination=pet.motion?graph.nodes.get(pet.motion.to.id):undefined;
 if(!standing||pet.motion&&(!destination||Math.hypot(destination.x-pet.motion.to.x,destination.z-pet.motion.to.z)>.01||Math.abs(destination.height-pet.motion.to.height)>.01)||!pet.motion&&(Math.hypot(standing.x-pet.x,standing.z-pet.z)>.01||Math.abs(standing.height-pet.height)>.01)){
  return{...createPet(pet.id,graph,pet),energy:pet.energy,curiosity:pet.curiosity,grooming:pet.grooming,recent:pet.recent,favourite:pet.favourite};
 }
 if(pet.motion){
  const motion={...pet.motion,elapsed:pet.motion.elapsed+dt},t=Math.min(1,motion.elapsed/motion.duration);
  const p=motion.jump?flightPoint(motion.from,motion.to,t):{x:motion.from.x+(motion.to.x-motion.from.x)*t,z:motion.from.z+(motion.to.z-motion.from.z)*t,height:motion.from.height};
  if(t>=1){
   const landed:Pet={...pet,x:motion.to.x,z:motion.to.z,height:motion.to.height,node:motion.to.id,motion:null,clock:0,animation:'idle',frame:0,surfaceOwner:motion.to.owner,pause:0};
   return pet.route.length?landed:settle(landed,motion.to,random);
  }
  return{...pet,...p,motion,clock:pet.clock+dt,animation:(motion.to.clearance??motion.from.clearance??Infinity)<.4?'crouch':motion.jump?'jump':'walk',frame:motion.jump?Math.min(7,Math.floor(t*8)):Math.floor((pet.clock+dt)*(pet.activity==='play'?16:5))%8,surfaceOwner:motion.to.owner==='floor'?motion.from.owner:motion.to.owner};
 }
 if(pet.route.length){
  const [next,...rest]=pet.route,to=next?graph.nodes.get(next):undefined,from=graph.nodes.get(pet.node);
  if(!from||!to||!graph.edges.get(from.id)?.includes(to.id)||occupied.includes(to.id))return{...pet,route:[],pause:.5,activity:'watch',animation:'idle'};
  const jump=from.surface!==to.surface;
  return{...pet,route:rest,direction:facing(from,to),clock:0,motion:{from,to,elapsed:0,duration:jump?.72+Math.abs(to.height-from.height)*.13:Math.hypot(from.x-to.x,from.z-to.z)/(pet.activity==='play'?1.1:.22),jump},animation:(to.clearance??from.clearance??Infinity)<.4?'crouch':jump?'jump':'walk'};
 }
 if(pet.pause>0){
  const clock=pet.clock+dt;
  return{...pet,pause:Math.max(0,pet.pause-dt),clock,frame:pet.animation==='crouch'?3:Math.floor(clock*(sleeping?2:6))%8};
 }
 return decide(pet,graph,random,occupied,night);
}

// Reserve body-sized spaces and the complete in-flight path, not just one grid cell.
export const CAT_SEPARATION=.82;
function close(a:Point&{height:number},b:Point&{height:number}):boolean{return Math.abs(a.height-b.height)<.65&&Math.hypot(a.x-b.x,a.z-b.z)<CAT_SEPARATION;}
function occupiedBy(other:Pet):Array<Point&{height:number}>{
 const points=[{x:other.x,z:other.z,height:other.height}];
 if(other.motion)for(let i=0;i<=12;i++)points.push(other.motion.jump?flightPoint(other.motion.from,other.motion.to,i/12):{x:other.motion.from.x+(other.motion.to.x-other.motion.from.x)*i/12,z:other.motion.from.z+(other.motion.to.z-other.motion.from.z)*i/12,height:other.height});
 return points;
}
/** Sequential reservations prevent both cats claiming a perch or crossing each other in one tick. */
export function stepPets(previous:readonly Pet[],dt:number,graph:PetGraph,random:()=>number=Math.random,night=false):Pet[]{
 const next=[...previous];
 for(let index=0;index<next.length;index++){
  const pet=next[index];if(!pet)continue;
  const others=next.filter(p=>p.id!==pet.id),spaces=others.flatMap(occupiedBy);
  const blocked=[...graph.nodes.values()].filter(n=>spaces.some(p=>close(n,p))).map(n=>n.id);
  let result=stepPet(pet,dt,graph,random,blocked,night);
  if(spaces.some(p=>close(result,p))){
   if(!spaces.some(p=>close(pet,p)))result={...pet,route:[],motion:null,pause:1.5,animation:'sit'};
   else{
    const landing=[...graph.nodes.values()].filter(n=>n.owner==='floor'&&!blocked.includes(n.id)).sort((a,b)=>Math.hypot(a.x-pet.x,a.z-pet.z)-Math.hypot(b.x-pet.x,b.z-pet.z))[0];
    if(landing)result=createPet(pet.id,graph,landing);
   }
  }else if(result.motion&&!pet.motion&&occupiedBy(result).some(p=>spaces.some(q=>close(p,q))))result={...pet,route:[],pause:1.5,animation:'sit'};
  next[index]=result;
 }
 return next;
}
