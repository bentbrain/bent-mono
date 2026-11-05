import {parseItems,type Item} from './editorState';
import {createItemId} from './itemId';
export const LEGACY_LAYOUT='apartment-hotel-layout-v2';
export const SHARED_CACHE='apartment-hotel-shared-cache-v1';
export const PENDING_LAYOUT='apartment-hotel-pending-v1';
export interface LayoutDocument {revision:number;items:Item[]}
interface Pending extends LayoutDocument {requestId:string}
export interface LayoutStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
export type LayoutTransport=(message:Record<string,unknown>)=>Promise<unknown>;
export type SaveState='loading'|'saved'|'saving'|'offline'|'conflict'|'error'|'local';
export function readDocument(value:unknown):LayoutDocument{
 if(typeof value!=='object'||value===null||!('revision'in value)||typeof value.revision!=='number'||!Number.isInteger(value.revision)||value.revision<0||!('items'in value))throw Error('Invalid saved layout');
 return {revision:value.revision,items:parseItems(JSON.stringify(value.items),true)};
}
function readPending(raw:string):Pending{
 const value:unknown=JSON.parse(raw),doc=readDocument(value);
 if(typeof value!=='object'||value===null||!('requestId'in value)||typeof value.requestId!=='string')throw Error('Invalid saved draft');
 return {...doc,requestId:value.requestId};
}
/** No write on mount. Only explicit edits can save, against the revision that was read. */
export class LayoutSession{
 private doc:LayoutDocument|null=null;
 private pending:Pending|null=null;
 private busy=false;
 private fetching=false;
 private stopped=false;
 private blocked=false;
 private state:SaveState='loading';
 constructor(private storage:LayoutStorage,private transport:LayoutTransport|null,private changed:(items:Item[],remote:boolean)=>void,private report:(state:SaveState,message:string)=>void,private localKey:string=LEGACY_LAYOUT){}
 private status(state:SaveState,message:string){this.state=state;if(!this.stopped)this.report(state,message);}
 private show(items:Item[],remote=false){if(!this.stopped)this.changed(items,remote);}
 private preserve(key:string,raw:string){if(!this.storage.getItem(key))this.storage.setItem(key,raw);}
 async start():Promise<void>{
  try{
   const original=this.storage.getItem(this.localKey);
   if(original)this.preserve('apartment-hotel-before-shared-v1',original);
   if(!this.transport){this.doc={revision:0,items:original?parseItems(original,true):[]};this.show(this.doc.items);this.status('local','Saved in this browser');return;}
   const cache=this.storage.getItem(SHARED_CACHE);if(cache){this.doc=readDocument(JSON.parse(cache));this.show(this.doc.items);}else if(original)this.show(parseItems(original,true));
   const draft=this.storage.getItem(PENDING_LAYOUT);if(draft){this.pending=readPending(draft);this.doc={revision:this.pending.revision,items:this.pending.items};this.show(this.pending.items);await this.flush();return;}
   await this.refresh();
  }catch{this.blocked=true;this.status('error','Saved data could not be read. Original copies have been kept.');}
 }
 canEdit():boolean{return this.doc!==null&&!this.blocked&&!['loading','conflict','error'].includes(this.state);}
 edit(items:Item[]):boolean{
  if(!this.canEdit()||!this.doc)return false;
  try{
   if(!this.transport){this.storage.setItem(this.localKey,JSON.stringify(items));this.doc={revision:0,items};this.show(items);this.status('local','Saved in this browser');return true;}
   const pending={revision:this.doc.revision,items,requestId:createItemId()};
   this.storage.setItem(PENDING_LAYOUT,JSON.stringify(pending));this.pending=pending;
   this.show(items);this.status('saving','Saving to Home Assistant…');return true;
  }catch{this.status('error','Browser backup failed. This edit was not applied.');return false;}
 }
 async flush():Promise<void>{
  if(!this.transport||!this.pending||this.busy||this.stopped||this.blocked)return;
  this.busy=true;const draft=this.pending;this.status('saving','Saving to Home Assistant…');
  try{
   const saved=readDocument(await this.transport({type:'apartment_hotel/layout/save',items:draft.items,expected_revision:draft.revision,request_id:draft.requestId,allow_empty:draft.items.length===0}));
   this.doc=saved;this.storage.setItem(SHARED_CACHE,JSON.stringify(saved));
   if(this.pending===draft){this.storage.removeItem(PENDING_LAYOUT);this.pending=null;this.status('saved','Saved in Home Assistant');}
   else if(this.pending){this.pending={...this.pending,revision:saved.revision};this.storage.setItem(PENDING_LAYOUT,JSON.stringify(this.pending));}
  }catch(error){
   const conflict=typeof error==='object'&&error!==null&&'code'in error&&error.code==='conflict';
   this.blocked=conflict;
   this.status(conflict?'conflict':'offline',conflict?'Another tab saved a newer layout. Your draft is kept here. Export it before loading the shared layout.':'Not synced. Your draft is backed up in this browser; retry when connected.');
  }finally{this.busy=false;}
  if(this.pending&&this.pending!==draft&&!this.blocked&&this.state!=='offline')await this.flush();
 }
 async refresh():Promise<void>{
  if(!this.transport||this.pending||this.busy||this.fetching||this.stopped||this.blocked)return;
  this.fetching=true;
  try{
   const result=await this.transport({type:'apartment_hotel/layout/get'});
   if(this.pending||this.stopped)return;
   if(result===null){this.status('error','Shared layout is not initialised. Your original browser layout has been kept.');return;}
   const next=readDocument(result);
   if(!this.doc||this.doc.revision!==next.revision){this.storage.setItem(SHARED_CACHE,JSON.stringify(next));this.doc=next;this.show(next.items,true);}
   this.status('saved','Saved in Home Assistant');
  }catch{this.status('offline','Shared layout is unavailable. Showing the last saved copy.');}
  finally{this.fetching=false;}
 }
 async retry(){if(this.blocked)return;if(this.pending)await this.flush();else await this.refresh();}
 async useShared(){
  if(this.busy)return;
  try{
   if(this.pending){this.storage.setItem('apartment-hotel-recovered-draft-'+Date.now(),JSON.stringify(this.pending));this.storage.removeItem(PENDING_LAYOUT);}
   this.pending=null;this.blocked=false;this.doc=null;await this.refresh();
  }catch{this.status('error','Could not preserve your draft. It has not been replaced.');}
 }
 stop(){this.stopped=true;}
}
