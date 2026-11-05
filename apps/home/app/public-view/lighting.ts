import {sceneLights,DEFAULT_ENVIRONMENT,type SceneLight} from '../lighting';
import {LIGHT_LOCATIONS,KITCHEN_STRIP_ENTITY,type Hass} from '../ha';
import {productFor,type Item} from '../editorState';
export const ROLES:readonly LightRole[]=['lounge-lamps','lounge-pendant','lounge-overheads','bedroom-lamps','bedroom-bedside','bedroom-overheads'];
export type LightRole='lounge-lamps'|'lounge-pendant'|'lounge-overheads'|'bedroom-lamps'|'bedroom-bedside'|'bedroom-overheads';
export interface Ramps {lampsStart:number;lampsEnd:number;pendantStart:number;pendantEnd:number;overheadsStart:number;overheadsEnd:number}
export const DEFAULT_RAMPS:Ramps={lampsStart:0,lampsEnd:100,pendantStart:25,pendantEnd:100,overheadsStart:50,overheadsEnd:100};
export function ramp(value:number,start:number,end:number):number{return Math.round(Math.max(0,Math.min(100,(value-start)*100/(Math.max(end,start+5)-start))));}
export function roleBrightness(role:LightRole,lounge:number,bedroom:number,ramps=DEFAULT_RAMPS):number{
 switch(role){
  case 'lounge-lamps':return ramp(lounge,ramps.lampsStart,ramps.lampsEnd);
  case 'lounge-pendant':return ramp(lounge,ramps.pendantStart,ramps.pendantEnd);
  case 'lounge-overheads':return ramp(lounge,ramps.overheadsStart,ramps.overheadsEnd);
  case 'bedroom-bedside':return Math.round(bedroom*.55);
  case 'bedroom-overheads':return ramp(bedroom,50,100);
  default:return bedroom;
 }
}
export function defaultRole(item:Item):LightRole{
 if(productFor(item.productId)?.placement==='downlight')return item.x>4.8?'bedroom-overheads':'lounge-overheads';
 if(item.productId==='dejsa')return 'bedroom-bedside';
 if(item.productId==='gullsudare')return 'lounge-pendant';
 return item.x>4.8?'bedroom-lamps':'lounge-lamps';
}
export function simulatedLights(items:readonly Item[],roles:Readonly<Record<string,LightRole>>,lounge:number,bedroom:number,ramps=DEFAULT_RAMPS):SceneLight[]{
 const states:Hass['states']={};
 const assign=(id:string,role:LightRole)=>{
  const pct=roleBrightness(role,lounge,bedroom,ramps);
  let kelvin=Math.max(2200,Math.round(1e6/(1e6/2700+82.5-.825*Math.max(10,pct))));
  if(role==='bedroom-lamps'&&kelvin<3000)kelvin+=Math.round((3000-kelvin)/800*900);
  states[id]={entity_id:id,state:pct>0?'on':'off',attributes:{brightness:Math.round(pct*255/100),color_temp_kelvin:kelvin}};
 };
 const placed=items.map(item=>{const role=roles[item.id]??defaultRole(item),id='light.demo_'+role;assign(id,role);return {...item,entityId:id};});
 assign(KITCHEN_STRIP_ENTITY,'lounge-lamps');
 for(const location of LIGHT_LOCATIONS)assign(location.id,location.x>4.8?'bedroom-lamps':location.name.includes('pendant')?'lounge-pendant':'lounge-overheads');
 const hass:Hass={states,callService:async()=>{throw Error('The public scene cannot operate home devices');}};
 const hasPlacedOverheads=placed.some(i=>productFor(i.productId)?.placement==='downlight');
 return sceneLights(placed,hass,DEFAULT_ENVIRONMENT).filter(l=>!hasPlacedOverheads||l.ownerId);
}
