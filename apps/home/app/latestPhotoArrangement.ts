import {baseHeight,collides,placeable,productFor,wallPosition,type Item} from './editorState';
import {rotateAroundOrigin} from '@apartment-hotel/scene-engine';

/** September 11 additions are one edit. Never move existing furniture to make room. */
export function arrangeLatestPhotos(original:readonly Item[]):{items:Item[];added:number;dressed:number;skipped:string[]} {
 const items=[...original],skipped:string[]=[];let dressed=0;
 const add=(item:Item)=>{
  if(items.some(i=>i.id===item.id||i.productId===item.productId))return;
  if(placeable(item,items))items.push(item);else skipped.push(productFor(item.productId)?.name??item.productId);
 };
 for(const parent of original){
  if(parent.productId==='rimforsa')for(const [productId,x] of [['delonghi-kettle',-.46],['breville-barista',-.085],['paper-towel',.225],['island-fern',.435]] satisfies [string,number][]){
   const p=rotateAroundOrigin({x,z:-.04},parent.rotation);
   add({id:`photo11-${parent.id}-${productId}`,productId,x:parent.x+p.x,z:parent.z+p.z,rotation:parent.rotation,entityId:'',elevation:baseHeight(parent)+.92,supportId:parent.id,supportSurface:`${parent.id}-support`});
  }
  if(parent.productId==='fireside'||parent.productId==='dyvlinge'){
   const next={...parent,productId:parent.productId+'-dressed'};
   if(!items.some(i=>collides(next,i)&&!collides(parent,i))){const index=items.findIndex(i=>i.id===parent.id);items[index]=next;dressed++;}
   else skipped.push(productFor(next.productId)?.name??next.productId);
  }
 }
 add({id:'photo11-numero-high',productId:'numero-high',x:8.43,z:3.04,rotation:1,entityId:''});
 add({id:'photo11-numero-low',productId:'numero-low',x:7.52,z:3.47,rotation:2,entityId:''});
 add({id:'photo11-carrot',productId:'carrot-scratcher',x:3.75,z:3.65,rotation:0,entityId:''});
 add(wallPosition({id:'photo11-linen-art',productId:'linen-wall-art',x:5.13,z:4.98,rotation:2,entityId:'',elevation:1.22}));
 return {items,added:items.length-original.length,dressed,skipped};
}
