import {createCanvas,Image} from '@napi-rs/canvas';
import {render,loadSprites,WIDTH,HEIGHT,project} from '../app/scene.ts';
globalThis.Image=class extends Image {set src(v){super.src=v.split('?')[0];}get src(){return super.src;}};
await loadSprites('public/sprites');
const c=createCanvas(WIDTH,HEIGHT),ctx=c.getContext('2d');
render(ctx,{q:0,items:[],selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',cats:[],frame:0,hass:undefined,devices:false,vacuum:null});
const p=project({x:.3,z:5.965},0,.2),pixel=ctx.getImageData(p.x,p.y,1,1).data;
if(pixel[0]===255&&pixel[1]===255&&pixel[2]===255)throw Error(`Extruded white cutaway cap overlaps the kitchen end wall at ${p.x},${p.y}`);
console.log('PASS: no floating white cutaway cap beside the kitchen.');
