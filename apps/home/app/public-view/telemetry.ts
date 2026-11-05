/** Bounded, anonymous diagnostics. Never pass layout objects or HA state here. */
export const FRONTEND_RELEASE='2026-09-11-cached-shadows-28';
export const EVENT_KINDS=['scene-start','render-error','graphics-recovery','graphics-recovered','scene-load-error','layout-model-error','javascript-error','unhandled-rejection','react-error','webgl-context-lost','webgl-context-restored','scene-ready'] satisfies readonly string[];
export type EventKind='scene-start'|'render-error'|'graphics-recovery'|'graphics-recovered'|'scene-load-error'|'layout-model-error'|'javascript-error'|'unhandled-rejection'|'react-error'|'webgl-context-lost'|'webgl-context-restored'|'scene-ready';
export interface SceneContext {quarter:number;items:number;lounge:number;bedroom:number}
const breadcrumbs:{action:string;at:number}[]=[];
let session='';
let context:SceneContext={quarter:0,items:0,lounge:0,bedroom:0},sent=0;
const seen=new Set<string>();
export function diagnosticText(value:unknown,max=1500):string{
 return (typeof value==='string'?value:'').slice(0,max).replace(/https?:\/\/[^\s)]+/g,url=>{
  try{const path=new URL(url).pathname;return path.startsWith('/assets/')||path.startsWith('/models/')?path:'[url]';}catch{return '[url]';}
 }).replace(/\bBearer\s+\S+/gi,'[redacted]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email]');
}
export function noteAction(action:'rotate'|'lights'|'gesture-start'|'gesture-end'|'loading'|'ready'):void{
 breadcrumbs.push({action,at:Math.round(performance.now())});if(breadcrumbs.length>12)breadcrumbs.shift();
}
export function diagnosticContext(next:SceneContext):void{context=next;}
export function reportFrontend(kind:EventKind,error?:unknown):void{
 if(typeof window==='undefined')return;
 try{
 if(!session)session=crypto.randomUUID();
 const id=crypto.randomUUID(),message=diagnosticText(error instanceof Error?error.message:typeof error==='string'?error:'');
 const key=kind+message;if(sent>=10||seen.has(key))return;seen.add(key);sent++;
 const ua=navigator.userAgent;
 const report={id,session,kind,release:FRONTEND_RELEASE,message,stack:diagnosticText(error instanceof Error?error.stack:''),elapsed:Math.round(performance.now()),context,
  browser:/CriOS/.test(ua)?'chrome-ios':/iPhone|iPad/.test(ua)?'safari-ios':/Chrome/.test(ua)?'chromium':/Firefox/.test(ua)?'firefox':'webkit-other',
  viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},visibility:document.visibilityState,breadcrumbs:[...breadcrumbs]};
 try{void fetch('/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report),keepalive:true}).catch(()=>{});}catch{/* Diagnostics must never break the scene. */}
 }catch{/* Reporting failures must not prevent loading or interaction. */}
}
export function installDiagnostics(canvas:HTMLCanvasElement):()=>void{
 const onError=(event:ErrorEvent)=>reportFrontend('javascript-error',event.error??event.message);
 const onRejection=(event:PromiseRejectionEvent)=>reportFrontend('unhandled-rejection',event.reason);
 const lost=()=>{reportFrontend('webgl-context-lost');};
 const restored=()=>{reportFrontend('webgl-context-restored');};
 window.addEventListener('error',onError);window.addEventListener('unhandledrejection',onRejection);
 canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);
 return()=>{window.removeEventListener('error',onError);window.removeEventListener('unhandledrejection',onRejection);canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);};
}
