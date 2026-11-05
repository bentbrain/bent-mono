import {Color3} from '@babylonjs/core/Maths/math.color';
import {Mesh} from '@babylonjs/core/Meshes/mesh';
import {MeshBuilder} from '@babylonjs/core/Meshes/meshBuilder';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial';
import {Vector3} from '@babylonjs/core/Maths/math.vector';
import type {Scene} from '@babylonjs/core/scene';
import {WALLS,ZONES,ENTRY_RECESS,wallBounds,type Wall,type Rect} from './plan';
export const HEIGHT_SCALE=60.72/(48*Math.sqrt(1.5));
export const CAMERA_LAYER=1,SHADOW_LAYER=2;
export interface WallPart {mesh:Mesh;wall:Wall;low:number;high:number}
export interface Shell {walls:WallPart[];casters:Mesh[];grids:Mesh[];meshes:Mesh[]}
export function makeShell(scene:Scene):Shell {
 const materials=new Map<string,StandardMaterial>(),walls:WallPart[]=[],casters:Mesh[]=[],grids:Mesh[]=[],meshes:Mesh[]=[];
 function material(color:string):StandardMaterial {
  const existing=materials.get(color);if(existing)return existing;
  const m=new StandardMaterial(color,scene);m.diffuseColor=Color3.FromHexString(color);m.specularColor=Color3.Black();m.maxSimultaneousLights=12;materials.set(color,m);return m;
 }
 function box(name:string,r:Rect,bottom:number,top:number,color:string):Mesh{
  const mesh=MeshBuilder.CreateBox(name,{width:r.w,depth:r.d,height:(top-bottom)*HEIGHT_SCALE},scene);
  mesh.position.set(r.x+r.w/2,(top+bottom)*HEIGHT_SCALE/2,r.z+r.d/2);mesh.material=material(color);mesh.receiveShadows=true;mesh.layerMask=CAMERA_LAYER;meshes.push(mesh);return mesh;
 }
 const floors=new Map<string,Mesh[]>();
 for(const zone of ZONES){
  box(`slab-${zone.id}`,zone,-.12,-.015,'#8b958c');
  const step=zone.material==='oak'?.18:zone.material==='tile'?.3:zone.material==='carpet'?.5:.6;
  const width=zone.material==='oak'?1.8:step;
  const gap=zone.material==='carpet'?0:.006;
  for(let z=0,row=0;z<zone.d-.001;z+=step,row++)for(let x=0,col=0;x<zone.w-.001;x+=width,col++){
   const colors=zone.material==='oak'?['#ac805d','#b68a64','#bd946f']:zone.material==='tile'?['#515954','#626865']:zone.material==='carpet'?['#7d8479','#7f857b','#7c8278','#7e847a']:['#b2b5a5','#c7c8be'];
   const color=colors[(row*7+col*3)%colors.length]??'#89908b';
   const mesh=box('floor',{x:zone.x+x+gap,z:zone.z+z+gap,w:Math.min(width,zone.w-x)-gap*2,d:Math.min(step,zone.d-z)-gap*2},-.02,0,color);
   const group=floors.get(color)??[];group.push(mesh);floors.set(color,group);
  }
  // The covered balcony uses the same estimated 2.7 m soffit as the interior.
  // All roofs remain shadow-only, including in full-wall view.
  {
   const roof=box(`ceiling-shadow-${zone.id}`,zone,2.70,2.78,'#ffffff');roof.layerMask=SHADOW_LAYER;casters.push(roof);
  }
  const lines:Vector3[][]=[];
  for(let x=.25;x<zone.w;x+=.25)lines.push([new Vector3(zone.x+x,.006,zone.z),new Vector3(zone.x+x,.006,zone.z+zone.d)]);
  for(let z=.25;z<zone.d;z+=.25)lines.push([new Vector3(zone.x,.006,zone.z+z),new Vector3(zone.x+zone.w,.006,zone.z+z)]);
  const grid=MeshBuilder.CreateLineSystem('grid',{lines},scene);grid.color=Color3.FromHexString('#ead39d');grids.push(grid);grid.setEnabled(false);
 }
 for(const [color,list] of floors){const merged=Mesh.MergeMeshes(list,true,true);if(merged){merged.name='floor-'+color;merged.receiveShadows=true;meshes.push(merged);}}
 for(const [index,w] of WALLS.entries()){
  if(w.kind==='robe')continue;
  const vertical=Math.abs(w.b.x-w.a.x)<.01;
  const r=wallBounds(w);
  function part(low:number,high:number,color:string,cast=true){
   const mesh=box(`wall-${index}`,r,low,high,color);walls.push({mesh,wall:w,low,high});
   if(cast){const shadow=mesh.clone(`wall-shadow-${index}`);shadow.layerMask=SHADOW_LAYER;casters.push(shadow);}
  }
  if(w.kind==='glass'||w.kind==='rail'||w.kind==='window'){
   const window=w.kind==='window',low=window?1.65:0,high=window?2.16:w.kind==='rail'?1.05:2.42;
   if(window){part(0,1.65,'#e5e3dc');part(2.16,2.7,'#f6f5ee');}
   const divisions=window?4:w.kind==='glass'?3:4;
   for(let i=0;i<=divisions;i++){
    const p={x:w.a.x+(w.b.x-w.a.x)*i/divisions,z:w.a.z+(w.b.z-w.a.z)*i/divisions};
    const post=box(`frame-${index}`,{x:p.x-.018,z:p.z-.018,w:.036,d:.036},low,high,'#303c3d');walls.push({mesh:post,wall:w,low,high});casters.push(post);
   }
   for(const height of [low,high]){
    const rail=box(`rail-${index}`,{...r,w:vertical?.035:r.w,d:vertical?r.d:.035},height-.015,height+.015,'#303c3d');walls.push({mesh:rail,wall:w,low:height-.015,high:height+.015});casters.push(rail);
   }
   const pane=box(`glass-${index}`,{...r,w:vertical?.008:r.w,d:vertical?r.d:.008},low+.02,high-.02,'#a8d6dd');
   const glass=new StandardMaterial('glass',scene);glass.diffuseColor=Color3.FromHexString('#a8d6dd');glass.alpha=.12;glass.specularColor=new Color3(.3,.3,.3);glass.backFaceCulling=false;glass.maxSimultaneousLights=12;pane.material=glass;walls.push({mesh:pane,wall:w,low,high});continue;
  }
  if(w.kind==='closed-door'){
   part(0,2.7,'#f6f5ee');
   const length=vertical?r.d:r.w,leaves=w.leaves??1;
   const faceX=r.x+r.w/2-w.normal.x*.069,faceZ=r.z+r.d/2-w.normal.z*.069;
   function detail(name:string,along:number,width:number,low:number,high:number,color:string,offset=0){
    const x=faceX+(vertical?0:along)-w.normal.x*offset,z=faceZ+(vertical?along:0)-w.normal.z*offset;
    const panel=box(name,{x:x-(vertical?.008:width/2),z:z-(vertical?width/2:.008),w:vertical?.016:width,d:vertical?width:.016},low,high,color);
    walls.push({mesh:panel,wall:w,low,high});
   }
   for(let leaf=0;leaf<leaves;leaf++){
    const center=-length/2+(leaf+.5)*length/leaves;
    detail(`closed-door-${index}-${leaf}`,center,length/leaves-.025,.04,2.35,'#303635');
    const handle=leaves===2?(leaf===0?length/leaves/2-.055:-length/leaves/2+.055):length/leaves/2-.075;
    detail(`door-handle-${index}-${leaf}`,center+handle,.018,.98,1.14,'#d9ddd4',.025);
   }
   continue;
  }
  const bath=w.a.z===5.65&&w.a.x>=6.3;
  part(0,2.7,bath?'#626865':'#f6f5ee');
  if(bath){
   for(let h=.3;h<2.7;h+=.3){const grout=box('bath-grout',{...r,z:r.z-.009,d:.015},h,h+.008,'#89908b');walls.push({mesh:grout,wall:w,low:h,high:h+.008});}
  }
 }
 const doorZ=7.075+ENTRY_RECESS;
 const entryWall:Wall={a:{x:3.65,z:doorZ},b:{x:4.6,z:doorZ},kind:'outer',normal:{x:0,z:1}};
 function entryPart(name:string,r:Rect,low:number,high:number,color:string){
  const mesh=box(name,r,low,high,color);walls.push({mesh,wall:entryWall,low,high});
 }
 entryPart('entry-door-rack-backing',{x:3.66,z:doorZ-.0175,w:.93,d:.035},0,2.05,'#e5e3d9');
 entryPart('entry-lintel',{x:3.65,z:7.1,w:.95,d:ENTRY_RECESS},2.05,2.7,'#f6f5ee');
 for(const x of [3.65,4.57])entryPart('entry-jamb',{x,z:doorZ-.025,w:.03,d:.055},0,2.10,'#e5e3dc');
 entryPart('entry-frame-top',{x:3.65,z:doorZ-.025,w:.95,d:.055},2.05,2.10,'#e5e3dc');
 entryPart('entry-handle',{x:4.39,z:doorZ-.066,w:.13,d:.025},.97,1.00,'#a8b4b7');
 entryPart('entry-closer',{x:3.79,z:doorZ-.07,w:.22,d:.035},1.93,1.98,'#89908b');
 return{walls,casters,grids,meshes};
}
