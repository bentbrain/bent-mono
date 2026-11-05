import type {AbstractMesh} from '@babylonjs/core/Meshes/abstractMesh';
import type {Camera} from '@babylonjs/core/Cameras/camera';
import {Matrix,Vector3} from '@babylonjs/core/Maths/math.vector';
import type {Plane} from '@babylonjs/core/Maths/math.plane';

/** Conservative bounds for the full reflected viewport, including its clip plane. */
export class MirrorView {
 private readonly transform:Matrix;
 readonly frontFacing:boolean;
 constructor(camera:Camera,private readonly plane:Plane){
  this.transform=Matrix.Reflection(plane).multiply(camera.getViewMatrix()).multiply(camera.getProjectionMatrix());
  this.frontFacing=plane.signedDistanceTo(camera.globalPosition)<0;
 }
 sees(mesh:AbstractMesh):boolean{
  if(!this.frontFacing||!mesh.isEnabled()||mesh.getTotalVertices()===0)return false;
  mesh.computeWorldMatrix();
  const corners=mesh.getBoundingInfo().boundingBox.vectorsWorld;
  if(corners.every(p=>this.plane.signedDistanceTo(p)>.001))return false;
  const points=corners.map(p=>Vector3.TransformCoordinates(p,this.transform));
  // Do not crop to the pane's bounds: the reflection shader's projected UVs
  // sample the full render target. Keep a texel around the viewport boundary.
  const edge=1+2/512;
  return Math.max(...points.map(p=>p.x))>=-edge&&Math.min(...points.map(p=>p.x))<=edge&&Math.max(...points.map(p=>p.y))>=-edge&&Math.min(...points.map(p=>p.y))<=edge;
 }
}
