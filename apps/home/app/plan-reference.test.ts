import {test,expect} from 'bun:test';
import {ZONES,WALLS,onFloor,fitsRoom} from './plan';
// Observations from listing bedroom photos 05/06 and the published floorplan.
test('Bedroom floor matches the photographed carpet',()=>{expect(ZONES.find(z=>z.id==='bedroom')?.material).toBe('carpet');});
test('Bedroom exterior opening is a raised window, not full-height glazing',()=>{expect(WALLS.some(w=>w.a.z===0&&w.b.z===0&&w.kind==='window')).toBe(true);});
test('Bedroom ensuite slider stays an opening, not glazing',()=>{expect(WALLS.some(w=>w.kind==='glass'&&w.a.z===4&&w.b.z===4)).toBe(false);});

test('Laundry and cupboard interiors are voids behind closed wall fronts',()=>{
 expect(ZONES.some(z=>z.id==='laundry'||z.id==='cupboard')).toBe(false);
 for(const p of [{x:5.3,z:6.4},{x:5.3,z:5.35},{x:6.05,z:5.35}]){
  expect(onFloor(p)).toBe(false);expect(fitsRoom({...p,w:.2,d:.2})).toBe(false);
 }
 expect(WALLS.filter(w=>w.kind==='closed-door')).toHaveLength(3);
 expect(onFloor({x:4.2,z:6.4})).toBe(true);
});
