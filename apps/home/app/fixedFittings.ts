import type { CameraQuarter } from '@apartment-hotel/scene-engine';
import type { Point, Rect } from './plan';

/** Fixed construction, traced from the plan; cabinetry sizes estimated from photos. */
export interface FixedFitting extends Point {
 id: string;
 model: string;
 label: string;
 rotation: CameraQuarter;
 footprint: Rect;
 blocksFloor: boolean;
 render?: boolean;
 wallNormal?: Point;
}

function kitchen(id:string,model:string,z:number,length:number,upper=false):FixedFitting {
 const x=upper?.23:.36,depth=upper?.34:.62;
 return {id,model,label:model.replace('kitchen-',''),x,z,rotation:1,
  footprint:{x:x-depth/2,z:z-length/2,w:depth,d:length},blocksFloor:!upper,render:false,
  ...(upper?{wallNormal:{x:-1,z:0}}:{})};
}

export const FIXED_FITTINGS:readonly FixedFitting[] = [
 kitchen('fridge','kitchen-tall',1.925,.85),
 kitchen('pantry','kitchen-tall',2.525,.35),
 kitchen('sink','kitchen-sink',3.3,1.2),
 kitchen('dishwasher','kitchen-dishwasher',4.2,.6),
 kitchen('oven','kitchen-oven',4.8,.6),
 kitchen('bench','kitchen-base',5.4,.6),
 {id:'kitchen-run',model:'kitchen-run',label:'Fitted kitchen',x:.36,z:3.6,rotation:1,footprint:{x:.05,z:1.5,w:.62,d:4.2},blocksFloor:false},
 {id:'overheads',model:'kitchen-overheads',label:'Overhead cupboards',x:.23,z:4.45,rotation:1,footprint:{x:.06,z:3.2,w:.34,d:2.5},blocksFloor:false,wallNormal:{x:-1,z:0}},
 {id:'robe',model:'bedroom-robe',label:'Wardrobe',x:5.1,z:1.325,rotation:1,footprint:{x:4.8,z:0,w:.6,d:2.65},blocksFloor:false},
 {id:'vanity',model:'bath-vanity',label:'Vanity',x:6.86,z:5.33,rotation:0,footprint:{x:6.435,z:5.07,w:.85,d:.52},blocksFloor:true},
 {id:'mirror',model:'bath-mirror',label:'Mirror cabinet',x:6.86,z:5.49,rotation:0,footprint:{x:6.435,z:5.405,w:.85,d:.17},blocksFloor:false,wallNormal:{x:0,z:1}},
 {id:'toilet',model:'bath-toilet',label:'WC',x:7.61,z:5.25,rotation:0,footprint:{x:7.41,z:4.91,w:.4,d:.68},blocksFloor:true},
 {id:'shower',model:'bath-shower',label:'Shower',x:8.52,z:4.825,rotation:0,footprint:{x:8.1,z:4.06,w:.84,d:1.53},blocksFloor:true},
];

export const FIXED_OBSTACLES:readonly Rect[] = FIXED_FITTINGS.filter(f=>f.blocksFloor).map(f=>f.footprint);
export const FIXED_MODEL_IDS:readonly string[] = [...new Set(FIXED_FITTINGS.filter(f=>f.render!==false).map(f=>f.model))];

export function fixedSpriteSize(model:string):number {return model==='kitchen-run'||model==='kitchen-overheads'||model==='bedroom-robe'?480:240;}
