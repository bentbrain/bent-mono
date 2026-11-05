import {expect,test} from 'bun:test';
import {LayoutSession,LEGACY_LAYOUT,PENDING_LAYOUT,SHARED_CACHE,type LayoutStorage,type LayoutDocument,type LayoutTransport} from './layoutPersistence';
import type {Item} from './editorState';
const original:Item[]=[{id:'lamp',productId:'kd27',x:2,z:3,rotation:0,entityId:'light.test',finish:'orange'}];
class Memory implements LayoutStorage{
 data=new Map<string,string>();getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}
}
function server(){let doc:LayoutDocument={revision:1,items:original};let writes=0;let offline=false;
 const transport:LayoutTransport=async m=>{if(offline)throw Error('offline');if(m.type==='apartment_hotel/layout/get')return doc;if(m.expected_revision!==doc.revision)throw {code:'conflict'};writes++;doc={revision:doc.revision+1,items:JSON.parse(JSON.stringify(m.items))};return doc;};
 return{transport,get doc(){return doc;},get writes(){return writes;},set offline(v:boolean){offline=v;}};
}
test('Empty Tailscale browser loads shared layout without writing or replacing original browser data',async()=>{
 const backend=server(),storage=new Memory();let shown:Item[]=[];
 const session=new LayoutSession(storage,backend.transport,v=>{shown=v;},()=>{});await session.start();
 expect(shown).toEqual(original);expect(backend.writes).toBe(0);expect(storage.getItem(LEGACY_LAYOUT)).toBeNull();
 const local=new Memory();local.setItem(LEGACY_LAYOUT,JSON.stringify(original));await new LayoutSession(local,backend.transport,()=>{},()=>{}).start();
 expect(local.getItem('apartment-hotel-before-shared-v1')).toBe(JSON.stringify(original));expect(backend.writes).toBe(0);
});
test('A stale tab preserves its draft and cannot overwrite a newer save',async()=>{
 const b=server(),aStore=new Memory(),bStore=new Memory();let state='';
 const a=new LayoutSession(aStore,b.transport,()=>{},()=>{}),c=new LayoutSession(bStore,b.transport,()=>{},s=>{state=s;});await a.start();await c.start();
 a.edit(original.map(i=>({...i,x:3})));await a.flush();c.edit(original.map(i=>({...i,x:4})));await c.flush();
 expect(state).toBe('conflict');expect(b.doc.items[0]?.x).toBe(3);expect(bStore.getItem(PENDING_LAYOUT)).toContain('"x":4');
 await c.useShared();expect([...bStore.data.keys()].some(k=>k.startsWith('apartment-hotel-recovered-draft-'))).toBe(true);expect(bStore.getItem(PENDING_LAYOUT)).toBeNull();
});
test('Offline edits survive reload and retry instead of becoming an empty layout',async()=>{
 const b=server(),storage=new Memory();const a=new LayoutSession(storage,b.transport,()=>{},()=>{});await a.start();b.offline=true;
 a.edit(original.map(i=>({...i,x:3})));await a.flush();expect(storage.getItem(PENDING_LAYOUT)).not.toBeNull();a.stop();
 let shown:Item[]=[];const reload=new LayoutSession(storage,b.transport,v=>{shown=v;},()=>{});await reload.start();expect(shown[0]?.x).toBe(3);b.offline=false;await reload.retry();expect(b.doc.items[0]?.x).toBe(3);expect(storage.getItem(PENDING_LAYOUT)).toBeNull();
});
test('An in-flight save cannot discard an edit made while waiting for its response',async()=>{
 const storage=new Memory();let release:(v:unknown)=>void=()=>{};let count=0;
 const transport:LayoutTransport=async m=>{if(m.type==='apartment_hotel/layout/get')return {revision:1,items:original};count++;if(count===1)return new Promise(resolve=>{release=resolve;});return {revision:3,items:m.items};};
 const a=new LayoutSession(storage,transport,()=>{},()=>{});await a.start();a.edit(original.map(i=>({...i,x:3})));const pending=a.flush();a.edit(original.map(i=>({...i,x:4})));release({revision:2,items:original.map(i=>({...i,x:3}))});await pending;
 expect(JSON.parse(storage.getItem(SHARED_CACHE)??'null').items[0].x).toBe(4);expect(storage.getItem(PENDING_LAYOUT)).toBeNull();expect(count).toBe(2);
});
test('Corrupt original data and unavailable initial shared storage are never overwritten',async()=>{
 const storage=new Memory();storage.setItem(LEGACY_LAYOUT,'broken');const b=server();const a=new LayoutSession(storage,b.transport,()=>{},()=>{});await a.start();expect(a.edit(original)).toBe(false);expect(storage.getItem(LEGACY_LAYOUT)).toBe('broken');expect(b.writes).toBe(0);
});
