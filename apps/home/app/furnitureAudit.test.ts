import {expect,test} from 'bun:test';
import {CATALOG,baseHeight,bounds,collides,moveItem,parseItems,placeable,wallPosition,type Item} from './editorState';
import {sceneLights,DEFAULT_ENVIRONMENT} from './lighting';
import {placementSurfaces,buildPetGraph} from './surfaces';
const make=(productId:string,id=productId):Item=>({id,productId,x:2.5,z:3.5,rotation:0,entityId:''});
test('Model dimensions preserve the variants without disclosing purchase provenance',()=>{
 for(const [id,w,d,h] of [['teak-sideboard',1.815,.425,.79],['byakorre',1.7,.32,1.57],['fireside',1.8,1,.7],['lg-g4',1.222,.0272,.703],['rimforsa',1.2,.635,.92],['magazine-rack',.4,.185,.4]] satisfies [string,number,number,number][]){
  const p=CATALOG.find(p=>p.id===id);expect(p?.w).toBe(w);expect(p?.d).toBe(d);expect(p?.h).toBe(h);expect(p?.url).toBeUndefined();expect(p?.source).toBe('Scene model');expect(p?.purchased).toBe(false);
 }
 expect(CATALOG.find(p=>p.id==='magazine-rack')?.note).toBeUndefined();
});
test('Rugs accept furniture without permitting ordinary collisions or two rugs in the same place',()=>{
 const rug=make('checker-rug'),sofa=make('fireside');expect(placeable(rug,[sofa])).toBe(true);expect(placeable(sofa,[rug])).toBe(true);
 expect(placeable({...sofa,id:'second'},[sofa])).toBe(false);expect(placeable({...rug,id:'second'},[rug])).toBe(false);
 expect(buildPetGraph([rug],false).volumes.some(v=>v.owner===rug.id)).toBe(false);
});
test('Different Stoppino sizes nest, preserve identity and can move independently',()=>{
 const small=make('stoppino-small'),large=make('stoppino-large');expect(placeable(small,[large])).toBe(true);
 expect(placeable({...small,id:'duplicate'},[small])).toBe(false);expect(collides({...small,x:2.6},large)).toBe(true);
 const moved=moveItem([small,large],{...small,x:3.5});expect(moved.find(i=>i.id===large.id)).toEqual(large);
 expect(parseItems(JSON.stringify([small,large]))).toEqual([small,large]);
});
test('Materials, mounting heights and support relationships survive a layout round trip',()=>{
 const table=make('docksta'),lamp={...make('blasverk'),elevation:.75,finish:'yellow',supportId:table.id};
 expect(parseItems(JSON.stringify([table,lamp]))).toEqual([table,lamp]);
 expect(()=>parseItems(JSON.stringify([{...lamp,finish:'invalid'}]))).toThrow();
 expect(()=>parseItems(JSON.stringify([{...lamp,supportId:lamp.id}]))).toThrow();
 expect(()=>parseItems(JSON.stringify([{...lamp,elevation:-1}]))).toThrow();
 expect(()=>parseItems(JSON.stringify([{...lamp,elevation:2.6}]))).toThrow();
});
test('Moving and rotating a support carries its lamp and emitter in every rotation',()=>{
 const table=make('docksta'),lamp={...make('blasverk'),x:2.7,elevation:.75,supportId:table.id};
 for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const changed=moveItem([table,lamp],{...table,x:3,rotation}),moved=changed.find(i=>i.id===lamp.id);if(!moved)throw Error('Lost lamp');
  expect(moved.x).toBeCloseTo(3+.2*Math.cos(rotation*Math.PI/2));expect(moved.z).toBeCloseTo(3.5+.2*Math.sin(rotation*Math.PI/2));
  expect(placeable(moved,changed)).toBe(true);expect(baseHeight(moved)).toBe(.75);
  expect(sceneLights(changed,undefined,DEFAULT_ENVIRONMENT).find(l=>l.ownerId===lamp.id)?.height).toBeCloseTo(1.035);
 }
});
test('Wall attachments snap to the room side without changing dimensions',()=>{
 for(const [x,z] of [[4.5,2.5],[8.8,2],[2,7]] ){
  if(x===undefined||z===undefined)throw Error('Missing test coordinates');
  const tv=wallPosition({...make('lg-g4'),x,z});expect(placeable(tv,[])).toBe(true);expect(baseHeight(tv)).toBe(.95);
  expect(Math.min(bounds(tv).w,bounds(tv).d)).toBe(.0272);
 }
});
test('Photo corrections preserve stored layouts even when a larger audited footprint needs rearranging',()=>{
 const old=[{...make('byakorre'),x:2},{...make('casalino'),x:2.95}];
 expect(()=>parseItems(JSON.stringify(old))).toThrow();expect(parseItems(JSON.stringify(old),true)).toEqual(old);
});
test('Only load-bearing furniture gets cat landing surfaces; low seats and shelves remain available',()=>{
 for(const productId of ['checker-rug','era300','era300-stand','arc-ultra','sub4','lg-g4','totem','kd27','magazine-rack'])expect(placementSurfaces([make(productId)],false)).toEqual([]);
 for(const productId of ['fireside','casalino','docksta','stoppino-small','rimforsa','teak-sideboard'])expect(placementSurfaces([make(productId)],false).length).toBe(1);
});

test('Ceiling downlights can be placed over floor furniture, preserve binding and have no cat surface',()=>{
 const light={...make('downlight'),entityId:'light.example_living_downlight_1'},table=make('docksta');
 expect(baseHeight(light)).toBe(2.675);expect(placeable(light,[table])).toBe(true);
 expect(parseItems(JSON.stringify([table,light]))).toEqual([table,light]);
 expect(placementSurfaces([light],false)).toEqual([]);
 const sources=sceneLights([light],undefined,DEFAULT_ENVIRONMENT).filter(l=>l.entityId===light.entityId);
 expect(sources).toHaveLength(1);expect(sources[0]?.kind).toBe('spot');expect(sources[0]?.ownerId).toBe(light.id);
});

test('Stoppino tabletop objects sit inside the raised rim, including older saved placements',()=>{
 const table=make('stoppino-large'),lamp={...make('kd27'),supportId:table.id,elevation:.42};
 const restored=parseItems(JSON.stringify([table,lamp]),true);expect(restored[1]?.elevation).toBeCloseTo(.394);
 expect(placeable(restored[1]??lamp,restored)).toBe(true);
 expect(placementSurfaces([table],false)[0]?.height).toBeCloseTo(.394);
});

test('Hommey bedding survives save/import without changing the bed frame finish',()=>{
 for(const bedding of ['spearmint','rhubarb']){
  const bed={...make('kirribilli'),bedding};
  expect(parseItems(JSON.stringify([bed]))).toEqual([bed]);
  expect(parseItems(JSON.stringify([bed]),true)).toEqual([bed]);
 }
 expect(()=>parseItems(JSON.stringify([{...make('kirribilli'),bedding:'unknown'}]))).toThrow('Invalid bedding');
 expect(()=>parseItems(JSON.stringify([{...make('casalino'),bedding:'rhubarb'}]))).toThrow('Invalid bedding');
});
