import type {ShadowGenerator} from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import {SmartArray} from '@babylonjs/core/Misc/smartArray';
import {Mesh} from '@babylonjs/core/Meshes/mesh';
import type {AbstractMesh} from '@babylonjs/core/Meshes/abstractMesh';
import type {SubMesh} from '@babylonjs/core/Meshes/subMesh';

interface Face {
 framebuffer:WebGLFramebuffer;
 buffers:WebGLRenderbuffer[];
 bytes:number;
 valid:boolean;
 mask:number;
}
/** Exact GPU copies of static shadow colour/depth, never a lower-resolution approximation. */
export class ShadowCachePool {
 private bytes=0;
 constructor(readonly gl:WebGL2RenderingContext,private readonly limit=48*1024*1024){}
 create(size:number,depthOnly:boolean):Face|null {
  const gl=this.gl;
  const framebuffer=gl.createFramebuffer();if(!framebuffer)return null;
  const source:unknown=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  const previousBuffer:unknown=gl.getParameter(gl.RENDERBUFFER_BINDING);
  const buffers:WebGLRenderbuffer[]=[];
  let bytes=0,mask=0,accepted=false;
  try{
   // Depth blits require identical formats. Floating shadow colour uses only
   // red (Babylon shadowMapFragment); retain its full precision, omit unused GBA.
   const bits=(attachment:number,pname:number):number=>{
    const value:unknown=gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER,attachment,pname);
    return typeof value==='number'?value:0;
   };
   const colourBits=bits(gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE);
   const colourType=bits(gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
   const depthBits=bits(gl.DEPTH_ATTACHMENT,gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE);
   const stencilBits=bits(gl.DEPTH_ATTACHMENT,gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE);
   const formats:Array<{attachment:number;format:number;bytes:number;mask:number}>=[];
   if(colourBits&&!depthOnly){
    const format=colourType===gl.FLOAT?(colourBits===16?gl.R16F:colourBits===32?gl.R32F:0):colourBits===8?gl.RGBA8:0;
    if(!format)return null;
    formats.push({attachment:gl.COLOR_ATTACHMENT0,format,bytes:colourBits/8*(colourType===gl.FLOAT?1:4),mask:gl.COLOR_BUFFER_BIT});
   }
   const depthFormat=stencilBits===8?(depthBits===32?gl.DEPTH32F_STENCIL8:gl.DEPTH24_STENCIL8):depthBits===32?gl.DEPTH_COMPONENT32F:depthBits===24?gl.DEPTH_COMPONENT24:depthBits===16?gl.DEPTH_COMPONENT16:0;
   if(!depthFormat)return null;
   formats.push({attachment:stencilBits?gl.DEPTH_STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT,format:depthFormat,bytes:depthBits===16?2:stencilBits&&depthBits===32?8:4,mask:gl.DEPTH_BUFFER_BIT});
   bytes=formats.reduce((sum,f)=>sum+f.bytes*size*size,0);
   if(this.bytes+bytes>this.limit)return null;
   gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,framebuffer);
   for(const f of formats){
    const buffer=gl.createRenderbuffer();if(!buffer)return null;buffers.push(buffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);gl.renderbufferStorage(gl.RENDERBUFFER,f.format,size,size);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER,f.attachment,gl.RENDERBUFFER,buffer);mask|=f.mask;
   }
   if(!colourBits||depthOnly)gl.drawBuffers([gl.NONE]);
   if(gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)return null;
   this.bytes+=bytes;accepted=true;
   return {framebuffer,buffers,bytes,valid:false,mask};
  }finally{
   gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,source instanceof WebGLFramebuffer?source:null);
   gl.bindRenderbuffer(gl.RENDERBUFFER,previousBuffer instanceof WebGLRenderbuffer?previousBuffer:null);
   // Failed allocations are disposed by checking whether the pool accepted them.
   if(!accepted){for(const buffer of buffers)gl.deleteRenderbuffer(buffer);gl.deleteFramebuffer(framebuffer);}
  }
 }
 copy(face:Face,size:number,restore:boolean):void {
  const gl=this.gl;
  const read:unknown=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw:unknown=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  if(!(draw instanceof WebGLFramebuffer))return;
  const scissor=gl.isEnabled(gl.SCISSOR_TEST);
  try{
   gl.disable(gl.SCISSOR_TEST);
   gl.bindFramebuffer(gl.READ_FRAMEBUFFER,restore?face.framebuffer:draw);
   gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,restore?draw:face.framebuffer);
   gl.blitFramebuffer(0,0,size,size,0,0,size,size,face.mask,gl.NEAREST);
  }finally{
   gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read instanceof WebGLFramebuffer?read:null);
   gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);
   if(scissor)gl.enable(gl.SCISSOR_TEST);
  }
 }
 release(face:Face):void {for(const buffer of face.buffers)this.gl.deleteRenderbuffer(buffer);this.gl.deleteFramebuffer(face.framebuffer);this.bytes-=face.bytes;}
}

/** Cache each cubemap face separately; morphing cats/clocks are drawn over the cached depth. */
export class StaticShadowCache {
 private faces=new Map<number,Face>();
 private faceIndex=0;
 private previousList:readonly AbstractMesh[]|null=null;
 private moving:AbstractMesh[]=[];
 private available=true;
 private readonly groups=Array.from({length:8},()=>new SmartArray<SubMesh>(128));
 constructor(private readonly pool:ShadowCachePool,shadow:ShadowGenerator){
  const map=shadow.getShadowMap();if(!map)return;
  const render=map.customRenderFunction;if(!render)return;
  map.getCustomRenderList=(face,list)=>{
   if(!this.available||!this.faces.get(face)?.valid)return null;
   if(list!==this.previousList){this.previousList=list;this.moving=list?.filter(mesh=>(mesh instanceof Mesh)&&Boolean(mesh.morphTargetManager||mesh.skeleton||mesh.hasThinInstances||mesh.instances.length))??[];}
   return this.moving;
  };
  map.onBeforeRenderObservable.add(face=>{this.faceIndex=face;});
  // Restore after the generator's clear, even when every moving caster is hidden.
  map.onClearObservable.add(()=>{const face=this.faces.get(this.faceIndex);if(this.available&&face?.valid)pool.copy(face,map.getRenderSize(),true);});
  map.customRenderFunction=(opaque,alpha,transparent,depth,before)=>{
   if(!this.available||pool.gl.isContextLost()){render(opaque,alpha,transparent,depth,before);return;}
   let face=this.faces.get(this.faceIndex);
   for(const group of this.groups)group.reset();
   let ready=true;
   for(const [index,input] of [opaque,alpha,transparent,depth].entries())for(let i=0;i<input.length;i++){
    const sub=input.data[i],mesh=sub.getRenderingMesh();
    const dynamic=Boolean(mesh.morphTargetManager||mesh.skeleton||mesh.hasThinInstances||mesh.instances.length);
    this.groups[index+(dynamic?4:0)]?.push(sub);
    if(!dynamic&&!face?.valid)ready=shadow.isReady(sub,false,index===2)&&ready;
   }
   const [so,sa,st,sd,mo,ma,mt,md]=this.groups;
   if(!so||!sa||!st||!sd||!mo||!ma||!mt||!md)return;
   if(!face){face=pool.create(map.getRenderSize(),shadow.usePercentageCloserFiltering)??undefined;if(face)this.faces.set(this.faceIndex,face);}
   if(!face){this.dispose();this.available=false;render(opaque,alpha,transparent,depth,before);return;}
   if(!face.valid){
    render(so,sa,st,sd,before);
    if(ready){pool.copy(face,map.getRenderSize(),false);face.valid=true;}
   }
   render(mo,ma,mt,md,before);
  };
 }
 invalidate():void {for(const face of this.faces.values())face.valid=false;}
 dispose():void {for(const face of this.faces.values())this.pool.release(face);this.faces.clear();this.available=true;}
}
