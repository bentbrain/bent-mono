import {useEffect,useRef,useState,useCallback} from 'react';
import {LayoutSession,LEGACY_LAYOUT,type SaveState} from './layoutPersistence';
import type {Item} from './editorState';
import type {Hass} from './ha';
export function useLayoutPersistence(hass:Hass|undefined,shared:boolean,receive:(items:Item[],remote:boolean)=>void,localKey:string=LEGACY_LAYOUT){
 const session=useRef<LayoutSession|null>(null),latest=useRef(hass),receiver=useRef(receive);
 const [save,setSave]=useState<{state:SaveState;message:string}>({state:'loading',message:'Loading saved layout…'});
 useEffect(()=>{latest.current=hass;receiver.current=receive;},[hass,receive]);
 useEffect(()=>{
  const transport=shared?async(message:Record<string,unknown>)=>{
   const current=latest.current;if(!current?.callWS||current.connected===false||current.connection?.connected===false)throw Error('Disconnected');
   return current.callWS(message);
  }:null;
  const value=new LayoutSession(localStorage,transport,(items,remote)=>receiver.current(items,remote),(state,message)=>setSave({state,message}),localKey);session.current=value;
  void value.start();
  const timer=setInterval(()=>{void value.retry();},15000);
  const refresh=()=>{void value.retry();};window.addEventListener('focus',refresh);
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(localStorage.getItem('apartment-hotel-pending-v1'))event.preventDefault();};
  window.addEventListener('beforeunload',beforeUnload);
  return()=>{clearInterval(timer);value.stop();window.removeEventListener('focus',refresh);window.removeEventListener('beforeunload',beforeUnload);};
 },[shared,localKey]);
 const edit=useCallback((items:Item[])=>{const value=session.current;if(!value?.edit(items))return false;void value.flush();return true;},[]);
 return {save,edit,retry:()=>session.current?.retry(),useShared:()=>session.current?.useShared()};
}
