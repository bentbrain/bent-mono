import {parsePublicLayout} from './snapshot';
import initial from './initial-layout.json';
export interface SnapshotObject {etag:string;httpEtag:string;text():Promise<string>}
export interface SnapshotBucket {
 get(key:string):Promise<SnapshotObject|null>;
 put(key:string,value:string,options:{onlyIf:{etagMatches:string}|{etagDoesNotMatch:string};httpMetadata:{contentType:string}}):Promise<unknown|null>;
}
export interface PublicEnv {PUBLIC_LAYOUT_BUCKET:SnapshotBucket;PUBLIC_SYNC_TOKEN?:string}
const KEY='layout.json',MAX_BYTES=200_000;
function response(body:unknown,status=200,headers:Record<string,string>={}):Response{return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});}
async function authorized(request:Request,token:string|undefined):Promise<boolean>{
 if(!token)return false;const supplied=request.headers.get('authorization')??'';
 const digest=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [a,b]=await Promise.all([digest(supplied),digest('Bearer '+token)]);let diff=0;for(let i=0;i<a.length;i++)diff|=(a[i]??0)^(b[i]??0);return diff===0;
}
async function boundedBody(request:Request):Promise<string>{
 if(Number(request.headers.get('content-length'))>MAX_BYTES)throw Error('Too large');
 const reader=request.body?.getReader();if(!reader)throw Error('Missing body');const chunks:Uint8Array[]=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw Error('Too large');}chunks.push(value);}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return new TextDecoder().decode(bytes);
}
export async function publicLayoutApi(request:Request,env:PublicEnv):Promise<Response>{
 try{
  if(request.method==='GET'){
   const object=await env.PUBLIC_LAYOUT_BUCKET.get(KEY);
   if(!object)return response(parsePublicLayout(initial));
   if(request.headers.get('if-none-match')===object.httpEtag)return new Response(null,{status:304,headers:{etag:object.httpEtag,'Cache-Control':'no-cache'}});
   return new Response(await object.text(),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=5, must-revalidate',etag:object.httpEtag,'X-Content-Type-Options':'nosniff'}});
  }
  if(request.method!=='PUT')return response({error:'Method not allowed'},405,{Allow:'GET, PUT'});
  if(!await authorized(request,env.PUBLIC_SYNC_TOKEN)){
   // Drain supported-size rejected bodies so the Worker proxy can reuse its connection.
   // Oversized or absent bodies remain unauthorized, without unbounded reads.
   try{await boundedBody(request);}catch{/* No request data is retained. */}
   return response({error:'Unauthorized'},401);
  }
  let layout;try{layout=parsePublicLayout(JSON.parse(await boundedBody(request)));}catch{return response({error:'Invalid public layout'},400);}
  const serialized=JSON.stringify(layout);
  for(let attempt=0;attempt<3;attempt++){
   const current=await env.PUBLIC_LAYOUT_BUCKET.get(KEY);
   if(current){const old=parsePublicLayout(JSON.parse(await current.text()));if(layout.revision<old.revision)return response({error:'Stale revision'},409);if(layout.revision===old.revision&&JSON.stringify(layout.items)!==JSON.stringify(old.items))return response({error:'Revision already used'},409);if(serialized===JSON.stringify(old))return response({revision:old.revision});}
   const saved=await env.PUBLIC_LAYOUT_BUCKET.put(KEY,serialized,{onlyIf:current?{etagMatches:current.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(saved)return response({revision:layout.revision});
  }
  return response({error:'Retry sync'},409);
 }catch{return response({error:'Layout temporarily unavailable'},503);}
}
