import {createCanvas,Image} from '@napi-rs/canvas';
import {render,renderPlan,loadSprites,WIDTH,HEIGHT} from '../app/scene.ts';
// Native Canvas implements the browser drawing API for deterministic offline art QA.
globalThis.Image=class extends Image {set src(value){super.src=value.split('?')[0];}get src(){return super.src;}};
await loadSprites('public/sprites');
const native=createCanvas(WIDTH,HEIGHT),ctx=native.getContext('2d');
const canvas=createCanvas(WIDTH*2,HEIGHT*2),all=canvas.getContext('2d');
const items=[{id:'bed',productId:'kirribilli',x:7.25,z:1.75,rotation:0,entityId:''},{id:'chair',productId:'dyvlinge',x:3.5,z:3,rotation:1,entityId:''},{id:'bench',productId:'perjohan',x:2.5,z:4.5,rotation:0,entityId:''},{id:'shelf',productId:'byakorre',x:2.25,z:2.25,rotation:0,entityId:''},{id:'lamp',productId:'okensand',x:3.75,z:4.75,rotation:0,entityId:''}];
const cats=[{id:'pearl',x:2.5,z:3,direction:0,animation:'walk'},{id:'maree',x:3,z:5,direction:1,animation:'groom'}];
for(const furnished of [false,true]){
 for(const q of [0,1,2,3]){render(ctx,{q,items:furnished?items:[],selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats:furnished?cats:[],frame:0,hass:undefined,devices:false,vacuum:null});all.drawImage(native,(q%2)*WIDTH,Math.floor(q/2)*HEIGHT);}
 await Bun.write(`runs/assets/${furnished?'furnished':'shell'}-review.png`,canvas.toBuffer('image/png'));
}
renderPlan(ctx,[],null);await Bun.write('runs/assets/plan-review.png',native.toBuffer('image/png'));
console.log('Rendered actual scene: empty, furnished, all four angles, top-down plan.');

render(ctx,{q:0,items:[],selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats:[],frame:0,hass:undefined,devices:false,vacuum:null});await Bun.write('runs/assets/fittings-apartment.png',native.toBuffer('image/png'));
