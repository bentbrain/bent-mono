'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import './playground.css';
import {ApartmentEditor} from '../ApartmentEditor';
import {createItemId} from '../itemId';
import {PLAYGROUND_INDEX_KEY,nextPlaygroundName,playgroundLayoutKey,readPlaygroundIndex,type PlaygroundIndex,type PlaygroundVersion} from '../playgroundStore';

function firstIndex():PlaygroundIndex{
 const id=createItemId();
 return {activeId:id,versions:[{id,name:'Layout 1'}]};
}

export function Playground(){
 const [index,setIndex]=useState<PlaygroundIndex|null>(null),[draftName,setDraftName]=useState(''),[error,setError]=useState('');
 useEffect(()=>{
  const frame=requestAnimationFrame(()=>{try{
    const raw=localStorage.getItem(PLAYGROUND_INDEX_KEY),next=raw?readPlaygroundIndex(raw):firstIndex();
    if(!raw){localStorage.setItem(playgroundLayoutKey(next.activeId),'[]');localStorage.setItem(PLAYGROUND_INDEX_KEY,JSON.stringify(next));}
    setIndex(next);setDraftName(next.versions.find(item=>item.id===next.activeId)?.name??'');
   }catch{
    try{
     const raw=localStorage.getItem(PLAYGROUND_INDEX_KEY);if(raw)localStorage.setItem(`${PLAYGROUND_INDEX_KEY}-recovery-${Date.now()}`,raw);
     const next=firstIndex();localStorage.setItem(playgroundLayoutKey(next.activeId),'[]');localStorage.setItem(PLAYGROUND_INDEX_KEY,JSON.stringify(next));setIndex(next);setDraftName(next.versions[0]?.name??'');
    }catch{setError('This browser blocked local storage, so the playground cannot save layouts.');}
   }});
  return()=>cancelAnimationFrame(frame);
 },[]);
 const active=index?.versions.find(item=>item.id===index.activeId);

 function saveIndex(next:PlaygroundIndex):boolean{
  try{localStorage.setItem(PLAYGROUND_INDEX_KEY,JSON.stringify(next));if(index?.activeId!==next.activeId)setDraftName(next.versions.find(item=>item.id===next.activeId)?.name??'');setIndex(next);setError('');return true;}
  catch{setError('This browser could not save the version list.');return false;}
 }
 function addVersion(copy:boolean){
  if(!index)return;
  const nextVersion:PlaygroundVersion={id:createItemId(),name:copy?`${active?.name??'Layout'} copy`:nextPlaygroundName(index.versions)};
  try{
   const source=copy?localStorage.getItem(playgroundLayoutKey(index.activeId)):null;
   localStorage.setItem(playgroundLayoutKey(nextVersion.id),source??'[]');
   saveIndex({activeId:nextVersion.id,versions:[...index.versions,nextVersion]});
  }catch{setError('This browser could not create another layout.');}
 }
 function rename(){
  if(!index||!active)return;
  const name=draftName.trim();if(!name){setDraftName(active.name);return;}
  saveIndex({...index,versions:index.versions.map(item=>item.id===active.id?{...item,name}:item)});
 }
 function remove(){
  if(!index||!active||index.versions.length===1||!window.confirm(`Delete "${active.name}" from this browser?`))return;
  const versions=index.versions.filter(item=>item.id!==active.id),next={activeId:versions[0]?.id??'',versions};
  if(saveIndex(next))try{localStorage.removeItem(playgroundLayoutKey(active.id));}catch{setError('The version was removed from the list, but its browser data could not be deleted.');}
 }
 if(!index||!active)return <main className="playground-loading" role="status">{error||'Opening playground…'}</main>;
 return <div className="playground-shell">
  <nav className="version-bar" aria-label="Playground versions">
   <Link className="playground-home" href="/" aria-label="Back to home">home / playground</Link>
   <div className="version-picker"><select aria-label="Layout version" id="playground-version" value={active.id} onChange={event=>saveIndex({...index,activeId:event.target.value})}>{index.versions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
   <div className="version-actions"><button onClick={()=>addVersion(false)}>New</button><button onClick={()=>addVersion(true)}>Duplicate</button></div>
   <details className="version-menu"><summary aria-label="Layout options">More</summary><div className="version-menu-content">
    <label htmlFor="playground-name">Layout name</label><input id="playground-name" value={draftName} maxLength={60} onChange={event=>setDraftName(event.target.value)} onBlur={rename} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}/>
    <p>Auto-saved in this browser. Export a layout to keep a backup.</p><button disabled={index.versions.length===1} onClick={remove}>Delete layout</button>
   </div></details>
   {error&&<p className="version-error" role="alert">{error}</p>}
  </nav>
  <ApartmentEditor key={active.id} localLayoutKey={playgroundLayoutKey(active.id)} playground/>
 </div>;
}
