import {expect,test} from 'bun:test';
import {createPet,stepPet,stepPets,type Pet,type PetActivity} from './pets';
import {buildPetGraph} from './surfaces';
import type {Item} from './editorState';
const furniture:Item[]=[{id:'sofa',productId:'sofa',x:2.5,z:3.5,rotation:0,entityId:''},{id:'table',productId:'table',x:2.5,z:5.4,rotation:0,entityId:''}];
function seeded(seed:number):()=>number {return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}

test('Tired cats autonomously find a reachable perch and take a sustained nap',()=>{
 const graph=buildPetGraph(furniture),random=seeded(71);
 let pet={...createPet('pearl',graph,{x:3.875,z:3.625}),energy:.1,pause:0};
 for(let i=0;i<2000&&pet.animation!=='sleep';i++)pet=stepPet(pet,.05,graph,random);
 expect(pet.activity).toBe('sleep');expect(pet.animation).toBe('sleep');expect(pet.height).toBeGreaterThanOrEqual(0);
 expect(pet.pause).toBeGreaterThanOrEqual(60);if(pet.height>0)expect(pet.favourite).toBe(graph.nodes.get(pet.node)?.surface??null);
 const energy=pet.energy,node=pet.node;
 for(let i=0;i<600;i++)pet=stepPet(pet,.05,graph,random);
 expect(pet.node).toBe(node);expect(pet.animation).toBe('sleep');expect(pet.energy).toBeGreaterThan(energy);
});

test('Unscripted simulation produces floor wandering, jumps, rests, grooming and play',()=>{
 const graph=buildPetGraph(furniture),random=seeded(149);
 let pet=createPet('maree',graph,{x:3.875,z:3.625});
 const activities=new Set<PetActivity>(),animations=new Set<string>(),places=new Set<string>();let invalidMotion=false;
 for(let i=0;i<86400;i++){
  pet=stepPet(pet,1,graph,random,[],i%86400>=19*3600||i%86400<6*3600);activities.add(pet.activity);animations.add(pet.animation);places.add(pet.node);
  invalidMotion ||= !Number.isFinite(pet.x)||!Number.isFinite(pet.z)||!Number.isFinite(pet.height);
 }
 for(const activity of ['wander','explore','watch','groom','sleep','play'] satisfies PetActivity[])expect(activities.has(activity),activity).toBe(true);
 expect(invalidMotion).toBe(false);expect(animations.has('jump')).toBe(true);expect(places.size).toBeGreaterThan(30);
});

test('Random choices produce different destinations and occupied perches are not chosen',()=>{
 const graph=buildPetGraph(furniture),pet={...createPet('pearl',graph,{x:3.875,z:3.625}),pause:0,energy:.9,curiosity:1};
 const ends=new Set<string>();
 for(let seed=1;seed<=30;seed++){
  const next=stepPet(pet,.05,graph,seeded(seed*1127));
  if(next.route.length)ends.add(next.route.at(-1)??'');
 }
 expect(ends.size).toBeGreaterThan(4);
 const occupied=[...graph.nodes.values()].filter(n=>n.owner==='sofa').map(n=>n.id);
 const sleepy=stepPet({...pet,energy:.1},.05,graph,seeded(71),occupied);
 expect(occupied.includes(sleepy.route.at(-1)??'')).toBe(false);
});

test('Removing a favourite sleeping surface preserves needs and forces a new decision',()=>{
 const graph=buildPetGraph(furniture),node=[...graph.nodes.values()].find(n=>n.owner==='sofa');
 if(!node)throw Error('Missing seat');
 const pet:Pet={...createPet('pearl',graph,node),node:node.id,x:node.x,z:node.z,height:node.height,surfaceOwner:node.owner,energy:.15,favourite:node.surface,pause:80,activity:'sleep'};
 const next=stepPet(pet,.05,buildPetGraph([]),seeded(12));
 expect(next.height).toBe(0);expect(next.energy).toBeLessThan(.16);expect(next.route).toEqual([]);
});

test('Cats spend most of the half hour asleep and walk between different nap spots',()=>{
 const graph=buildPetGraph(furniture),random=seeded(149);let pet=createPet('pearl',graph,{x:3.875,z:3.625}),moving=0,sleeping=0,standing=0,longestStanding=0,softSleep=0;
 const sleepingPlaces=new Set<string>();
 for(let i=0;i<9000;i++){
  pet=stepPet(pet,.2,graph,random);
  if(pet.motion)moving++;
  if(pet.animation==='sleep'){
   sleeping++;sleepingPlaces.add(pet.node);const node=graph.nodes.get(pet.node);
   if(node?.softFloor||graph.surfaces.some(s=>s.id===node?.surface&&s.use==='seat'&&s.owner!=='toilet'))softSleep++;
  }
  standing=pet.animation==='idle'?standing+.2:0;longestStanding=Math.max(longestStanding,standing);
 }
 expect(sleeping/9000).toBeGreaterThan(.8);expect(moving/9000).toBeLessThan(.2);expect(moving).toBeGreaterThan(0);
 expect(softSleep/sleeping).toBeGreaterThan(.95);expect(sleepingPlaces.size).toBeGreaterThan(2);expect(longestStanding).toBeLessThan(10);
});



test('Two cats reserve body-sized perches and paths, without overlapping while walking or jumping',()=>{
 const graph=buildPetGraph(furniture),random=seeded(843);
 let cats=[createPet('pearl',graph,{x:3.875,z:3.625}),createPet('maree',graph,{x:4.125,z:3.625})];
 let nearest=Infinity,motion=0;
 for(let i=0;i<36000;i++){
  cats=stepPets(cats,.2,graph,random,true);const a=cats[0],b=cats[1];if(!a||!b)throw Error('Missing cat');
  if(Math.abs(a.height-b.height)<.65)nearest=Math.min(nearest,Math.hypot(a.x-b.x,a.z-b.z));
  if(cats.some(c=>c.motion))motion++;
 }
 expect(nearest).toBeGreaterThanOrEqual(.82);expect(motion).toBeGreaterThan(10);
});
