import {createCanvas,Image} from '@napi-rs/canvas';
import {render,loadSprites,WIDTH,HEIGHT} from '../app/scene.ts';
import {createPet,stepPet} from '../app/pets.ts';
import {buildPetGraph} from '../app/surfaces.ts';
globalThis.Image=class extends Image {set src(v){super.src=v.split('?')[0];}get src(){return super.src;}};
await loadSprites('public/sprites');
const items=[{id:'sofa',productId:'sofa',x:2.5,z:3.5,rotation:0,entityId:''},{id:'table',productId:'table',x:2.5,z:5.4,rotation:0,entityId:''}];
const graph=buildPetGraph(items),c=createCanvas(WIDTH,HEIGHT),ctx=c.getContext('2d');
let seed=149;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
let cats=[createPet('pearl',graph,{x:3.875,z:3.625}),createPet('maree',graph,{x:1.625,z:5.375})];
let firstJump=-1,frame=0;const events=[];
await Bun.$`mkdir -p runs/autonomous-pets`;
for(let i=0;i<2400;i++){
 const previous=cats;
 cats=previous.map(cat=>stepPet(cat,.05,graph,random,previous.filter(other=>other.id!==cat.id).flatMap(other=>[other.node,...other.motion?[other.motion.to.id]:[]])));
 for(let k=0;k<cats.length;k++)if(cats[k].activity!==previous[k].activity)events.push({seconds:i*.05,cat:cats[k].id,activity:cats[k].activity,destination:cats[k].route.at(-1)??cats[k].node});
 if(firstJump<0&&cats.some(cat=>cat.animation==='jump'))firstJump=i;
 if(firstJump>=0&&i<firstJump+300&&i%2===0){
  render(ctx,{q:1,items,selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats,frame:0,hass:undefined,devices:false,vacuum:null});
  await Bun.write(`runs/autonomous-pets/${String(frame++).padStart(3,'0')}.png`,c.toBuffer('image/png'));
 }
}
await Bun.write('runs/autonomous-pets/decisions.json',JSON.stringify(events,null,2));
console.log(`Unscripted 120-second simulation: ${events.length} activity changes, first jump at ${firstJump*.05}s, ${frame} review frames. No destinations assigned.`);
