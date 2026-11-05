import {createCanvas,Image} from '@napi-rs/canvas';
import {render,loadSprites,WIDTH,HEIGHT} from '../app/scene.ts';
import {createPet,sendPetTo,stepPet} from '../app/pets.ts';
import {buildPetGraph} from '../app/surfaces.ts';
globalThis.Image=class extends Image {set src(v){super.src=v.split('?')[0];}get src(){return super.src;}};
await loadSprites('public/sprites');
const items=[{id:'table',productId:'table',x:2.5,z:3.5,rotation:0,entityId:''},{id:'bed',productId:'kirribilli',x:7.25,z:1.75,rotation:0,entityId:''}];
const graph=buildPetGraph(items),target=[...graph.nodes.values()].find(n=>n.owner==='table');
if(!target)throw Error('No table landing');
let pet=sendPetTo(createPet('pearl',graph,{x:3.875,z:3.625}),target.id,graph);
let maree=sendPetTo(createPet('maree',graph,{x:1.625,z:5.375}),'counter-end:1:1',graph);
const canvas=createCanvas(WIDTH,HEIGHT),ctx=canvas.getContext('2d');const records=[];
await Bun.$`mkdir -p runs/pet-motion`;
for(let i=0;i<100;i++){
 pet=stepPet(pet,.05,graph,()=>.5);maree=stepPet(maree,.05,graph,()=>.5);
 render(ctx,{q:1,items,selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats:[pet,maree],frame:i,hass:undefined,devices:false,vacuum:null});
 await Bun.write(`runs/pet-motion/${String(i).padStart(3,'0')}.png`,canvas.toBuffer('image/png'));
 records.push({frame:i,pearl:{x:pet.x,z:pet.z,height:pet.height,animation:pet.animation,node:pet.node},maree:{height:maree.height,animation:maree.animation,node:maree.node}});
}
await Bun.write('runs/pet-motion/timeline.json',JSON.stringify(records,null,2));
console.log('Actual renderer: 100 frames of walking, jumping and landing on supports.');
