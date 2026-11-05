import {parseItems,type Item} from '../editorState';
import {ROLES,DEFAULT_RAMPS,type LightRole,type Ramps} from './lighting';
export interface PublicLayout {schema:1;revision:number;items:Item[];roles:Record<string,LightRole>;ramps:Ramps}
const ITEM_KEYS=new Set(['id','productId','x','z','rotation','entityId','elevation','finish','materialColor','materialGloss','seatPad','bedding','supportId','supportSurface']);
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function role(value:unknown):value is LightRole{return typeof value==='string'&&ROLES.some(r=>r===value);}
export function parsePublicLayout(value:unknown):PublicLayout{
 if(!record(value)||value.schema!==1||!Number.isSafeInteger(value.revision)||typeof value.revision!=='number'||value.revision<0||!Array.isArray(value.items)||!record(value.roles))throw Error('Invalid public layout');
 for(const item of value.items)if(!record(item)||item.entityId!==''||Object.keys(item).some(k=>!ITEM_KEYS.has(k))||typeof item.id!=='string'||!/^p-[a-f0-9]{16}$/.test(item.id))throw Error('Private or invalid item fields');
 const items=parseItems(JSON.stringify(value.items),true),roles:Record<string,LightRole>={};
 for(const item of items){const r=value.roles[item.id];if(!role(r))throw Error('Missing light role');roles[item.id]=r;}
 const ramps={...DEFAULT_RAMPS};
 if(value.ramps!==undefined){if(!record(value.ramps))throw Error('Invalid light ramps');for(const key of Object.keys(ramps)){const v=value.ramps[key];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100)throw Error('Invalid ramp value');Object.assign(ramps,{[key]:v});}}
 return{schema:1,revision:value.revision,items,roles,ramps};
}
