import {expect,test} from 'bun:test';
import {arrangePhotoObjects} from './photoArrangement';
import {moveItem,placeable,type Item} from './editorState';
test('Photo decorations preserve existing furniture and are idempotent and supported',()=>{
 const original:Item[]=[{id:'shelf',productId:'byakorre',x:8.75,z:1.75,rotation:1,entityId:''},{id:'sideboard',productId:'teak-sideboard',x:2.35,z:6.8,rotation:2,entityId:''}];
 const result=arrangePhotoObjects(original);
 expect(result.skipped).toEqual([]);expect(result.added).toBe(22);expect(result.items.slice(0,2)).toEqual(original);
 expect(arrangePhotoObjects(result.items).items).toEqual(result.items);
 for(const child of result.items.filter(i=>i.supportId))expect(placeable(child,result.items),child.productId).toBe(true);
 const shelf=original[0];if(!shelf)throw Error('Missing shelf');
 for(const rotation of [0,1,2,3] satisfies (0|1|2|3)[]){
  const moved=moveItem(result.items,{...shelf,x:3,z:3,rotation});
  expect(moved.filter(i=>i.supportId==='shelf')).toHaveLength(10);
  expect(moved.filter(i=>i.supportId==='shelf').every(i=>i.rotation===rotation)).toBe(true);
 }
});
test('Occupied tabletop spaces are skipped without moving existing objects',()=>{
 const table:Item={id:'sideboard',productId:'teak-sideboard',x:2.35,z:6.8,rotation:2,entityId:''};
 const lamp:Item={id:'existing-lamp',productId:'dejsa',x:1.61,z:6.8,rotation:2,entityId:'light.keep',elevation:.79,supportId:table.id};
 const result=arrangePhotoObjects([table,lamp]);expect(result.skipped).toContain('Lighthouse lamp');expect(result.items.find(i=>i.id===lamp.id)).toEqual(lamp);
});
