import {baseHeight,placeable,productFor,wallPosition,type Item} from './editorState';
import {rotateAroundOrigin} from '@apartment-hotel/scene-engine';

/** Add the photographed decorations without moving existing furniture or replacing props. */
export function arrangePhotoObjects(original:readonly Item[]):{items:Item[];added:number;skipped:string[]} {
 const items=[...original],skipped:string[]=[];
 const add=(item:Item)=>{
  if(items.some(existing=>existing.id===item.id))return;
  if(placeable(item,items)){items.push(item);}else skipped.push(productFor(item.productId)?.name??item.productId);
 };
 const decorate=(parent:Item,productId:string,x:number,z:number,level:number,shelf?:number)=>{
  const p=rotateAroundOrigin({x,z},parent.rotation);
  const surface=shelf===undefined?`${parent.id}-support`:`${parent.id}-shelf-${shelf}`;
  add({id:`photo-${parent.id}-${productId}`,productId,x:parent.x+p.x,z:parent.z+p.z,rotation:parent.rotation,entityId:'',elevation:baseHeight(parent)+level,supportId:parent.id,supportSurface:surface});
 };
 for(const parent of original){
  if(parent.productId==='teak-sideboard'){
   for(const [id,x] of [['pastel-catchalls',-.72],['sideboard-tablet',-.4],['ceramic-pig',-.06],['black-ink-pot',.19],['sideboard-papers',.43],['lighthouse-lamp',.74]] satisfies [string,number][]){decorate(parent,id,x,0,.79);}
   for(const [id,x,h] of [['orange-cat-clock',-.94,1.42],['forest-frame',-.39,1.47],['dark-poster-frame',.40,1.2]] satisfies [string,number,number][]){
    const offset=rotateAroundOrigin({x,z:-.20},parent.rotation);
    add(wallPosition({id:`photo-${parent.id}-${id}`,productId:id,x:parent.x+offset.x,z:parent.z+offset.z,rotation:parent.rotation,entityId:'',elevation:h}));
   }
  }
  if(parent.productId==='byakorre'){
   for(const [id,x,shelf] of [['shelf-plant',-.60,3],['amber-glassware',-.17,3],['book-stack-pale',-.60,2],['large-art-book',-.275,2],['book-stack-colour',.08,2],['orange-shelf-cubby',.55,2],['eagle-display-plate',-.65,1],['shelf-figurines',-.16,1],['jewellery-tray',.50,1],['shelf-shoes',0,0]] satisfies [string,number,number][]){
    const level=[.30,.66,1.025,1.39][shelf];if(level!==undefined)decorate(parent,id,x,0,level,shelf);
   }
  }
 }
 if(!items.some(i=>i.productId==='plant-trolley'))add({id:'photo-entry-plant-trolley',productId:'plant-trolley',x:4.28,z:5.32,rotation:1,entityId:''});
 const trolley=items.find(i=>i.productId==='plant-trolley');if(trolley)decorate(trolley,'fiddle-leaf',0,0,.31);
 if(!items.some(i=>i.productId==='hang-it-all'))add(wallPosition({id:'photo-entry-hang-it-all',productId:'hang-it-all',x:4.1,z:6.98,rotation:2,entityId:'',elevation:1.55}));
 return {items,added:items.length-original.length,skipped};
}
