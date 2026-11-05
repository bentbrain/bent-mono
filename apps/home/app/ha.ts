import {entityColor} from './lightColor';
export interface Entity {entity_id:string;state:string;attributes:Record<string,unknown>}
export interface Hass {callWS?:(message:Record<string,unknown>)=>Promise<unknown>;states:Record<string,Entity>;connected?:boolean;connection?:{connected:boolean};callService:(domain:string,service:string,data:Record<string,unknown>)=>Promise<unknown>}
export interface LightState {state:'on'|'off'|'unavailable';brightness:number;color:string}
export function lightState(e:Entity|undefined):LightState {
 if(!e||!['on','off'].includes(e.state))return{state:'unavailable',brightness:0,color:'#4a3857'};
 const a=e.attributes,color=`rgb(${entityColor(e).join(',')})`;
 return{state:e.state==='on'?'on':'off',brightness:e.state==='on'?(a.brightness===undefined?1:typeof a.brightness==='number'&&Number.isFinite(a.brightness)?Math.max(0,Math.min(255,a.brightness))/255:0):0,color};
}
const configuredBindings:unknown=JSON.parse(process.env.PUBLIC_HOME_HA_BINDINGS??'{}');
function entityBinding(name:string,fallback:string):string{
 if(typeof configuredBindings!=='object'||configuredBindings===null||Array.isArray(configuredBindings))throw new Error('Invalid PUBLIC_HOME_HA_BINDINGS');
 const entry=Object.entries(configuredBindings).find(([key])=>key===name);
 if(!entry)return fallback;
 if(typeof entry[1]!=='string'||!entry[1].includes('.'))throw new Error(`Invalid Home entity binding ${name}`);
 return entry[1];
}
export const APPLE_TV_ENTITY=entityBinding('television','media_player.example_tv');
export const KITCHEN_STRIP_ENTITY=entityBinding('kitchenStrip','light.example_kitchen_strip');
export const LIGHT_LOCATIONS=[
 {id:entityBinding('livingDownlight1','light.example_living_downlight_1'),name:'Living downlight 1',x:1.4,z:2.6},
 {id:entityBinding('livingDownlight2','light.example_living_downlight_2'),name:'Living downlight 2',x:1.4,z:4.1},
 {id:entityBinding('livingDownlight3','light.example_living_downlight_3'),name:'Living downlight 3',x:1.4,z:5.4},
 {id:entityBinding('livingPendant','light.example_living_pendant'),name:'Living pendant',x:3.3,z:5.3},
 {id:entityBinding('bedroomCeiling','light.example_bedroom_ceiling'),name:'Bedroom ceiling',x:7,z:2},
];
export function friendly(e:Entity):string{return typeof e.attributes.friendly_name==='string'?e.attributes.friendly_name:e.entity_id;}
