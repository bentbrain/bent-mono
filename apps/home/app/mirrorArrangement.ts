import {placeable,type Item} from './editorState';
/** The short return wall between the kitchen and the sideboard. */
export function addLeaningMirror(items:readonly Item[]):Item[]{
 if(items.some(i=>i.productId==='ikornnes'))return [...items];
 const mirror:Item={id:'photo-ikornnes',productId:'ikornnes',x:.73,z:6.27,rotation:3,entityId:'',finish:'ash'};
 return placeable(mirror,items)?[...items,mirror]:[...items];
}
