import {rotateAroundOrigin,type CameraQuarter} from '@apartment-hotel/scene-engine';
import type {CutawayGroup,Point,Wall} from './plan';

// Stepped perimeter sections belong to both adjoining exterior faces.
// Cut away the complete section when either face is on the camera's near side.
const GROUP_NORMALS:Record<CutawayGroup,readonly Point[]>={
 'entry-step':[{x:-1,z:0},{x:0,z:1}],
 // Door reveals follow the entrance assembly, including its recessed sides.
 'entry-door':[{x:0,z:1}],
 'utility-front':[{x:1,z:0},{x:0,z:1}],
 'bathroom-return':[{x:-1,z:0},{x:0,z:1}],
};
export function isWallCutAway(wall:Wall,q:CameraQuarter):boolean {
 if(!wall.cutawayGroup&&['inner','robe'].includes(wall.kind))return false;
 const normals=wall.cutawayGroup?GROUP_NORMALS[wall.cutawayGroup]:[wall.normal];
 return normals.some(normal=>{const n=rotateAroundOrigin(normal,q);return n.x>0||n.z>0;});
}
