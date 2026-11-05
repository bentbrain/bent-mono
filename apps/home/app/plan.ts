/** Metres, traced from the reference floorplan. */
export interface Point { x: number; z: number }
export interface Rect { x: number; z: number; w: number; d: number }
export interface Zone extends Rect { id: string; name: string; material: 'oak' | 'tile' | 'balcony' | 'carpet'; label: string }
export type CutawayGroup='entry-step'|'entry-door'|'utility-front'|'bathroom-return';
export interface Wall { a: Point; b: Point; kind: 'outer' | 'inner' | 'glass' | 'rail' | 'window' | 'robe' | 'closed-door'; normal: Point; leaves?:number; cutawayGroup?:CutawayGroup }
export const GRID = .25;
export const CENTER = { x: 4.5, z: 3.5 };
// Photographic estimate: the door sits 25 cm behind the sideboard wall face.
export const ENTRY_RECESS=.25;
export const ENTRY_RACK_Z=6.98+ENTRY_RECESS;
export const ZONES: readonly Zone[] = [
 {id:'balcony',name:'Balcony',x:0,z:0,w:4.8,d:1.4,material:'balcony',label:'1.4 × 4.8 m'},
 {id:'living',name:'Living / dining',x:0,z:1.4,w:4.8,d:4.5,material:'oak',label:'4.4 × 5.4 m clear'},
 {id:'entry',name:'Entry',x:.6,z:5.9,w:4.2,d:1.2,material:'oak',label:'Recessed entry'},
 {id:'door-recess',name:'Door recess',x:3.65,z:7.1,w:.95,d:ENTRY_RECESS,material:'oak',label:''},
 {id:'bedroom',name:'Bedroom',x:4.8,z:0,w:4.2,d:4,material:'carpet',label:'3.6 × 4.0 m + robe'},
 {id:'hall',name:'Hall',x:4.8,z:4,w:1.5,d:1.05,material:'oak',label:''},
 {id:'bathroom',name:'Bathroom',x:6.3,z:4,w:2.7,d:1.65,material:'tile',label:'Approx. 2.7 × 1.65 m'},
];
function wall(x1:number,z1:number,x2:number,z2:number,kind:Wall['kind']='inner',nx=0,nz=-1):Wall {return {a:{x:x1,z:z1},b:{x:x2,z:z2},kind,normal:{x:nx,z:nz}};}
export const WALLS: readonly Wall[] = [
 wall(0,0,4.8,0,'rail',0,-1),wall(0,0,0,5.9,'outer',-1,0),
 {...wall(0,5.9,.6,5.9,'outer',0,1),cutawayGroup:'entry-step'},
 {...wall(.6,5.9,.6,7.1,'outer',-1,0),cutawayGroup:'entry-step'},
 wall(.6,7.1,3.65,7.1,'outer',0,1),wall(4.6,7.1,4.8,7.1,'outer',0,1),wall(6.3,5.65,9,5.65,'outer',0,1),wall(9,0,9,4,'outer',1,0),wall(9,4,9,5.65,'outer',1,0),
 wall(4.8,0,5.85,0,'outer',0,-1),wall(5.85,0,8.45,0,'window',0,-1),wall(8.45,0,9,0,'outer',0,-1),
 wall(0,1.4,1.05,1.4,'outer'),wall(1.05,1.4,4.3,1.4,'glass'),wall(4.3,1.4,4.8,1.4,'outer'),
 wall(4.8,0,4.8,4,'inner',-1,0),
 wall(4.8,4,4.95,4),wall(5.95,4,6.5,4),wall(7.25,4,9,4),
 {...wall(6.3,4.85,6.3,5.05,'inner',-1,0),cutawayGroup:'bathroom-return'},
 {...wall(6.3,5.05,6.3,5.65,'outer',-1,0),cutawayGroup:'bathroom-return'},
 {...wall(4.8,5.05,5.8,5.05,'outer',0,1),cutawayGroup:'utility-front'},
 // Laundry, adjacent cupboard and linen are excluded voids behind closed fronts.
 {...wall(5.8,5.05,6.3,5.05,'closed-door',0,1),cutawayGroup:'utility-front'},
 {...wall(4.8,5.05,4.8,5.65,'closed-door',1,0),cutawayGroup:'utility-front'},
 {...wall(4.8,5.65,4.8,7.1,'closed-door',1,0),leaves:2,cutawayGroup:'utility-front'},
 // Built-in robe enclosure. The clear bedroom width is 3.6 m.
 {...wall(3.65,7.1,3.65,7.1+ENTRY_RECESS,'outer',-1,0),cutawayGroup:'entry-door'},
 {...wall(4.6,7.1,4.6,7.1+ENTRY_RECESS,'outer',1,0),cutawayGroup:'entry-door'},
 wall(5.4,0,5.4,2.65,'robe',1,0),wall(4.8,2.65,5.4,2.65,'robe',0,1),
];
export const DOORS:readonly Rect[]=[{x:6.5,z:3.85,w:.75,d:.3},{x:4.95,z:3.85,w:1,d:.3},{x:6.15,z:4,w:.3,d:.85},{x:3.65,z:6.95,w:.95,d:.3},{x:4.65,z:5.85,w:.3,d:1.1}];
export function inside(p:Point,r:Rect,margin=0):boolean {return p.x>=r.x+margin&&p.x<=r.x+r.w-margin&&p.z>=r.z+margin&&p.z<=r.z+r.d-margin;}
export function onFloor(p:Point):boolean{return ZONES.some(z=>inside(p,z));}
export function overlap(a:Rect,b:Rect):boolean{return a.x<b.x+b.w-.001&&a.x+a.w>b.x+.001&&a.z<b.z+b.d-.001&&a.z+a.d>b.z+.001;}
export function wallBounds(w:Wall):Rect{const vertical=w.a.x===w.b.x;return{x:Math.min(w.a.x,w.b.x)+(vertical?w.normal.x*.06-.06:0),z:Math.min(w.a.z,w.b.z)+(!vertical?w.normal.z*.06-.06:0),w:vertical?.12:Math.abs(w.b.x-w.a.x),d:vertical?Math.abs(w.b.z-w.a.z):.12};}
export function wallIntersects(r:Rect):boolean{return WALLS.some(w=>overlap(r,wallBounds(w)));}
export function fitsRoom(r:Rect,keepDoorsClear=true):boolean {
 for(let x=r.x+.01;x<r.x+r.w;x+=.1)for(let z=r.z+.01;z<r.z+r.d;z+=.1)if(!onFloor({x,z}))return false;
 return !wallIntersects(r)&&(!keepDoorsClear||!DOORS.some(d=>overlap(r,d)))&&!overlap(r,{x:4.8,z:0,w:.6,d:2.65});
}
export function canWalk(a:Point,b:Point,obstacles:readonly Rect[]):boolean {
 const r={x:Math.min(a.x,b.x)-.08,z:Math.min(a.z,b.z)-.08,w:Math.abs(a.x-b.x)+.16,d:Math.abs(a.z-b.z)+.16};
 return fitsRoom(r,false)&&!obstacles.some(o=>overlap(r,o))&&b.z>1.5;
}
