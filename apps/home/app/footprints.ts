import type {Item,Product} from './editorState';
import type {Point} from './plan';
function outline(item:Item,p:Product):Point[]{
 if(p.baseModel){const {baseModel,...base}=p;return outline(item,{...base,id:baseModel});}
 const points:Point[]=[];
 if(p.id==='dyvlinge')for(let i=0;i<32;i++){const t=i*Math.PI/16;points.push({x:Math.cos(t)*p.w/2,z:Math.sin(t)*p.d/2});}
 else if(p.id==='fireside')for(const [cx,cz,start] of [[p.w/2-.10,p.d/2-.10,0],[-p.w/2+.10,p.d/2-.10,90],[-p.w/2+.10,-p.d/2+.10,180],[p.w/2-.10,-p.d/2+.10,270]] satisfies [number,number,number][]){for(let i=0;i<=8;i++){const a=(start+i*90/8)*Math.PI/180;points.push({x:cx+.10*Math.cos(a),z:cz+.10*Math.sin(a)});}}
 else points.push({x:-p.w/2,z:-p.d/2},{x:p.w/2,z:-p.d/2},{x:p.w/2,z:p.d/2},{x:-p.w/2,z:p.d/2});
 const t=item.rotation*Math.PI/2;return points.map(v=>({x:item.x+v.x*Math.cos(t)-v.z*Math.sin(t),z:item.z+v.x*Math.sin(t)+v.z*Math.cos(t)}));
}
/** Convex plan silhouettes permit close curved corners without permitting solid intersections. */
export function footprintsOverlap(a:Item,pa:Product,b:Item,pb:Product):boolean{
 const first=outline(a,pa),second=outline(b,pb);
 for(const points of [first,second])for(let i=0;i<points.length;i++){
  const p=points[i],q=points[(i+1)%points.length];if(!p||!q)continue;
  const length=Math.hypot(q.x-p.x,q.z-p.z),nx=-(q.z-p.z)/length,nz=(q.x-p.x)/length;
  const av=first.map(v=>v.x*nx+v.z*nz),bv=second.map(v=>v.x*nx+v.z*nz);
  if(Math.max(...av)<=Math.min(...bv)+.001||Math.max(...bv)<=Math.min(...av)+.001)return false;
 }
 return true;
}
