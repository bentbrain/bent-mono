import {expect,test} from 'bun:test';
import {FIXED_FITTINGS,FIXED_OBSTACLES} from './fixedFittings';
import {fitsRoom,canWalk,overlap} from './plan';
import {parseItems,placeable,type Item} from './editorState';

test('Fixed floor fittings stay inside the traced shell and clear of doors',()=>{
 for(const f of FIXED_FITTINGS.filter(f=>f.blocksFloor)){
  expect(fitsRoom(f.footprint),f.id).toBe(true);
  expect(FIXED_FITTINGS.some(other=>other.id!==f.id&&other.blocksFloor&&overlap(f.footprint,other.footprint)),f.id).toBe(false);
 }
});
test('New furniture cannot be placed in cabinetry or the shower in any orientation',()=>{
 for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const lamp:Item={id:'test',productId:'okensand',x:.4,z:3.3,rotation,entityId:''};
  expect(placeable(lamp,[])).toBe(false);
  expect(placeable({...lamp,x:8.5,z:4.8},[])).toBe(false);
  expect(placeable({...lamp,x:2,z:3},[])).toBe(true);
 }
});
test('A saved layout predating fittings stays recoverable and movable',()=>{
 const old:Item={id:'test',productId:'okensand',x:.5,z:3.25,rotation:0,entityId:''};
 expect(parseItems(JSON.stringify([old]))).toEqual([old]);
 expect(placeable(old,[])).toBe(false);
 expect(placeable({...old,x:2},[old])).toBe(true);
});
test('Cats avoid fixed fittings while the bathroom doorway remains passable',()=>{
 expect(canWalk({x:1,z:3.3},{x:.6,z:3.3},FIXED_OBSTACLES)).toBe(false);
 expect(canWalk({x:7.8,z:4.5},{x:8.2,z:4.5},FIXED_OBSTACLES)).toBe(false);
 expect(canWalk({x:6.8,z:3.75},{x:6.8,z:4.25},FIXED_OBSTACLES)).toBe(true);
});
