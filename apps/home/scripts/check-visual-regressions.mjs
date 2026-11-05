import {createCanvas,Image} from '@napi-rs/canvas';
import {render,loadSprites,WIDTH,HEIGHT,project} from '../app/scene.ts';
globalThis.Image=class extends Image {set src(v){super.src=v.split('?')[0];}get src(){return super.src;}};
await loadSprites('public/sprites');
const c=createCanvas(WIDTH,HEIGHT),ctx=c.getContext('2d');
for(const q of [0,1,2,3]){
 render(ctx,{q,items:[],selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats:[],frame:0,hass:undefined,devices:false,vacuum:null});
 const p=project({x:5.1,z:1.325},q,2.4),pixel=ctx.getImageData(p.x,p.y,1,1).data;
 if(pixel[0]!==98||pixel[1]!==104||pixel[2]!==101)throw Error(`Wardrobe top is missing in view ${q}: ${pixel.slice(0,3)}`);
}
console.log('PASS: solid wardrobe top is visible at the correct height in all four views.');
