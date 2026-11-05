import {expect,test} from 'bun:test';
import {ramp,roleBrightness,simulatedLights} from './lighting';
import {parsePublicLayout} from './snapshot';
import {publicLayoutApi,type SnapshotBucket} from './api';
import initial from './initial-layout.json';
class MemoryBucket implements SnapshotBucket{
 value:string|null=null;version=0;
 async get(){if(this.value===null)return null;const value=this.value,etag=String(this.version);return{etag,httpEtag:'"'+etag+'"',text:async()=>value};}
 async put(_key:string,value:string,options:{onlyIf:{etagMatches:string}|{etagDoesNotMatch:string}}){
  if('etagMatches' in options.onlyIf?options.onlyIf.etagMatches!==String(this.version):this.value!==null)return null;
  this.value=value;this.version++;return{etag:String(this.version)};
 }
}
test('room sliders reproduce staged lounge ramps and reduced bedside brightness',()=>{
 expect([0,25,50,75,100].map(v=>roleBrightness('lounge-pendant',v,0))).toEqual([0,0,33,67,100]);
 expect(roleBrightness('bedroom-bedside',0,60)).toBe(33);
 expect(roleBrightness('bedroom-overheads',0,50)).toBe(0);
 expect(roleBrightness('bedroom-overheads',0,75)).toBe(50);
 expect(ramp(75,50,50)).toBe(100);
 const layout=parsePublicLayout(initial),off=simulatedLights(layout.items,layout.roles,0,0);
 expect(off.every(l=>l.brightness===0)).toBe(true);
 const on=simulatedLights(layout.items,layout.roles,100,100);
 expect(on.some(l=>l.brightness>0)).toBe(true);
 expect(on.every(l=>!l.entityId.includes('bedside_lamps'))).toBe(true);
});
test('public snapshot rejects HA bindings and unknown private item fields',()=>{
 const first=initial.items[0];if(!first)throw Error('Missing fixture');
 for(const patch of [{entityId:'light.private_device'},{token:'private'},{address:'private'}])expect(()=>parsePublicLayout({...initial,items:[{...first,...patch}]})).toThrow();
 expect(parsePublicLayout(initial).items.every(i=>i.entityId==='')).toBe(true);
});
test('Public sync preserves validated colour and gloss overrides',()=>{
 const first=initial.items[0];if(!first)throw Error('Missing fixture');
 const layout=parsePublicLayout({...initial,items:[{...first,materialColor:'#abcdef',materialGloss:.7}]});
 expect(layout.items[0]?.materialColor).toBe('#abcdef');expect(layout.items[0]?.materialGloss).toBe(.7);
 expect(()=>parsePublicLayout({...initial,items:[{...first,materialColor:'url(secret)'}]})).toThrow();
});
test('public readers cannot write layouts; authenticated sync rejects stale saves',async()=>{
 const bucket=new MemoryBucket(),env={PUBLIC_LAYOUT_BUCKET:bucket,PUBLIC_SYNC_TOKEN:'test-only'};
 const put=(revision:number,token='test-only')=>publicLayoutApi(new Request('https://example.test/api/layout',{method:'PUT',headers:{Authorization:'Bearer '+token},body:JSON.stringify({...initial,revision})}),env);
 expect((await put(10,'wrong')).status).toBe(401);expect(bucket.value).toBeNull();
 expect((await put(10)).status).toBe(200);expect((await put(9)).status).toBe(409);
 const read=await publicLayoutApi(new Request('https://example.test/api/layout'),env);expect(read.status).toBe(200);
 expect(parsePublicLayout(await read.json()).revision).toBe(10);
 const cached=await publicLayoutApi(new Request('https://example.test/api/layout',{headers:{'If-None-Match':read.headers.get('etag')??''}}),env);expect(cached.status).toBe(304);
 expect((await publicLayoutApi(new Request('https://example.test/api/layout',{method:'DELETE'}),env)).status).toBe(405);
});
test('concurrent public updates retain the newest revision',async()=>{
 const bucket=new MemoryBucket(),env={PUBLIC_LAYOUT_BUCKET:bucket,PUBLIC_SYNC_TOKEN:'test-only'};
 await Promise.all([12,11,14].map(revision=>publicLayoutApi(new Request('https://example.test/api/layout',{method:'PUT',headers:{Authorization:'Bearer test-only'},body:JSON.stringify({...initial,revision})}),env)));
 expect(parsePublicLayout(JSON.parse(bucket.value??'null')).revision).toBe(14);
});
