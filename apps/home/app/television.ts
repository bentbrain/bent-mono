import {APPLE_TV_ENTITY,type Hass} from './ha';
export type TelevisionMode='off'|'idle'|'playing'|'paused';
export function televisionMode(hass:Hass|undefined,preview=false):TelevisionMode{
 if(preview)return 'playing';
 if(hass?.connected===false||hass?.connection?.connected===false)return 'off';
 const state=hass?.states[APPLE_TV_ENTITY]?.state;
 return state==='playing'?'playing':state==='paused'||state==='buffering'?'paused':state==='on'||state==='idle'?'idle':'off';
}
export const TV_WIDTH=96,TV_HEIGHT=54;
/** Original animated pixel scenes, driven by playback rather than a streamed video feed. */
export function televisionPixels(mode:TelevisionMode,frame:number):Uint8Array{
 const data=new Uint8Array(TV_WIDTH*TV_HEIGHT*4);
 const scene=[0,2,1,3][Math.floor(frame/64)%4]??0;
 const pixel=(x:number,y:number,r:number,g:number,b:number)=>{const i=(y*TV_WIDTH+x)*4;data[i]=r;data[i+1]=g;data[i+2]=b;data[i+3]=255;};
 for(let y=0;y<TV_HEIGHT;y++)for(let x=0;x<TV_WIDTH;x++){
  if(mode==='off'){pixel(x,y,9,14,17);continue;}
  if(mode==='idle'){
   const tile=Math.floor((x-9)/20),row=Math.floor((y-15)/17),inTile=x>=9&&x<87&&y>=15&&y<46&&(x-9)%20<16&&(y-15)%17<13;
   pixel(x,y,inTile?55+tile*28:14,inTile?75+row*42:25,inTile?125+tile*12:49);continue;
  }
  const drift=frame/8;
  if(scene===1){
   pixel(x,y,12,19+Math.floor(y/9),48+Math.floor(y/3));
   if((x*37+y*19)%173===0)pixel(x,y,160,185,220);
   const orbitX=66+Math.floor(Math.sin(drift/5)*3);
   if((x-orbitX)**2+(y-22)**2<170)pixel(x,y,195+Math.floor(y/7)*5,112+Math.floor(y/6)*7,109);
   if(Math.abs(y-22-(x-orbitX)*.25)<2&&Math.abs(x-orbitX)<23)pixel(x,y,235,191,143);
   const shipX=(Math.floor(drift*2)%120)-12;
   if(y>=38&&y<=41&&x>=shipX&&x<shipX+10)pixel(x,y,149,211,217);
   continue;
  }
  if(scene===2){
   pixel(x,y,42+Math.floor(y/5)*4,36+Math.floor(y/6)*3,83);
   if((x-74)**2+(y-13)**2<24)pixel(x,y,249,207,174);
   const block=Math.floor(x/12),roof=18+(block*17)%18;
   if(y>roof){pixel(x,y,22+block%3*6,32,55);if(x%12>2&&x%12<9&&y%7<3)pixel(x,y,219,154+block%3*12,84);}
   if(y>47){pixel(x,y,27,36,56);if(y===51&&(x+Math.floor(drift*4))%39<7)pixel(x,y,243,109,132);}
   continue;
  }
  if(scene===3){
   pixel(x,y,17,68+Math.floor(y/6)*6,110+Math.floor(y/8)*5);
   if(y>46)pixel(x,y,188,164,111);
   for(const [offset,level] of [[0,17],[37,31],[64,24]]){
    const fishX=(Math.floor(drift*3)+offset)%120-12;
    if(((x-fishX)/7)**2+((y-level)/3)**2<1||(x>=fishX-11&&x<fishX-5&&Math.abs(y-level)<(fishX-x-4)/2))pixel(x,y,246,152+offset%60,74);
    if(x===fishX+4&&y===level-1)pixel(x,y,23,33,47);
   }
   if(y>29&&y<49&&Math.abs(x-(13+Math.sin(y/5+drift)*2))<2)pixel(x,y,43,151,117);
   continue;
  }
  if(y<29){
   const band=Math.floor(y/6);pixel(x,y,27+band*8,45+band*13,91+band*12);
   if((x-72)**2+(y-13)**2<30)pixel(x,y,255,216,160);
   const cloud=(x+Math.floor(drift))%110;if((y===12||y===13)&&cloud>14&&cloud<33)pixel(x,y,140,176,204);
  }else pixel(x,y,35,108-(y-29),132-(y-29));
  const mountain=29-Math.max(0,17-Math.abs(x-24)*.55,12-Math.abs(x-60)*.65);
  if(y>=mountain&&y<33)pixel(x,y,33,62,81);
  if(y>=33&&y<49&&(x+Math.floor(drift*2)+y*7)%29<7)pixel(x,y,71,142,155);
  if(y>=49-Math.sin(x/16)*2)pixel(x,y,22,52,50);
 }
 return data;
}
export class TelevisionClock{
 private last:number|null=null;
 private time=0;
 private mode:TelevisionMode='off';
 advance(now:number,mode:TelevisionMode):number{
  if(this.last!==null&&this.mode==='playing'&&mode==='playing')this.time+=Math.max(0,Math.min(250,now-this.last));
  if(mode==='off'||mode==='idle')this.time=0;
  this.last=now;this.mode=mode;return Math.floor(this.time/125);
 }
}
