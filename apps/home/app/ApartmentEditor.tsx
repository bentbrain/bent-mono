"use client";
import {ArrowLeft,ArrowRight,RotateCw,Undo2,Redo2,X,Move,Trash2} from 'lucide-react';
import {PlaygroundInspector} from './playground/PlaygroundInspector';
import {useCallback,useEffect,useMemo,useRef,useState,type PointerEvent} from 'react';
import {nextCameraQuarter,previousCameraQuarter,type CameraQuarter} from '@apartment-hotel/scene-engine';
import {BEDDING,CATALOG,withSupport,baseHeight,moveItem,bounds,overlapsFitting,parseItems,placeable,productFor,type Item} from './editorState';
import {DEFAULT_WALL_DISPLAY,type WallDisplay} from './scene';
import {buildPetGraph,placementSurfaces} from './surfaces';
import {createPet,stepPets} from './pets';
import {inside,ZONES,type Point} from './plan';
import {project,rectPoints,renderPlan,unproject,unprojectPlan,WIDTH,HEIGHT} from './scene';
import {friendly,lightState,type Hass} from './ha';
import {MAX_GRAPHICS_RECOVERIES} from './graphicsRecovery';
import {startApartmentWorld,type ApartmentWorld,type WorldOptions} from './worldScene';
import modelManifest from '../public/models/manifest.json';
import {DEFAULT_ENVIRONMENT,sunlight,type Environment} from './lighting';
import {useApartmentSunlight} from './useApartmentSunlight';

import {placementAt,onSurface,placementPointerOffset} from './placement';
import {fitsSupport} from './supportGeometry';
import {surfacePosition,slideOnSurface} from './surfacePosition';
import {createItemId} from './itemId';
import {useLayoutPersistence} from './useLayoutPersistence';
import {arrangePhotoObjects} from './photoArrangement';
import {arrangeLatestPhotos} from './latestPhotoArrangement';
import {addLeaningMirror} from './mirrorArrangement';

const spriteVersions=new Map(Object.entries(modelManifest.spriteHashes??{}));
const SCENE_VERSION='3D · Perimeter cutaway 30';
interface Props {sharedLayout?:boolean;hass?:Hass;hassRevision?:number;spriteBase?:string;localLayoutKey?:string;playground?:boolean}
export function ApartmentEditor({hass,hassRevision=0,spriteBase='/sprites',sharedLayout=false,localLayoutKey,playground=false}:Props){
 const [rendererAttempt,setRendererAttempt]=useState(0);
 const liveHass=hass?.connection?.connected===false||hass?.connected===false?undefined:hass;
 const worldCanvasRef=useRef<HTMLCanvasElement>(null),worldRef=useRef<ApartmentWorld|null>(null),pendingWorld=useRef<WorldOptions|null>(null);
 const [environment,setEnvironment]=useState<Environment>(()=>playground?{...DEFAULT_ENVIRONMENT,mode:'day'}:DEFAULT_ENVIRONMENT);
 const measuredSun=useApartmentSunlight(environment.balconyBearing);
 const liveSun=environment.mode==='live'?measuredSun:undefined;
 const daylight=liveSun??sunlight(liveHass,environment);
 const canvasRef=useRef<HTMLCanvasElement>(null),stageRef=useRef<HTMLDivElement>(null),importRef=useRef<HTMLInputElement>(null);
 const [q,setQ]=useState<CameraQuarter>(0),[items,setItems]=useState<Item[]>([]),[history,setHistory]=useState<Item[][]>([]),[future,setFuture]=useState<Item[][]>([]);
 const [selected,setSelected]=useState<string|null>(null),[placing,setPlacing]=useState<string|null>(null),[rotation,setRotation]=useState<CameraQuarter>(0),[hover,setHover]=useState<{x:number;y:number;wallPoint:Point|undefined;surfaceHit:{owner:string;height:number}|null|undefined}|null>(null);
 const [grid,setGrid]=useState(false),[labels,setLabels]=useState(false),[walls,setWalls]=useState<WallDisplay>(DEFAULT_WALL_DISPLAY),[showCats,setShowCats]=useState(false),[devices,setDevices]=useState(false);
 const [fittings,setFittings]=useState(true),[downlights,setDownlights]=useState(true);
 const [planView,setPlanView]=useState(false),[tab,setTab]=useState<'Furniture'|'Lighting'|'Home Assistant'>('Furniture'),[query,setQuery]=useState(''),[status,setStatus]=useState(playground?'':'Choose an item, then click a spot in the apartment.'),[ready,setReady]=useState(false),[scale,setScale]=useState(1),[zoom,setZoom]=useState(1);
 const drag=useRef<{id:string|null;x:number;y:number;active:boolean;offset:{x:number;y:number}}|null>(null);
 const petGraph=useMemo(()=>buildPetGraph(items,fittings),[items,fittings]);
 const [cats,setCats]=useState(()=>[createPet('pearl',petGraph,{x:2.5,z:3}),createPet('maree',petGraph,{x:3.5,z:4})]),[moving,setMoving]=useState(false),[showInfo,setShowInfo]=useState(false);
 const current=items.find(i=>i.id===selected),product=current?productFor(current.productId):undefined;
 const support=current?surfacePosition(current,items):null;
 const ghost:Item|null=hover&&(placing||moving&&current)?placementAt({...moving&&current?current:{},id:moving&&current?current.id:'preview',productId:placing??current?.productId??'',x:0,z:0,rotation,entityId:moving&&current?current.entityId:''},hover,q,items,planView,hover.wallPoint,hover.surfaceHit):null;
 const lightEntities=liveHass?Object.values(liveHass.states).filter(e=>e.entity_id.startsWith('light.')).sort((a,b)=>friendly(a).localeCompare(friendly(b))):[];
 const vacuumEntity=liveHass?.states['vacuum.vacuum'];
 const vacuumMap=liveHass?.states['image.vacuum_map']?.attributes.entity_picture;
 const receive=useCallback((next:Item[],remote:boolean)=>{setItems(next);if(remote){setHistory([]);setFuture([]);setSelected(null);setMoving(false);}},[setSelected,setMoving]);
 const persistence=useLayoutPersistence(hass,sharedLayout,receive,localLayoutKey);
 const persist=persistence.edit;
 const commit=useCallback((next:Item[])=>{if(!persist(next))return false;setHistory(h=>[...h.slice(-49),items]);setFuture([]);return true;},[items,persist]);
 const undo=useCallback(()=>{const prev=history.at(-1);if(!prev||!persist(prev))return;setFuture(f=>[items,...f]);setHistory(h=>h.slice(0,-1));setStatus('Undone.');},[history,items,persist,setStatus]);
 const redo=useCallback(()=>{const next=future[0];if(!next||!persist(next))return;setHistory(h=>[...h,items]);setFuture(f=>f.slice(1));setStatus('Redone.');},[future,items,persist,setStatus]);
 useEffect(()=>{const id=requestAnimationFrame(()=>{try{setDownlights(localStorage.getItem('apartment-hotel-downlights-visible')!=='false');}catch{/* Keep default visibility. */}});return()=>cancelAnimationFrame(id);},[]);
 useEffect(()=>{
  const canvas=worldCanvasRef.current;if(!canvas)return;let cancelled=false,failed=false;let dispose:(()=>void)|undefined;
  Promise.resolve().then(()=>{if(cancelled)return;const runtime=startApartmentWorld(canvas,{disableVertexArrayObjects:rendererAttempt>0,onRenderError:()=>{if(cancelled)return;failed=true;if(rendererAttempt<MAX_GRAPHICS_RECOVERIES){setReady(false);setRendererAttempt(rendererAttempt+1);}else setStatus('The room could not render. Please reload to try again.');}});worldRef.current=runtime.world;dispose=runtime.dispose;if(pendingWorld.current)runtime.world.update(pendingWorld.current);
   runtime.world.load(spriteBase.replace(/\/sprites\/?$/,'/models')).then(()=>{if(!cancelled&&!failed){setReady(true);setStatus(playground?'':'Room ready. Choose furniture or bind a lamp to a real light.');}}).catch(()=>{if(!cancelled)setStatus('Some 3D models could not load. Reload the page to try again.');});
  }).catch(()=>{if(!cancelled)setStatus('This device could not start WebGL. Try enabling hardware acceleration or opening Home Assistant in another browser.');});
  return()=>{cancelled=true;worldRef.current=null;dispose?.();};
 },[spriteBase,rendererAttempt,playground]);
 useEffect(()=>{const el=stageRef.current;if(!el)return;const observer=new ResizeObserver(([entry])=>{if(entry){const factor=playground?Math.max(.1,Math.min(entry.contentRect.width/WIDTH,entry.contentRect.height/HEIGHT)):Math.max(1,Math.floor(entry.contentRect.width/WIDTH));setScale(factor);el.scrollLeft=Math.max(0,(WIDTH*factor-entry.contentRect.width)/2);}});observer.observe(el);return()=>observer.disconnect();},[playground]);
 useEffect(()=>{
  if(playground||!showCats)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');let last=performance.now();
  const id=setInterval(()=>{
   const now=performance.now(),dt=Math.min(.08,(now-last)/1000);last=now;
   if(reduced.matches||document.hidden)return;
   const hour=Number(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',hourCycle:'h23'}).format(new Date()));
   setCats(previous=>stepPets(previous,dt,petGraph,Math.random,hour>=19||hour<6));
  },50);
  return()=>clearInterval(id);
 },[playground,showCats,petGraph]);
 useEffect(()=>{
  const options:WorldOptions={q,items,selected,ghost,grid,labels,walls,fittings,cats:!playground&&showCats?cats:[],frame:0,hass:liveHass,devices,vacuum:null,environment,downlights,...playground?{background:'light'}:{},...liveSun?{sunlight:liveSun}:{}};
  pendingWorld.current=options;worldRef.current?.update(options);
  const ctx=canvasRef.current?.getContext('2d');if(!ctx)return;
  if(planView){renderPlan(ctx,items,selected,fittings,ghost,playground);return;}
  ctx.clearRect(0,0,WIDTH,HEIGHT);ctx.imageSmoothingEnabled=false;
  if(playground&&ghost){const points=rectPoints(bounds(ghost),q,baseHeight(ghost));ctx.strokeStyle=placeable(ghost,items)?'#0647ff':'#c40035';ctx.lineWidth=3;ctx.beginPath();points.forEach((p,index)=>{if(index===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});ctx.closePath();ctx.stroke();}
  if(labels){ctx.font='10px monospace';ctx.textAlign='center';for(const z of ZONES.filter(z=>['bedroom','living','balcony','bathroom'].includes(z.id))){const p=project({x:z.x+z.w/2,z:z.z+z.d/2},q);ctx.fillStyle='#fffef3';ctx.fillRect(p.x-50,p.y-9,100,15);ctx.fillStyle='#303635';ctx.fillText(z.name.toUpperCase(),p.x,p.y+2);}}
 },[q,items,selected,ghost,grid,labels,walls,cats,liveHass,devices,showCats,ready,planView,fittings,environment,hassRevision,downlights,liveSun,playground]);
 const changeItem=useCallback((next:Item)=>{
  const changed=moveItem(items,next),affected=changed.filter(i=>i!==items.find(old=>old.id===i.id));
  if(affected.some(i=>!placeable(i,changed))){setStatus('That position overlaps another object or does not fit the room.');return;}
  commit(changed);
 },[items,commit,setStatus]);
 const removeSelected=useCallback((id:string)=>{
  if(items.some(i=>i.supportId===id)){setStatus('Move the objects resting on this piece before removing it.');return;}
  commit(items.filter(i=>i.id!==id));setSelected(null);
 },[items,commit,setStatus,setSelected]);
 const rotateHalf=useCallback(()=>{
  const halfTurn=(quarter:CameraQuarter)=>nextCameraQuarter(nextCameraQuarter(quarter));
  if(placing||moving){setRotation(halfTurn);return;}
  const item=items.find(i=>i.id===selected);
  if(item)changeItem({...item,rotation:halfTurn(item.rotation)});
 },[placing,moving,items,selected,changeItem]);
 const rotate=useCallback(()=>{if(placing||moving){setRotation(nextCameraQuarter);return;}const item=items.find(i=>i.id===selected);if(item){const next={...item,rotation:nextCameraQuarter(item.rotation)};if(placeable(next,items)){changeItem(next);}else setStatus('There is not enough room to rotate this item.');}},[placing,moving,selected,items,changeItem,setStatus]);
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{const target=e.composedPath()[0];if(target instanceof HTMLInputElement||target instanceof HTMLSelectElement||target instanceof HTMLTextAreaElement)return;if(e.key==='Escape'){drag.current=null;setHover(null);setStatus('');setPlacing(null);setMoving(false);setSelected(null);}if(e.key.toLowerCase()==='r')rotate();if(e.key==='Delete'||e.key==='Backspace'){if(selected){removeSelected(selected);}e.preventDefault();}if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[rotate,selected,removeSelected,undo,redo]);
 function pointer(e:PointerEvent<HTMLCanvasElement>){const r=e.currentTarget.getBoundingClientRect();const offset=drag.current?.active?drag.current.offset:{x:0,y:0};const pixel={x:(e.clientX-r.left)*WIDTH/r.width-offset.x,y:(e.clientY-r.top)*HEIGHT/r.height-offset.y};return{...pixel,wallPoint:planView?undefined:worldRef.current?.pickWallPoint(pixel.x,pixel.y),surfaceHit:planView?undefined:worldRef.current?.pickSurface(pixel.x,pixel.y)};}
 function choose(id:string){if(playground&&window.matchMedia('(max-width: 850px)').matches)stageRef.current?.scrollIntoView({block:'center',behavior:'smooth'});setHover(null);setRotation(0);setPlacing(id);setSelected(null);setMoving(false);setStatus(playground?'Click to place · R to rotate':`Place ${productFor(id)?.name}. ${productFor(id)?.placement==='downlight'?'Click the floor directly beneath its ceiling position.':productFor(id)?.placement==='wall'?'Click near a solid wall to mount it.':productFor(id)?.placement==='small'?'Click a tabletop or shelf, or click the floor. R rotates.':'R rotates, Escape cancels.'}`);}
 function click(e:PointerEvent<HTMLCanvasElement>){const p=pointer(e);setHover(p);if(placing||moving&&current){const next=placementAt({...current&&moving?current:{},id:current&&moving?current.id:createItemId(),productId:placing??current?.productId??'',x:0,z:0,rotation,entityId:current&&moving?current.entityId:placing==='vacuum'?'vacuum.vacuum':''},p,q,items,planView,p.wallPoint,p.surfaceHit);if(!placeable(next,items)){setStatus('That spot overlaps a fixed fitting, wall, doorway or another item.');return;}const changed=moveItem(items,next);if(changed.some(i=>i!==items.find(old=>old.id===i.id)&&!placeable(i,changed))){setStatus('The objects on this piece do not fit at that position.');return;}if(!commit(changed))return;setSelected(next.id);setPlacing(null);setMoving(false);setStatus(playground?'Placed.':'Placed. Select the item to move, rotate or remove it.');return;}
 const canvasBounds=e.currentTarget.getBoundingClientRect();const picked=planView?null:worldRef.current?.pickItem((e.clientX-canvasBounds.left)*WIDTH/canvasBounds.width,(e.clientY-canvasBounds.top)*HEIGHT/canvasBounds.height);
 if(picked){setSelected(picked);return;}
 const hit=[...items].sort((a,b)=>project(b,q).y-project(a,q).y).find(i=>inside(planView?unprojectPlan(p):unproject(p,q),bounds(i)));setSelected(hit?.id??null);
 }

 function putOnSurface(surfaceId:string){
  if(!current)return;
  const surface=placementSurfaces(items).find(s=>s.id===surfaceId);if(!surface)return;
  const next=onSurface(current,surface),p=productFor(current.productId);
  if(!p||!fitsSupport(next,p,surface)){setStatus('This object does not fit the surface or the space above it.');return;}
  changeItem(next);
 }
 function exportLayout(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(items,null,2)],{type:'application/json'}));a.download='apartment-layout.json';a.click();URL.revokeObjectURL(a.href);setStatus('Layout exported.');}
 function cancelPlacement(){setPlacing(null);setMoving(false);setHover(null);drag.current=null;setStatus('');}
 function startMove(){if(!current)return;setRotation(current.rotation);setHover(null);setMoving(true);setStatus('Click a new spot.');}
 function pickAt(e:PointerEvent<HTMLCanvasElement>):string|null{
  const p=pointer(e),picked=planView?null:worldRef.current?.pickItem(p.x,p.y);
  return picked??[...items].reverse().find(i=>inside(planView?unprojectPlan(p):unproject(p,q),bounds(i)))?.id??null;
 }
 function pointerDown(e:PointerEvent<HTMLCanvasElement>){
  if(!playground){click(e);return;}if(e.button!==0)return;
  e.currentTarget.focus();const id=placing||moving?null:pickAt(e),item=items.find(i=>i.id===id);
  drag.current={id,x:e.clientX,y:e.clientY,active:!!placing||moving,offset:item?placementPointerOffset(item,pointer(e),q,planView):{x:0,y:0}};
  if(placing||moving)setHover(pointer(e));
  e.currentTarget.setPointerCapture(e.pointerId);
 }
 function pointerMove(e:PointerEvent<HTMLCanvasElement>){
  const gesture=drag.current;
  if(playground&&gesture?.id&&!gesture.active&&Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>6){
   const item=items.find(i=>i.id===gesture.id);if(item){gesture.active=true;setSelected(item.id);setRotation(item.rotation);setMoving(true);}
  }
  if(placing||moving||gesture?.active)setHover(pointer(e));
 }
 function pointerUp(e:PointerEvent<HTMLCanvasElement>){
  if(!playground)return;const gesture=drag.current;
  if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  if(!gesture)return;
  if(gesture.active||Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)<6)click(e);
  drag.current=null;
 }
 return <main className="hotel-app">
  {!playground&&<header className="hotel-header"><div className="brand"><span className="room-number">home</span><div><h1>{playground?'Layout playground':'Apartment Hotel'}</h1><p>{playground?'Try ideas without changing the live home.':'Your place, pixel by pixel.'}</p></div></div><div className="header-actions"><span className={`connection ${liveHass?'online':''}`}>{playground?'Browser copy':liveHass?'Home Assistant connected':'Layout editor · offline'}</span><button onClick={()=>setShowInfo(!showInfo)} aria-expanded={showInfo}>About this plan</button></div></header>}
  <div className="editor-layout"><section className="workspace" aria-label="Apartment editor">
   {playground?<div className="stage-toolbar">
    <div className="toolbar-primary"><button title="Rotate view left" aria-label="Rotate view anticlockwise" onClick={()=>setQ(previousCameraQuarter)}><ArrowLeft size={18}/></button><button title="Rotate view right" aria-label="Rotate view clockwise" onClick={()=>setQ(nextCameraQuarter)}><ArrowRight size={18}/></button>
    <button onClick={()=>{setPlanView(!planView);setHover(null);}} aria-pressed={planView}>{planView?'3D view':'Floor plan'}</button>
    <button aria-label="Undo" title="Undo · ⌘Z" disabled={!history.length} onClick={undo}><Undo2 size={18}/></button><button aria-label="Redo" title="Redo · ⇧⌘Z" disabled={!future.length} onClick={redo}><Redo2 size={18}/></button></div>
    <details className="view-options"><summary>View</summary><div className="view-options-content">
     <label>Walls<select aria-label="Wall display" value={walls} onChange={e=>{const v=e.target.value;if(v==='full'||v==='cutaway'||v==='low'||v==='hidden')setWalls(v);}}><option value="cutaway">Cutaway</option><option value="full">Full</option><option value="low">Low</option><option value="hidden">Hidden</option></select></label>
     <label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)}/>Grid</label><label><input type="checkbox" checked={fittings} onChange={e=>setFittings(e.target.checked)}/>Fittings</label><label><input type="checkbox" checked={downlights} onChange={e=>setDownlights(e.target.checked)}/>Ceiling lights</label>
     <label>Lighting<select aria-label="Scene lighting" value={environment.mode} onChange={e=>{const mode=e.target.value;if(mode==='live'||mode==='day'||mode==='sunset'||mode==='night')setEnvironment(v=>({...v,mode}));}}><option value="day">Day</option><option value="sunset">Sunset</option><option value="night">Night</option><option value="live">Live</option></select></label>
     <label><input type="checkbox" checked={environment.previewLights} onChange={e=>setEnvironment(v=>({...v,previewLights:e.target.checked}))}/>Lamps on</label>
     <button onClick={()=>setZoom(v=>v===1?2:1)}>{zoom===1?'Zoom in':'Fit room'}</button>
    </div></details>
   </div>:<>   <div className="stage-toolbar"><div className="segmented"><button onClick={()=>setQ(previousCameraQuarter)} aria-label="Rotate view anticlockwise">↶</button><span>View {q+1} / 4</span><button onClick={()=>setQ(nextCameraQuarter)} aria-label="Rotate view clockwise">↷</button></div><div className="toolbar-toggles"><button onClick={()=>setPlanView(!planView)} aria-pressed={planView}>{planView?'Isometric':'Floorplan'}</button><button className={fittings?'active':''} aria-pressed={fittings} onClick={()=>setFittings(!fittings)}>Fittings</button><button className={grid?'active':''} aria-pressed={grid} onClick={()=>setGrid(!grid)}>Grid</button><button className={labels?'active':''} aria-pressed={labels} onClick={()=>setLabels(!labels)}>Rooms</button><label className="sr-only" htmlFor="walls">Wall display</label><select id="walls" value={walls} onChange={e=>{const v=e.target.value;if(v==='full'||v==='cutaway'||v==='low'||v==='hidden')setWalls(v);}}><option value="full">Full walls</option><option value="cutaway">Exterior cutaway</option><option value="low">Low walls</option><option value="hidden">No walls</option></select></div></div>
   <div className="lighting-toolbar"><label>Lighting <select aria-label="Scene lighting" value={environment.mode} onChange={e=>{const mode=e.target.value;if(mode==='live'||mode==='day'||mode==='sunset'||mode==='night')setEnvironment(previous=>({...previous,mode}));}}><option value="live">Live</option><option value="day">Preview day</option><option value="sunset">Preview sunset</option><option value="night">Preview night</option></select></label>{environment.mode!=='live'&&<label><input type="checkbox" checked={environment.previewLights} onChange={e=>setEnvironment(previous=>({...previous,previewLights:e.target.checked}))}/> Preview lights</label>}<label><input type="checkbox" checked={downlights} onChange={e=>{setDownlights(e.target.checked);try{localStorage.setItem('apartment-hotel-downlights-visible',String(e.target.checked));}catch{/* The toggle still works when browser storage is unavailable. */}}}/> Show downlights</label><span>{environment.mode!=='live'?'Preview only · real lights are unchanged':daylight.source==='astronomical'?'Live daylight · balcony 41° NE':daylight.source==='home-assistant'?'Sun and lights from Home Assistant':'Calculating balcony daylight…'}</span></div>
</>}
   <div className={`canvas-scroll ${placing?'is-placing':moving?'is-moving':''}`} ref={stageRef}><div className="canvas-stack" style={{width:WIDTH*scale*zoom,height:HEIGHT*scale*zoom}}><canvas key={rendererAttempt} ref={worldCanvasRef} width={WIDTH} height={HEIGHT} style={{width:WIDTH*scale*zoom,height:HEIGHT*scale*zoom,display:planView?'none':'block'}} aria-hidden="true"/><canvas ref={canvasRef} width={WIDTH} height={HEIGHT} style={{width:WIDTH*scale*zoom,height:HEIGHT*scale*zoom}} onPointerMove={pointerMove} onPointerLeave={()=>{if(!drag.current)setHover(null);}} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={cancelPlacement} aria-label="Apartment layout. Click furniture to edit, drag to move, or choose a catalogue item to place." tabIndex={0}/></div></div>
   {playground?<div className="edit-toolbar" aria-label="Item actions"><span>{placing?productFor(placing)?.name:product?.name??"Choose furniture · drag items to move"}</span>{(placing||current)&&<><button onClick={rotate} title="Rotate · R"><RotateCw size={16}/>Rotate</button><button onClick={rotateHalf} aria-label="Rotate item 180 degrees" title="Rotate 180°">180°</button>{!placing&&!moving&&<button onClick={startMove}><Move size={16}/>Move</button>}{!placing&&!moving&&current&&<button onClick={()=>removeSelected(current.id)} aria-label="Remove selected item" title="Remove"><Trash2 size={16}/></button>}<button onClick={()=>{cancelPlacement();if(!placing&&!moving)setSelected(null);}} aria-label={placing||moving?"Cancel placement":"Deselect"}><X size={16}/>{placing||moving?"Cancel":""}</button></>}</div>:<div className="stage-bottom"><span className="plan-tag">WEST END <span>•</span> 1 BED <span>•</span> 5 CM PLACEMENT</span><div><button onClick={()=>setZoom(z=>z===1?2:1)}>{zoom===1?'+ Zoom':'− Zoom'}</button>{!playground&&<button aria-pressed={showCats} className={showCats?'active':''} onClick={()=>setShowCats(!showCats)}>Pearl & Maree {showCats?'on':'off'}</button>}</div></div>}
   <div className="status-bar" role="status"><span>{items.some(overlapsFitting)?'An existing item overlaps a fixed fitting. Select it and move it to a clear spot.':status}</span><span>{playground?persistence.save.state==='local'?'Saved':persistence.save.message:items.length+' items · '+persistence.save.message}</span></div>
   {['offline','conflict','error'].includes(persistence.save.state)&&<div className="info-panel" role="alert"><p>{persistence.save.message}</p><button onClick={()=>void persistence.retry()}>Retry sync</button>{persistence.save.state==='conflict'&&<><button onClick={exportLayout}>Export my draft</button><button onClick={()=>void persistence.useShared()}>Keep draft backup and load shared layout</button></>}</div>}
   {showInfo&&<div className="info-panel"><h2>Built from the published floorplan</h2><p className="small">Scene version: {SCENE_VERSION}</p><p>Bedroom 3.6 × 4.0 m, balcony 1.4 × 4.8 m, living / dining 4.4 × 5.4 m. Wall positions are traced estimates from a conceptual sales drawing. Furniture sizes use product dimensions where available.</p><p>The kitchen and bathroom fittings follow the listing photos, with estimated dimensions. Laundry and cupboard interiors are omitted; their closed doors remain visible. Use Fittings to see the empty shell. Ceiling light positions are approximations. {!playground&&'Cats choose when to explore, play, groom or nap. Their positions are decorative, not live tracking. '}Vacuum location needs map calibration.</p></div>}
  </section>
  <aside className="catalogue">
   {playground&&current&&product?<PlaygroundInspector item={current} items={items} product={product} onChange={changeItem} onClose={()=>{cancelPlacement();setSelected(null);}}/>:null}
   {!playground&&<div className="catalogue-heading"><div>{!playground&&<span className="eyebrow">MAKE YOURSELF AT HOME</span>}<h2>{playground?'Furniture':'Your collection'}</h2></div>{!playground&&<span className="count">{CATALOG.length}</span>}</div>}
   <details className="arrangement-presets"><summary>Quick arrangements</summary><div><button onClick={()=>{const result=arrangePhotoObjects(items);if(result.added)commit(result.items);setStatus(`Added ${result.added} photo decorations.${result.skipped.length?' No clear space for: '+result.skipped.join(', ')+'.':''}`);}}>Arrange objects from my photos</button>
   <button onClick={()=>{const result=arrangeLatestPhotos(items);if(result.added||result.dressed)commit(result.items);setStatus(`Added ${result.added} kitchen and room objects; dressed ${result.dressed} lounge seats.${result.skipped.length?' No clear space for: '+result.skipped.join(', ')+'.':''}`);}}>Add kitchen, chairs and textiles</button>
   <button onClick={()=>{const next=addLeaningMirror(items);if(next.length>items.length){commit(next);setStatus('Added the leaning mirror beside the kitchen.');}else setStatus(items.some(i=>i.productId==='ikornnes')?'The leaning mirror is already placed.':'The mirror spot is occupied. Place it from the catalogue instead.');}}>Add leaning mirror</button></div></details>
   <div className="tabs" role="tablist">{(['Furniture','Lighting','Home Assistant'] satisfies readonly typeof tab[]).filter(t=>!playground||t!=='Home Assistant').map(t=><button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{t==='Home Assistant'?'Devices':t}</button>)}</div>
   {tab!=='Home Assistant'?<><label className="search"><span>⌕</span><input aria-label="Search furniture" placeholder="Search furniture" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="catalogue-list">{CATALOG.filter(p=>p.category===tab&&`${p.name} ${p.detail}`.toLowerCase().includes(query.toLowerCase())).map(p=><button key={p.id} className={`product-card ${placing===p.id?'chosen':''}`} onClick={()=>choose(p.id)}><span className="product-image" style={{height:96,backgroundSize:'contain',backgroundPosition:'center',backgroundImage:`url(${spriteBase}/${p.id+'-catalogue'}.png?v=${spriteVersions.get(p.id+'-catalogue')??modelManifest.version})`}}/><span className="product-copy"><strong>{p.name}</strong>{!playground&&<><span>{p.detail}</span><small>{Math.round(p.w*1000)/10} × {Math.round(p.d*1000)/10} × {Math.round(p.h*1000)/10} cm{p.approximate?' · approx.':''}</small><span className={`purchase-tag ${p.purchased?'':'generic'}`}>{p.purchased?'From your purchases':p.id==='sofa'||p.id==='table'?'Generic furniture':'Your reference'}</span></>}</span><span className="add-sign">+</span></button>)}</div>{!playground&&<p className="catalogue-note">Select a piece, then click the floor or a suitable surface.</p>}</>:<div className="device-panel"><h3>Your real lights</h3><p>{hass?'Select a placed lamp and bind it to a light below. State, brightness and colour come from Home Assistant and illuminate the room.':'Open this page in Home Assistant to see your devices. Use the labelled lighting previews to try day and night.'}</p><button onClick={()=>setDevices(!devices)} aria-pressed={devices}>{devices?'Hide':'Show'} ceiling light markers</button><p className="small">Ceiling light positions are estimated. The balcony faces 41° northeast, measured looking out from its edge. Live daylight uses the recorded balcony location, shared with the website.</p>{lightEntities.map(e=>{const l=lightState(e);return <div className="device-row" key={e.entity_id}><span className="light-dot" style={{background:l.state==='on'?l.color:'#4a3857'}}/><span>{friendly(e)}<small>{l.state}{l.state==='on'?` · ${Math.round(l.brightness*100)}%`:''}</small></span></div>;})}<h3>Robot vacuum</h3><button onClick={()=>choose('vacuum')}>Place vacuum dock</button><p>{vacuumEntity?`${friendly(vacuumEntity)} · ${vacuumEntity.state}`:'No live vacuum state in this preview.'}</p><p className="small">The robot appears at your placed dock while docked. During cleaning, its position is unknown. The live Ecovacs map is shown below when available.</p>{typeof vacuumMap==='string'&&<picture><img className="vacuum-map" src={vacuumMap} alt="Live Ecovacs vacuum map"/></picture>}</div>}
   {!playground&&current&&product&&<section className="selection"><span className="eyebrow">SELECTED ITEM</span><h3>{product.name}</h3><p>{product.source}</p><div className="selection-actions"><button onClick={()=>{setRotation(current.rotation);setMoving(true);setStatus('Click the new position. Escape cancels.');}}>Move</button><button onClick={rotate}>Rotate ↻</button><button onClick={()=>{removeSelected(current.id);}}>Remove</button></div><div className="position-controls"><label>X <input type="number" step="0.01" value={current.x} onChange={e=>{const next={...current,x:Number(e.target.value)};if(placeable(next,items))changeItem(next);}}/></label><label>Y <input type="number" step="0.01" value={current.z} onChange={e=>{const next={...current,z:Number(e.target.value)};if(placeable(next,items))changeItem(next);}}/></label></div><p className="small">W × D × H: {Math.round(product.w*1000)/10} × {Math.round(product.d*1000)/10} × {Math.round(product.h*1000)/10} cm{product.approximate?' · reference dimensions':''}</p>{product.note&&<p className="small">{product.note}</p>}{product.url&&<a href={product.url} target="_blank" rel="noreferrer">Product reference ↗</a>}
   {!!product.finishes?.length&&<label className="binding">Hex colour<input key={`${current.id}/${current.materialColor??''}/${current.finish??''}`} aria-label="Hex colour" type="text" required maxLength={7} pattern="#[0-9a-fA-F]{6}" defaultValue={current.materialColor??product.finishes.find(f=>f.id===current.finish)?.color??product.finishes[0]?.color??'#ffffff'} onBlur={e=>{if(e.currentTarget.checkValidity())commit(items.map(i=>i.id===current.id?{...i,materialColor:e.currentTarget.value.toLowerCase()}:i));else e.currentTarget.reportValidity();}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/></label>}
   {product.id==='lg-g4'&&<p className="small">Screen linked to Apple TV. Original animated artwork plays during playback, holds when paused and switches off with the player.</p>}
   {product.id==='casalino'&&<label className="binding"><input type="checkbox" checked={current.seatPad??false} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,seatPad:e.target.checked}:i))}/> Black seat cushion</label>}
   {product.id==='kirribilli'&&<label className="binding">Bedding set<select aria-label="Bedding set" value={current.bedding??BEDDING[0]?.id} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,bedding:e.target.value}:i))}>{BEDDING.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
   {!!product.finishes?.length&&<label className="binding">Material / colour<select aria-label="Material / colour" value={current.finish??product.finishes[0]?.id} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,finish:e.target.value}:i))}>{product.finishes.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
   {!!product.finishes?.length&&<fieldset className="surface-position"><legend>Custom material</legend><p className="small">Main finish only. Details and transparent plastic stay separate.</p><label className="binding">Colour<input aria-label="Custom material colour" type="color" value={current.materialColor??product.finishes.find(f=>f.id===current.finish)?.color??product.finishes[0]?.color??'#ffffff'} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,materialColor:e.target.value}:i))}/></label><label className="binding">Gloss · {Math.round((current.materialGloss??(current.finish==='clear'?.7:0))*100)}%<input aria-label="Material gloss" type="range" min="0" max="100" step="1" value={Math.round((current.materialGloss??(current.finish==='clear'?.7:0))*100)} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,materialGloss:Number(e.target.value)/100}:i))}/></label><button disabled={current.materialColor===undefined&&current.materialGloss===undefined} onClick={()=>{const next={...current};delete next.materialColor;delete next.materialGloss;commit(items.map(i=>i.id===current.id?next:i));}}>Reset custom material</button></fieldset>}
   {(product.placement==='wall'||product.placement==='small'||product.placement==='ceiling')&&<label className="binding">Base height above floor (cm)<input aria-label="Base height above floor (cm)" type="number" min="0" max={(2.7-product.h)*100} step="1" value={Math.round(baseHeight(current)*100)} onChange={e=>{const next={...current,elevation:Number(e.target.value)/100};changeItem(withSupport(next));}}/></label>}
   {product.placement==='small'&&<label className="binding">Place on a surface<select aria-label="Place on a surface" value="" onChange={e=>putOnSurface(e.target.value)}><option value="">Choose a table, shelf or bench…</option>{placementSurfaces(items).filter(s=>s.owner!==current.id&&s.use==='top'&&!items.some(i=>i.id===s.owner&&i.supportId===current.id)).map(s=><option key={s.id} value={s.id}>{productFor(items.find(i=>i.id===s.owner)?.productId??'')?.name??s.owner} · {Math.round(s.height*100)} cm</option>)}</select></label>}
   {support&&<fieldset className="surface-position"><legend>Position on surface</legend><p className="small">Slide the object without changing its height. It stays attached when the furniture moves.</p><label className="binding">Side to side · {Math.round(support.x*100)} cm<input aria-label="Side to side on surface" type="range" min={-Math.floor(support.maxX*100)} max={Math.floor(support.maxX*100)} step="1" value={Math.round(support.x*100)} onChange={e=>changeItem(slideOnSurface(current,items,Number(e.target.value)/100,support.z))}/></label><label className="binding">Front to back · {Math.round(support.z*100)} cm<input aria-label="Front to back on surface" type="range" min={-Math.floor(support.maxZ*100)} max={Math.floor(support.maxZ*100)} step="1" value={Math.round(support.z*100)} onChange={e=>changeItem(slideOnSurface(current,items,support.x,Number(e.target.value)/100))}/></label><button onClick={()=>changeItem(slideOnSurface(current,items,0,0))}>Centre on surface</button></fieldset>}
   {current.productId.startsWith('stoppino-')&&<label className="binding">Nest with another table<select aria-label="Nest with another table" value="" onChange={e=>{const target=items.find(i=>i.id===e.target.value);if(target){const next={...current,x:target.x,z:target.z,rotation:target.rotation,elevation:0};changeItem(withSupport(next));}}}><option value="">Choose another Stoppino size…</option>{items.filter(i=>i.productId.startsWith('stoppino-')&&i.productId!==current.productId).map(i=><option key={i.id} value={i.id}>{productFor(i.productId)?.name}</option>)}</select><span className="small">Each table stays independently selectable. Move to separate it.</span></label>}
   {product.category==='Lighting'&&<><label className="binding">Home Assistant light<select value={current.entityId} onChange={e=>commit(items.map(i=>i.id===current.id?{...i,entityId:e.target.value}:i))}><option value="">Choose a light</option>{current.entityId&&!lightEntities.some(e=>e.entity_id===current.entityId)&&<option value={current.entityId}>{current.entityId}</option>}{lightEntities.map(e=><option key={e.entity_id} value={e.entity_id}>{friendly(e)}</option>)}</select></label><button disabled={!hass||!current.entityId||lightState(hass?.states[current.entityId]).state==='unavailable'} onClick={async()=>{try{await hass?.callService('light','toggle',{entity_id:current.entityId});}catch{setStatus('Home Assistant could not change that light.');}}}>Toggle real light</button></>}</section>}
   <label className="binding placed-picker">Placed furniture<select aria-label="Select placed item" value={selected??''} onChange={e=>{setSelected(e.target.value||null);setPlacing(null);setMoving(false);}}><option value="">Select an item…</option>{items.map((i,index)=><option key={i.id} value={i.id}>{productFor(i.productId)?.name} · {index+1}</option>)}</select></label><footer className="layout-actions"><div><button disabled={!history.length} onClick={undo}>↶ Undo</button><button disabled={!future.length} onClick={redo}>↷ Redo</button></div><div><button onClick={exportLayout}>Export</button><button onClick={()=>importRef.current?.click()}>Import</button><input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async e=>{const f=e.target.files?.[0];if(!f)return;try{const next=parseItems(await f.text());commit(next);setSelected(null);setStatus('Layout imported.');}catch(error){setStatus(error instanceof Error?error.message:'Could not import layout.');}e.target.value='';}}/></div></footer>
  </aside></div>
 </main>;
}
