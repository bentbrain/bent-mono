import {flushSync} from 'react-dom';
export interface PublicControls {rotate(direction:'left'|'right'):void;lights(lounge:number,bedroom:number):void}
interface ModelContext {registerTool(tool:{name:string;description:string;inputSchema:object;annotations:{readOnlyHint:boolean;untrustedContentHint:boolean};execute(input:unknown):unknown},options:{signal:AbortSignal}):void|Promise<void>}
declare global {interface Document {readonly modelContext?:ModelContext}}
export function registerPublicControls(controls:PublicControls):()=>void{
 const context=document.modelContext;if(!context)return()=>{};const lifecycle=new AbortController();
 const tool={name:'set_apartment_view',description:'Rotate the pixel apartment or set its simulated room lighting. Does not operate home devices.',inputSchema:{type:'object',properties:{direction:{enum:['left','right']},lounge:{type:'number',minimum:0,maximum:100},bedroom:{type:'number',minimum:0,maximum:100}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input:unknown){
  if(typeof input!=='object'||input===null)throw Error('Expected controls');
  const direction='direction'in input?input.direction:undefined;
  const lounge='lounge'in input?input.lounge:undefined,bedroom='bedroom'in input?input.bedroom:undefined;
  if(direction!==undefined&&direction!=='left'&&direction!=='right')throw Error('Invalid direction');
  if((lounge!==undefined||bedroom!==undefined)&&(typeof lounge!=='number'||!Number.isFinite(lounge)||lounge<0||lounge>100||typeof bedroom!=='number'||!Number.isFinite(bedroom)||bedroom<0||bedroom>100))throw Error('Supply both room levels from 0 to 100');
  flushSync(()=>{if(direction)controls.rotate(direction);if(typeof lounge==='number'&&typeof bedroom==='number')controls.lights(lounge,bedroom);});
  return{updated:true};
 }};
 try{void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{/* Optional browser capability. */}
 return()=>lifecycle.abort();
}
