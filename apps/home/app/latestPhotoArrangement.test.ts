import {expect,test} from 'bun:test';
import {arrangeLatestPhotos} from './latestPhotoArrangement';
import {moveItem,placeable,type Item} from './editorState';
import {furnitureSurfaces} from './supportGeometry';
import {productFor} from './editorState';

test('Latest photos retain furniture IDs and positions, attach island props and avoid duplicates',()=>{
 const original:Item[]=[{id:'island',productId:'rimforsa',x:1.7,z:3.2,rotation:3,entityId:''},{id:'sofa',productId:'fireside',x:2.8,z:3.1,rotation:3,entityId:''},{id:'chair',productId:'dyvlinge',x:3.6,z:1.85,rotation:0,entityId:''}];
 const result=arrangeLatestPhotos(original);expect(result.skipped).toEqual([]);expect(result.added).toBe(8);expect(result.dressed).toBe(2);
 for(const old of original){const next=result.items.find(i=>i.id===old.id);expect(next).toEqual({...old,productId:old.productId==='rimforsa'?old.productId:old.productId+'-dressed'});}
 expect(arrangeLatestPhotos(result.items).items).toEqual(result.items);
 const island=original[0];if(!island)throw Error('Missing island');
 for(const rotation of [0,1,2,3] satisfies (0|1|2|3)[]){
  const moved=moveItem(result.items,{...island,x:3,z:5,rotation});
  const props=moved.filter(i=>i.supportId==='island');expect(props).toHaveLength(4);expect(props.every(i=>i.rotation===rotation)).toBe(true);
 }
 for(const id of ['fireside','dyvlinge']){
  const plain=productFor(id),dressed=productFor(id+'-dressed');if(!plain||!dressed)throw Error('Missing product');
  const item:Item={id:'seat',productId:id,x:3,z:3,rotation:1,entityId:''};
  expect(furnitureSurfaces({...item,productId:dressed.id},dressed)).toEqual(furnitureSurfaces(item,plain));
 }
});
test('A blocked island position skips the prop and retains existing contents',()=>{
 const original:Item[]=[{id:'island',productId:'rimforsa',x:1.7,z:3.2,rotation:3,entityId:''},{id:'keep',productId:'paper-towel',x:1.66,z:3.66,rotation:3,entityId:'',elevation:.92,supportId:'island'}];
 const result=arrangeLatestPhotos(original);expect(result.items.find(i=>i.id==='keep')).toEqual(original[1]);expect(result.skipped).toContain('DeLonghi blue kettle');
 expect(result.items.filter(i=>i.productId==='paper-towel')).toHaveLength(1);
 expect(result.items.filter(i=>i.supportId==='island').every(i=>placeable(i,result.items))).toBe(true);
});
