import {expect,test} from 'bun:test';
import {buildPetGraph,placementSurfaces,routeTo,jumpClear,flightPoint,type Landing} from './surfaces';
import {createPet,sendPetTo,stepPet} from './pets';
import type {Item} from './editorState';
const table:Item={id:'table',productId:'table',x:2.5,z:3.5,rotation:0,entityId:''};

test('Support surfaces rotate and move with furniture in every view-independent world direction',()=>{
 for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const [s]=placementSurfaces([{...table,rotation}],false);expect(s).toBeDefined();
  expect(s?.height).toBe(.77);expect(s?.w).toBeCloseTo(rotation%2?.74:1.24);expect(s?.d).toBeCloseTo(rotation%2?1.24:.74);
  const [moved]=placementSurfaces([{...table,x:3.5,rotation}],false);expect((moved?.x??0)-(s?.x??0)).toBeCloseTo(1);
 }
});
test('Routes reach benches and seats but exclude tall cupboard tops',()=>{
 const g=buildPetGraph([]);
 expect(routeTo(g,'floor:10:12','counter-work:1:0').length).toBeGreaterThan(0);
 expect(routeTo(g,'floor:10:12','upper-top:0:5')).toEqual([]);
 expect([...g.nodes.values()].every(n=>n.height<=1.25)).toBe(true);
 expect(placementSurfaces([]).some(s=>s.owner==='fridge'||s.owner==='pantry')).toBe(false);
 expect(routeTo(g,'floor:27:18','toilet-seat:0:0').length).toBeGreaterThan(0);
 expect(g.surfaces.some(s=>s.id.includes('basin')||s.id.includes('hob'))).toBe(false);
});
test('All furnished seat and tabletop surfaces are reachable, including rotated seats',()=>{
 for(const productId of ['table','perjohan','dyvlinge','teak-sideboard','sofa','kirribilli','byakorre'])for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const g=buildPetGraph([{...table,productId,rotation}]);
  const targets=[...g.nodes.values()].filter(n=>n.owner==='table');
  expect(targets.some(n=>routeTo(g,'floor:15:20',n.id).length>0),`${productId}/${rotation}`).toBe(true);
 }
});
test('Jump arcs clear the support and cannot cross the bedroom wall or float outside the shell',()=>{
 const floor:Landing={id:'a',x:4.4,z:2,height:0,owner:'floor',surface:'floor'};
 expect(jumpClear(floor,{...floor,id:'b',x:5.6,height:.6,owner:'bed',surface:'bed'},[])).toBe(false);
 expect(jumpClear({...floor,x:.3,z:6.5},{...floor,x:-.4,z:6.5},[])).toBe(false);
 const a={...floor,x:2,z:3},b={...floor,x:2.7,z:3,height:.77};
 expect(flightPoint(a,b,0)).toEqual({x:a.x,z:a.z,height:0});
 expect(flightPoint(a,b,1).height).toBeCloseTo(.77);
 expect(flightPoint(a,b,.5).height).toBeGreaterThan(.77);
});
test('Cats land at the actual table height and recover when their furniture moves or is removed',()=>{
 const g=buildPetGraph([table]);const target=[...g.nodes.values()].find(n=>n.owner==='table');if(!target)throw Error('Missing table surface');
 let pet=sendPetTo(createPet('pearl',g,{x:3.875,z:3.625}),target.id,g);let jumped=false;
 for(let i=0;i<400&&pet.node!==target.id;i++){pet=stepPet(pet,.05,g,()=>.5);jumped ||= pet.animation==='jump';}
 expect(jumped).toBe(true);expect(pet.node).toBe(target.id);expect(pet.height).toBe(.77);
 const moved=stepPet(pet,.05,buildPetGraph([{...table,x:3.5}]),()=>.5);expect(moved.height).toBe(0);expect(moved.surfaceOwner).toBe('floor');
 const removed=stepPet(pet,.05,buildPetGraph([]),()=>.5);expect(removed.height).toBe(0);
});

test('Lower shelves remain reachable while tall tops have no landing in every rotation',()=>{
 for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const g=buildPetGraph([{...table,productId:'byakorre',rotation}]);
  expect(placementSurfaces([{...table,productId:'byakorre',rotation}]).some(s=>s.height>1.25)).toBe(true);
  expect([...g.nodes.values()].filter(n=>n.owner==='table').every(n=>n.height<=1.25)).toBe(true);
  for(const s of g.surfaces.filter(s=>s.owner==='table')){
   expect([...g.nodes.values()].some(n=>n.surface===s.id&&routeTo(g,'floor:15:20',n.id).length>0),`${s.id}/${rotation}`).toBe(true);
  }
 }
});

test('Cats have no floor nodes in the removed laundry or cupboard interiors',()=>{
 const g=buildPetGraph([]);
 expect([...g.nodes.values()].some(n=>n.x>4.8&&n.x<6.3&&n.z>5.05)).toBe(false);
});

test('Cat centres keep their full tail and body clear of walls, and the shower is closed',()=>{
 const graph=buildPetGraph([]);
 expect([...graph.nodes.values()].some(n=>n.x>8.1&&n.z>4.06)).toBe(false);
 expect([...graph.nodes.values()].some(n=>n.x<.42&&n.z>3&&n.z<5.5)).toBe(false);
});

test('Cat navigation distinguishes carpet and rugs from hard floors',()=>{
 const items=[{id:'nap-rug',productId:'checker-rug',x:2.5,z:3.5,rotation:0,entityId:''}] satisfies Item[];
 const graph=buildPetGraph(items);
 expect([...graph.nodes.values()].some(n=>n.owner==='floor'&&Math.abs(n.x-2.5)<.5&&Math.abs(n.z-3.5)<.5&&n.softFloor)).toBe(true);
 expect([...graph.nodes.values()].some(n=>n.owner==='floor'&&n.x>5&&n.z<4&&n.softFloor)).toBe(true);
 expect([...graph.nodes.values()].some(n=>n.owner==='floor'&&n.x<4&&n.z>5&&!n.softFloor)).toBe(true);
});
