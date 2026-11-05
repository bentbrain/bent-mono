import {expect,test} from 'bun:test';
import {snap,wallPosition,placeable,type Item} from './editorState';
const item=(productId:string,x:number,z:number):Item=>({id:productId,productId,x,z,rotation:0,entityId:''});
test('Furniture can be positioned on a 5 cm grid',()=>{expect(snap({x:2.11,z:3.09})).toEqual({x:2.1,z:3.1});});
test('A TV on the living side of the internal wall clears its actual 12 cm wall mesh',()=>{
 const tv=wallPosition(item('lg-g4',4.6,3));expect(tv.x+.0272/2).toBeLessThanOrEqual(4.68);expect(placeable(tv,[])).toBe(true);
});
test('A small lamp may rest on a clear kitchen benchtop',()=>{
 expect(placeable({...item('kd27',.36,4.2),elevation:.91},[])).toBe(true);
});

import {placementAt,onSurface,placementPointerOffset} from './placement';
import {placementSurfaces} from './surfaces';
import {project,projectPlan} from './scene';
import type {CameraQuarter} from '@apartment-hotel/scene-engine';

test('Dragging a tall item preserves its grab point in every camera and in plan view',()=>{
 const furniture=item('byakorre',3,3);
 const quarters:CameraQuarter[]=[0,1,2,3];
 for(const q of quarters)for(const plan of [false,true]){
  const anchor=plan?projectPlan(furniture):project(furniture,q);
  const grab={x:anchor.x+12,y:anchor.y-75};
  const offset=placementPointerOffset(furniture,grab,q,plan);
  const placed=placementAt(furniture,{x:grab.x-offset.x,y:grab.y-offset.y},q,[],plan);
  expect(placed.x).toBe(furniture.x);expect(placed.z).toBe(furniture.z);
  const destination={...furniture,x:3.5,z:3.5},target=plan?projectPlan(destination):project(destination,q);
  const moved=placementAt(furniture,{x:grab.x+target.x-anchor.x-offset.x,y:grab.y+target.y-anchor.y-offset.y},q,[],plan);
  expect(moved.x).toBe(destination.x);expect(moved.z).toBe(destination.z);
 }
});
import {collides,parseItems,moveItem,productFor} from './editorState';
test('Clicking real tabletops places a lamp at their support height in all four views',()=>{
 for(const productId of ['table','docksta','stoppino-large','componibili','giano'])for(const q of [0,1,2,3] satisfies (0|1|2|3)[]){
  const table=item(productId,2.5,3.5),surface=placementSurfaces([table],false)[0];if(!surface)throw Error('Missing top');
  const lamp=placementAt(item('kd27',0,0),project(table,q,surface.height),q,[table]);
  expect(lamp.supportId).toBe(table.id);expect(lamp.elevation).toBeCloseTo(surface.height);expect(placeable(lamp,[table])).toBe(true);
  expect(parseItems(JSON.stringify([table,lamp]))).toEqual([table,lamp]);
 }
});
test('Shelf placements keep their exact level, enforce headroom and travel with the shelf',()=>{
 const shelf=item('byakorre',2.5,3.5),surfaces=placementSurfaces([shelf],false);
 for(const surface of surfaces){
  const lamp=onSurface(item('kd27',0,0),surface);expect(placeable(lamp,[shelf])).toBe(true);
  const moved=moveItem([shelf,lamp],{...shelf,x:3,rotation:1});expect(placeable(moved[1]??lamp,moved)).toBe(true);
 }
 const lower=surfaces[0];if(!lower)throw Error('Missing shelf');
 expect(placeable(onSurface(item('blasverk',0,0),lower),[shelf])).toBe(false);
});
test('Fixed bench support survives exports and overhanging lamp shades use their actual base',()=>{
 const bench=placementSurfaces([]).find(s=>s.id==='counter-work');if(!bench)throw Error('Missing counter');
 const lamp=onSurface(item('kd27',0,0),bench);expect(placeable(lamp,[])).toBe(true);expect(parseItems(JSON.stringify([lamp]))).toEqual([lamp]);
 const table=item('componibili',2.5,3.5),surface=placementSurfaces([table],false)[0];if(!surface)throw Error('Missing top');
 expect(placeable(onSurface(item('blasverk',0,0),surface),[table])).toBe(true);
 expect(placeable(onSurface(item('dejsa',0,0),surface),[table])).toBe(true);
});
test('Curved seating can approach closely while real body intersections remain blocked',()=>{
 const sofa=item('fireside',2.5,3.5),chair=item('dyvlinge',3.67,4.25);
 expect(collides(chair,sofa)).toBe(false);expect(placeable(chair,[sofa])).toBe(true);
 expect(collides({...chair,x:3.5,z:3.8},sofa)).toBe(true);
});
test('All Sonos defaults and earlier black selections become white',()=>{
 for(const id of ['era300','era300-stand','arc-ultra','sub4']){
  expect(productFor(id)?.finishes?.[0]?.id).toBe('white');
  expect(parseItems(JSON.stringify([{...item(id,2.5,3.5),finish:'black'}]),true)[0]?.finish).toBe('white');
 }
});

test('TV clicks near an internal wall end stay on that wall',()=>{const tv=wallPosition(item('lg-g4',4.68,3.4));expect(tv.x).toBeCloseTo(4.6624);expect(tv.z).toBeCloseTo(3.389);expect(placeable(tv,[])).toBe(true);});

import {surfacePosition,slideOnSurface} from './surfacePosition';
test('A bedside lamp slides to either end of a rotated shelf and keeps its attachment',()=>{
 for(const rotation of [0,1,2,3] satisfies (0|1|2|3)[]){
  const shelf={...item('byakorre',2.5,3.5),rotation},top=placementSurfaces([shelf],false).at(-1);if(!top)throw Error('Missing shelf');
  const lamp=onSurface({...item('blasverk',0,0),rotation},top);
  for(const side of [-.6,.6]){
   const slid=slideOnSurface(lamp,[shelf,lamp],side,0),support=surfacePosition(slid,[shelf,slid]);
   expect(support?.x).toBeCloseTo(side);expect(slid.elevation).toBe(1.39);expect(slid.supportId).toBe(shelf.id);expect(slid.supportSurface).toBe(top.id);expect(placeable(slid,[shelf])).toBe(true);
   const moved=moveItem([shelf,slid],{...shelf,x:3});const child=moved.find(i=>i.id===lamp.id);if(!child)throw Error('Missing lamp');
   expect(surfacePosition(child,moved)?.x).toBeCloseTo(side);expect(parseItems(JSON.stringify(moved))).toEqual(moved);
  }
  expect(placeable(slideOnSurface(lamp,[shelf,lamp],1,0),[shelf])).toBe(false);
 }
});
