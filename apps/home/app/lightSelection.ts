import type {AbstractMesh} from '@babylonjs/core/Meshes/abstractMesh';
import {Material} from '@babylonjs/core/Materials/material';
import {PointLight} from '@babylonjs/core/Lights/pointLight';
import {SpotLight} from '@babylonjs/core/Lights/spotLight';
import {Vector3} from '@babylonjs/core/Maths/math.vector';
import type {Light} from '@babylonjs/core/Lights/light';
import type {Scene} from '@babylonjs/core/scene';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial';
import {PBRMaterial} from '@babylonjs/core/Materials/PBR/pbrMaterial';
/** glTF's loader raises existing materials to scene.lights.length, even for asset containers. */
export function enforceLightBudget(scene:Scene):void{
 const available=scene.getEngine().getCaps().maxTexturesImageUnits;
 const budget=Math.max(1,Math.min(12,(available||16)-4));
 for(const material of scene.materials)if((material instanceof StandardMaterial)||(material instanceof PBRMaterial)){
  if(material.maxSimultaneousLights>budget)material.maxSimultaneousLights=budget;
  // An old program can have incompatible morph/clip-plane inputs after a view
  // change. WebKit rejects that draw; wait for the matching program instead.
  material.allowShaderHotSwapping=false;
 }
}
/** Spend each mesh's shader slots on nearby lights, not creation order. */
export function prioritizeRoomLights(scene:Scene,nominalIntensity?:ReadonlyMap<Light,number>):void{
 for(const mesh of scene.meshes){
  if(!mesh.isEnabled()||mesh.getTotalVertices()===0||!mesh.material)continue;
  mesh.computeWorldMatrix(true);
  const centre=mesh.getBoundingInfo().boundingBox.centerWorld;
  function contribution(light:Light):number{
   const intensity=nominalIntensity?.get(light)??light.intensity;
   if(intensity<=0)return -1;
   if(!((light instanceof PointLight)||(light instanceof SpotLight)))return 1e6;
   const delta=centre.subtract(light.position),distance=delta.length();
   if(distance>=light.range)return 0;
   let cone=1;
   if((light instanceof SpotLight)&&distance>.001){const alignment=Vector3.Dot(delta.scale(1/distance),light.direction.normalizeToNew());cone=Math.max(0,(alignment-Math.cos(light.angle/2))/(1-Math.cos(light.angle/2)));}
   return intensity*cone*Math.max(0,1-(distance/light.range)**4)/Math.max(.04,distance*distance);
  }
  const scores=new Map(mesh.lightSources.map(light=>[light,contribution(light)]));
  const ranked=[...mesh.lightSources].sort((a,b)=>(scores.get(b)??0)-(scores.get(a)??0));
  if(ranked.some((light,index)=>light!==mesh.lightSources[index])){
   mesh.lightSources.splice(0,mesh.lightSources.length,...ranked);
   mesh.material.markAsDirty(Material.LightDirtyFlag);
  }
 }
}

/** A caster outside a light's range cannot shadow a receiver inside that range. */
export function withinLightRange(mesh:AbstractMesh,light:PointLight|SpotLight):boolean{
 mesh.computeWorldMatrix(true);
 const box=mesh.getBoundingInfo().boundingBox,p=light.position;
 const dx=Math.max(box.minimumWorld.x-p.x,0,p.x-box.maximumWorld.x);
 const dy=Math.max(box.minimumWorld.y-p.y,0,p.y-box.maximumWorld.y);
 const dz=Math.max(box.minimumWorld.z-p.z,0,p.z-box.maximumWorld.z);
 return dx*dx+dy*dy+dz*dz<=light.range*light.range;
}
