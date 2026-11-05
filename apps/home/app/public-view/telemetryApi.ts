import {diagnosticText,EVENT_KINDS} from './telemetry';
const MAX_BYTES=8192;
const limits=new Map<string,{start:number;count:number}>();
function object(value:unknown):Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)?Object.fromEntries(Object.entries(value)):{};}
function number(value:unknown,max=1_000_000):number{return typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(max,value)):0;}
export function cleanReport(value:unknown):Record<string,unknown>|null{
 const v=object(value);if(!EVENT_KINDS.some(kind=>kind===v.kind)||typeof v.id!=='string'||!/^[a-f\d-]{36}$/.test(v.id))return null;
 const c=object(v.context),viewport=object(v.viewport);
 return {id:v.id,session:typeof v.session==='string'&&/^[a-f\d-]{36}$/.test(v.session)?v.session:'',kind:v.kind,release:diagnosticText(v.release,80),message:diagnosticText(v.message),stack:diagnosticText(v.stack),elapsed:number(v.elapsed),
  browser:diagnosticText(v.browser,30),visibility:v.visibility==='hidden'?'hidden':'visible',
  context:{quarter:number(c.quarter,3),items:number(c.items,1000),lounge:number(c.lounge,100),bedroom:number(c.bedroom,100)},
  viewport:{width:number(viewport.width,10000),height:number(viewport.height,10000),dpr:number(viewport.dpr,10)},
  breadcrumbs:Array.isArray(v.breadcrumbs)?v.breadcrumbs.slice(-12).map(value=>{const b=object(value);return {action:diagnosticText(b.action,30),at:number(b.at)};}):[]};
}
export async function telemetryApi(request:Request):Promise<Response>{
 const reply=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply(405);
 if(request.headers.get('origin')!==new URL(request.url).origin)return reply(403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415);
 // In-memory abuse guard: IPs are never stored in reports or printed to logs.
 const key=request.headers.get('cf-connecting-ip')??'local',now=Date.now(),old=limits.get(key);
 if(old&&now-old.start<60000){if(old.count>=30)return reply(429);old.count++;}
 else{if(limits.size>=1024)limits.clear();limits.set(key,{start:now,count:1});}
 if(Number(request.headers.get('content-length'))>MAX_BYTES)return reply(413);
 try{
  const reader=request.body?.getReader();if(!reader)return reply(400);let text='',size=0;const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();return reply(413);}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();const report=cleanReport(JSON.parse(text));if(!report)return reply(400);
  console.log(JSON.stringify({event:'frontend-diagnostic',...report}));return reply(204);
 }catch{return reply(400);}
}
