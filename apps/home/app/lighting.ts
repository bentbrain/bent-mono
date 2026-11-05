import {rotateAroundOrigin} from '@apartment-hotel/scene-engine';
import {televisionMode} from './television';
import {LIGHT_LOCATIONS,KITCHEN_STRIP_ENTITY,APPLE_TV_ENTITY,type Hass,lightState} from './ha';
import {baseHeight,productFor,type Item} from './editorState';
import {APARTMENT_LOCATION} from './apartmentLocation';
export type EnvironmentMode='live'|'day'|'sunset'|'night';
export interface Environment {mode:EnvironmentMode;balconyBearing:number;previewLights:boolean}
export const DEFAULT_ENVIRONMENT:Environment={mode:'live',balconyBearing:APARTMENT_LOCATION.balconyBearing,previewLights:false};
export interface Sunlight {elevation:number;azimuth:number;daylight:number;direct:number;source:'home-assistant'|'preview'|'unavailable'|'astronomical';direction:{x:number;y:number;z:number}}
export function sunlight(hass:Hass|undefined,environment:Environment):Sunlight {
 const sun=hass?.states['sun.sun'];let elevation=35,azimuth=65,source:Sunlight['source']='unavailable';
 if(environment.mode!=='live'){
  elevation=environment.mode==='night'?-20:environment.mode==='sunset'?3:45;
  azimuth=environment.mode==='sunset'?290:65;source='preview';
 }else if(sun&&typeof sun.attributes.elevation==='number'&&Number.isFinite(sun.attributes.elevation)&&typeof sun.attributes.azimuth==='number'&&Number.isFinite(sun.attributes.azimuth)&&!['unknown','unavailable'].includes(sun.state)){
  elevation=sun.attributes.elevation;azimuth=sun.attributes.azimuth;source='home-assistant';
 }else if(sun?.state==='below_horizon'){elevation=-20;source='home-assistant';}
 return sunlightFromPosition(elevation,azimuth,environment.balconyBearing,source);
}
export function sunlightFromPosition(elevation:number,azimuth:number,balconyBearing:number,source:Sunlight['source']):Sunlight {
 const radians=Math.PI/180,a=(azimuth-balconyBearing)*radians,e=elevation*radians;
 const day=Math.max(0,Math.min(1,(elevation+8)/24)),daylight=day*day*(3-2*day);
 return{elevation,azimuth,source,daylight,direct:Math.max(0,Math.sin(e))*1.3,direction:{x:-Math.sin(a)*Math.cos(e),y:-Math.sin(e),z:Math.cos(a)*Math.cos(e)}};
}
export interface SceneLight {key:string;entityId:string;x:number;z:number;height:number;brightness:number;color:string;kind:'point'|'spot';preview:boolean;ownerId?:string;power?:number;stripLength?:number;range?:number;screen?:boolean;direction?:{x:number;y:number;z:number}}
// Two lengths under the timber cupboards, leaving the rangehood clear.
export const KITCHEN_STRIP_SEGMENTS=[{start:3.25,end:4.48,count:4},{start:5.12,end:5.65,count:2}];
export function sceneLights(items:readonly Item[],hass:Hass|undefined,environment:Environment):SceneLight[]{
 const placed=items.filter(i=>productFor(i.productId)?.category==='Lighting');
 const bound=new Set(placed.map(i=>i.entityId).filter(Boolean));
 // HA light groups expose their members. Those physical lights already have placed fixtures.
 const pending=[...bound];
 for(let index=0;index<pending.length;index++){
  const members=hass?.states[pending[index]??'']?.attributes.entity_id;
  if(Array.isArray(members))for(const member of members)if(typeof member==='string'&&member.startsWith('light.')&&!bound.has(member)){bound.add(member);pending.push(member);}
 }
 const strip=KITCHEN_STRIP_SEGMENTS.flatMap((segment,index)=>Array.from({length:segment.count},(_,i):Omit<SceneLight,'brightness'|'color'|'preview'>=>({key:`kitchen-strip/${index}/${i}`,entityId:KITCHEN_STRIP_ENTITY,ownerId:'fixed/overheads',x:.30,z:segment.start+(i+.5)*(segment.end-segment.start)/segment.count,height:1.55,kind:'spot' satisfies SceneLight['kind'],stripLength:(segment.end-segment.start)/segment.count,range:1.65,power:.35})));
 const sources=[...strip,...LIGHT_LOCATIONS.filter(l=>!bound.has(l.id)).map<Omit<SceneLight,'brightness'|'color'|'preview'>>(l=>({key:l.id,entityId:l.id,x:l.x,z:l.z,height:2.5,kind:'spot' satisfies SceneLight['kind']})),...placed.flatMap<Omit<SceneLight,'brightness'|'color'|'preview'>>(i=>i.productId==='okensand'?[.52,.90,1.28].map((height,index)=>({key:index===0?i.id:i.id+'/bulb/'+index,ownerId:i.id,entityId:i.entityId,x:i.x,z:i.z,height:height+baseHeight(i),power:1/3,kind:'point'})):[{key:i.id,ownerId:i.id,entityId:i.entityId,x:i.x,z:i.z,height:baseHeight(i)+(productFor(i.productId)?.emitter??1.53),power:productFor(i.productId)?.placement==='downlight'?2:1,kind:productFor(i.productId)?.placement==='downlight'?'spot':'point'}])];
 const mode=televisionMode(hass,environment.mode!=='live'&&environment.previewLights);
 const screens=items.filter(i=>i.productId==='lg-g4').map<SceneLight>(i=>{const front=rotateAroundOrigin({x:0,z:1},i.rotation);return{key:i.id+'/screen',ownerId:i.id,entityId:APPLE_TV_ENTITY,x:i.x+front.x*.09,z:i.z+front.z*.09,height:baseHeight(i)+.3515,brightness:mode==='off'?0:mode==='idle'?.3:mode==='paused'?.5:.75,color:'#87c9ee',kind:'spot',power:.55,range:2.5,screen:true,direction:{x:front.x,y:-.12,z:front.z},preview:environment.mode!=='live'&&environment.previewLights};});
 return [...screens,...sources.map(s=>{
  const state=lightState(hass?.states[s.entityId]);const preview=environment.mode!=='live'&&environment.previewLights;
  return{...s,brightness:preview?.8:state.brightness,color:preview?'#ffd6a0':state.color,preview};
 })];
}
