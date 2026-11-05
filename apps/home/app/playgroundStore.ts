export const PLAYGROUND_INDEX_KEY='apartment-hotel-playground-index-v1';
const PLAYGROUND_LAYOUT_PREFIX='apartment-hotel-playground-layout-v1-';

export interface PlaygroundVersion {id:string;name:string}
export interface PlaygroundIndex {activeId:string;versions:PlaygroundVersion[]}

function version(value:unknown):PlaygroundVersion|null{
 if(typeof value!=='object'||value===null||!('id' in value)||!('name' in value)||typeof value.id!=='string'||typeof value.name!=='string'||!value.id||!value.name.trim())return null;
 return {id:value.id,name:value.name.trim()};
}

export function readPlaygroundIndex(raw:string):PlaygroundIndex{
 const value:unknown=JSON.parse(raw);
 if(typeof value!=='object'||value===null||!('activeId' in value)||typeof value.activeId!=='string'||!('versions' in value)||!Array.isArray(value.versions))throw Error('Invalid playground index');
 const versions:PlaygroundVersion[]=[];
 for(const candidate of value.versions){const parsed=version(candidate);if(!parsed||versions.some(item=>item.id===parsed.id))throw Error('Invalid playground index');versions.push(parsed);}
 if(!versions.some(item=>item.id===value.activeId))throw Error('Invalid playground index');
 return {activeId:value.activeId,versions};
}

export function playgroundLayoutKey(id:string):string{return `${PLAYGROUND_LAYOUT_PREFIX}${id}`;}

export function nextPlaygroundName(versions:readonly PlaygroundVersion[]):string{
 let number=1;
 while(versions.some(item=>item.name.toLocaleLowerCase()===`layout ${number}`))number++;
 return `Layout ${number}`;
}
