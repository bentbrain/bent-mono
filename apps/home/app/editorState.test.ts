import {test,expect} from 'bun:test';
import {bounds,placeable,parseItems,type Item} from './editorState';
import {project,unproject} from './scene';
import {canWalk} from './plan';
import {lightState} from './ha';
import {addLeaningMirror} from './mirrorArrangement';
import {ENTRY_RACK_Z,onFloor} from './plan';
const bench:Item={id:'bench',productId:'perjohan',x:2,z:3,rotation:0,entityId:''};
test('Custom material settings round-trip and reject invalid values',()=>{
 const item={...bench,materialColor:'#AAbBcC',materialGloss:.65};
 expect(parseItems(JSON.stringify([item]))[0]).toEqual({...item,materialColor:'#aabbcc'});
 for(const patch of [{materialColor:'red'},{materialColor:'#fff'},{materialGloss:-.1},{materialGloss:1.1},{materialGloss:'1'}])expect(()=>parseItems(JSON.stringify([{...bench,...patch}]))).toThrow();
});
test('Recess carries the door rack without moving furniture and mirror addition is idempotent',()=>{
 const rack={id:'rack',productId:'hang-it-all',x:4.1,z:6.98,rotation:2,entityId:'',elevation:1.55};
 const parsed=parseItems(JSON.stringify([bench,rack]));expect(parsed[0]).toEqual(bench);expect(parsed[1]?.z).toBe(ENTRY_RACK_Z);expect(onFloor({x:4.1,z:7.3})).toBe(true);
 const result=addLeaningMirror(parsed);expect(result).toHaveLength(3);expect(result[0]).toEqual(bench);expect(addLeaningMirror(result)).toEqual(result);
});
test('Pointer projection round-trips all four angles',()=>{for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[])for(const p of [{x:1,z:3},{x:7,z:2},{x:5.25,z:6.25}]){const actual=unproject(project(p,q),q);expect(actual.x).toBeCloseTo(p.x,2);expect(actual.z).toBeCloseTo(p.z,2);}});
test('Rotation changes the physical footprint',()=>{expect(bounds(bench).w).toBe(1);expect(bounds({...bench,rotation:1}).d).toBe(1);expect(bounds({...bench,rotation:1}).w).toBe(.28);});
test('Placement respects walls, doors, missing floor and existing furniture',()=>{expect(placeable(bench,[])).toBe(true);expect(placeable({...bench,x:4.75},[])).toBe(false);expect(placeable({...bench,x:4.25,z:7},[])).toBe(false);expect(placeable({...bench,x:8,z:6.5},[])).toBe(false);expect(placeable({...bench,id:'other'},[bench])).toBe(false);});
test('Imported layouts cannot smuggle collisions or invalid coordinates',()=>{expect(parseItems(JSON.stringify([bench]))).toEqual([bench]);expect(()=>parseItems(JSON.stringify([bench,bench]))).toThrow();expect(()=>parseItems(JSON.stringify([{...bench,rotation:8}]))).toThrow();expect(()=>parseItems(JSON.stringify([{...bench,x:500}]))).toThrow();});
test('Cats cannot cross the bedroom wall but can use its door',()=>{expect(canWalk({x:4.5,z:2},{x:5,z:2},[])).toBe(false);expect(canWalk({x:5.5,z:4.25},{x:5.5,z:3.75},[])).toBe(true);});
test('Unavailable lights never masquerade as off or on',()=>{expect(lightState(undefined).state).toBe('unavailable');expect(lightState({entity_id:'light.test',state:'off',attributes:{brightness:255}}).brightness).toBe(0);expect(lightState({entity_id:'light.test',state:'on',attributes:{brightness:128,rgb_color:[12,34,56]}})).toEqual({state:'on',brightness:128/255,color:'rgb(12,34,56)'});});
