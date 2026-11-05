'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {nextCameraQuarter,previousCameraQuarter,type CameraQuarter} from '@apartment-hotel/scene-engine';
import {parseItems} from '../editorState';
import {startApartmentWorld,type ApartmentWorld,type WorldOptions} from '../worldScene';
import {buildPetGraph} from '../surfaces';
import {createPet,stepPets} from '../pets';
import {DEFAULT_ENVIRONMENT} from '../lighting';
import {defaultLightLevel} from './daylight';
import {useApartmentSunlight} from '../useApartmentSunlight';
import {useSceneNavigation} from './useSceneNavigation';
import {ArrowLeft,ArrowRight} from 'lucide-react';
import {simulatedLights} from './lighting';
import {parsePublicLayout} from './snapshot';
import initial from './initial-layout.json';
import './public.css';
import {MAX_GRAPHICS_RECOVERIES} from '../graphicsRecovery';
import {diagnosticContext,installDiagnostics,noteAction,reportFrontend} from './telemetry';
import {registerPublicControls} from './webmcp';
const initialLayout=parsePublicLayout(initial);
export function PublicApartment(){
 const [rendererAttempt,setRendererAttempt]=useState(0);
 const room=useRef<HTMLDivElement>(null);
 const canvas=useRef<HTMLCanvasElement>(null),world=useRef<ApartmentWorld|null>(null),pending=useRef<WorldOptions|null>(null);
 const sun=useApartmentSunlight();
 const [layout,setLayout]=useState(initialLayout),[q,setQ]=useState<CameraQuarter>(0),[loungeOverride,setLoungeOverride]=useState<number|null>(null),[bedroomOverride,setBedroomOverride]=useState<number|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 useEffect(()=>registerPublicControls({rotate:direction=>setQ(direction==='left'?previousCameraQuarter:nextCameraQuarter),lights:(l,b)=>{setLoungeOverride(l);setBedroomOverride(b);}}),[]);
 useEffect(()=>{const target=canvas.current;if(!target)return;return installDiagnostics(target);},[rendererAttempt]);
 const automaticLevel=defaultLightLevel(sun);
 const lounge=loungeOverride??automaticLevel,bedroom=bedroomOverride??automaticLevel;
 const items=useMemo(()=>parseItems(JSON.stringify(layout.items),true),[layout]);
 const graph=useMemo(()=>buildPetGraph(items,true),[items]);
 const [initialCats]=useState(()=>[createPet('pearl',graph,{x:2.5,z:3}),createPet('maree',graph,{x:3.5,z:4})]);
 const cats=useRef(initialCats),queuedFrame=useRef(0),interacting=useRef(false),lightingInteracting=useRef(false),resumeTimer=useRef(0);
 // Keep only the latest input in each display frame; React owns controls, not cat ticks.
 const queueUpdate=useCallback(()=>{if(queuedFrame.current)return;queuedFrame.current=requestAnimationFrame(()=>{queuedFrame.current=0;if(interacting.current)return;const runtime=world.current;if(runtime&&pending.current){runtime.update(pending.current);}});},[]);
 // A live WebGL redraw can consume the entire touch frame budget on phones.
 // Hold its retained framebuffer during gestures; resume after the last CSS transform paints.
 const onInteraction=useCallback((active:boolean)=>{
  noteAction(active?'gesture-start':'gesture-end');clearTimeout(resumeTimer.current);
  if(active){interacting.current=true;world.current?.setPresentationPaused(true);}
  else resumeTimer.current=window.setTimeout(()=>{interacting.current=false;world.current?.setPresentationPaused(false);queueUpdate();},100);
 },[queueUpdate]);
 const onLightingInteraction=useCallback((active:boolean)=>{if(lightingInteracting.current===active)return;lightingInteracting.current=active;if(active)noteAction('lights');world.current?.setLightingInteraction(active);},[]);
 useEffect(()=>{const release=()=>onLightingInteraction(false);window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);window.addEventListener('blur',release);return()=>{window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);window.removeEventListener('blur',release);};},[onLightingInteraction]);
 useSceneNavigation(room,canvas,onInteraction,rendererAttempt);
 useEffect(()=>()=>{cancelAnimationFrame(queuedFrame.current);clearTimeout(resumeTimer.current);},[]);
 const lights=useMemo(()=>simulatedLights(items,layout.roles,lounge,bedroom,layout.ramps),[items,layout.roles,layout.ramps,lounge,bedroom]);
 useEffect(()=>{let cancelled=false,failed=false;let dispose:(()=>void)|undefined;Promise.resolve().then(async()=>{
  if(cancelled||!canvas.current)return;noteAction('loading');reportFrontend('scene-start');const runtime=startApartmentWorld(canvas.current,{disableVertexArrayObjects:rendererAttempt>0,onRenderError:error=>{
   if(cancelled)return;failed=true;reportFrontend('render-error',error);
   if(rendererAttempt<MAX_GRAPHICS_RECOVERIES){reportFrontend('graphics-recovery',`Attempt ${rendererAttempt+1}`);setStatus('loading');setRendererAttempt(rendererAttempt+1);}else setStatus('error');
  }});world.current=runtime.world;runtime.world.setPresentationPaused(interacting.current);runtime.world.setLightingInteraction(lightingInteracting.current);dispose=runtime.dispose;
  if(pending.current)runtime.world.update(pending.current);
  // A newer snapshot can arrive while the first models are downloading.
  let loaded:WorldOptions['items']|undefined;
  do{loaded=pending.current?.items;await runtime.world.load('/models',loaded?.map(item=>item.productId)??[],true);}while(!cancelled&&loaded!==pending.current?.items);
  if(!cancelled&&!failed){setStatus('ready');noteAction('ready');if(rendererAttempt>0)reportFrontend('graphics-recovered',`Attempt ${rendererAttempt}`);else reportFrontend('scene-ready');}
 }).catch(error=>{if(!cancelled){reportFrontend('scene-load-error',error);setStatus('error');}});return()=>{cancelled=true;world.current=null;dispose?.();};},[rendererAttempt]);
 useEffect(()=>{const runtime=world.current;if(!runtime)return;let cancelled=false;void runtime.load('/models',items.map(item=>item.productId),true).then(()=>{if(!cancelled)queueUpdate();}).catch(error=>{if(!cancelled){reportFrontend('layout-model-error',error);setStatus('error');}});return()=>{cancelled=true;};},[items,queueUpdate]);
 useEffect(()=>{diagnosticContext({quarter:q,items:items.length,lounge,bedroom});},[q,items.length,lounge,bedroom]);
 useEffect(()=>{noteAction('rotate');},[q]);
 useEffect(()=>{if(!sun)return;const options:WorldOptions={q,items,cats:cats.current,selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',fittings:true,frame:0,devices:false,vacuum:null,downlights:false,environment:DEFAULT_ENVIRONMENT,hass:undefined,sceneLights:lights,sunlight:sun,background:sun.elevation>=0?'light':'dark'};pending.current=options;queueUpdate();},[q,items,lights,sun,queueUpdate]);
 useEffect(()=>{
  let last=performance.now(),hourChecked=-Infinity,night=false;
  const clock=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',hourCycle:'h23'}),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const id=setInterval(()=>{const now=performance.now(),dt=Math.min(.08,(now-last)/1000);last=now;if(document.hidden||reduced.matches||interacting.current||lightingInteracting.current)return;
   if(now-hourChecked>60000){const hour=Number(clock.format(new Date()));night=hour>=19||hour<6;hourChecked=now;}
   cats.current=stepPets(cats.current,dt,graph,Math.random,night);
   if(pending.current){pending.current={...pending.current,cats:cats.current};queueUpdate();}
  },50);return()=>clearInterval(id);
 },[graph,queueUpdate]);
 useEffect(()=>{const controller=new AbortController();let etag='';const refresh=async()=>{if(document.hidden)return;try{const response=await fetch('/api/layout',{signal:controller.signal,headers:etag?{'If-None-Match':etag}:{}});if(response.status===304)return;if(!response.ok)return;const next=parsePublicLayout(await response.json());etag=response.headers.get('etag')??'';setLayout(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);}catch{/* Keep the last complete layout during connection interruptions. */}};void refresh();const id=setInterval(()=>void refresh(),15000);return()=>{controller.abort();clearInterval(id);};},[]);
 const theme=sun&&sun.elevation>=0?'light':'dark';
 return <main className="public-home" data-theme={theme}>
   <nav className="public-rotation" aria-label="Rotate apartment">
    <button aria-label="Rotate left" title="Rotate left" onClick={()=>setQ(previousCameraQuarter)}><ArrowLeft aria-hidden="true"/></button>
    <button aria-label="Rotate right" title="Rotate right" onClick={()=>setQ(nextCameraQuarter)}><ArrowRight aria-hidden="true"/></button>
   </nav>
  <div ref={room} className="public-room" aria-busy={status==='loading'} aria-label="Apartment view. On a touch screen, drag to pan, pinch to zoom, and double-tap to reset.">
   <canvas key={rendererAttempt} ref={canvas} aria-label="Pixel apartment with Pearl and Maree"/>
   {status==='loading'&&<div className="public-loading" role="status" aria-label="Loading apartment"><span className="public-spinner" aria-hidden="true"/></div>}
   {status==='error'&&<p className="public-status" role="status">The room could not load. Try refreshing this page.</p>}
  </div>
  <nav className="public-controls" aria-label="Apartment controls">
   <label>lounge <output>{lounge}%</output><input onPointerDown={()=>onLightingInteraction(true)} onKeyDown={()=>onLightingInteraction(true)} onKeyUp={()=>onLightingInteraction(false)} onBlur={()=>onLightingInteraction(false)} aria-label="Lounge lighting" type="range" min="0" max="100" value={lounge} onChange={e=>setLoungeOverride(Number(e.target.value))}/></label>
   <label>bedroom <output>{bedroom}%</output><input onPointerDown={()=>onLightingInteraction(true)} onKeyDown={()=>onLightingInteraction(true)} onKeyUp={()=>onLightingInteraction(false)} onBlur={()=>onLightingInteraction(false)} aria-label="Bedroom lighting" type="range" min="0" max="100" value={bedroom} onChange={e=>setBedroomOverride(Number(e.target.value))}/></label>
  </nav>
 </main>;
}
