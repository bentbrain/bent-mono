import {createRoot,type Root} from 'react-dom/client';
import {ApartmentEditor} from './ApartmentEditor';
import type {Hass} from './ha';
import styles from './globals.css?inline';
/** Native Lovelace card: HA owns authentication and pushes every state update. */
class ApartmentHotelCard extends HTMLElement {
 private reactRoot:Root|null=null;
 private value:Hass|undefined;
 private revision=0;
 private spriteBase='/local/apartment-hotel/sprites';
 setConfig(config:unknown):void {
  if(typeof config==='object'&&config!==null&&'sprite_base'in config&&typeof config.sprite_base==='string')this.spriteBase=config.sprite_base;
  this.paint();
 }
 set hass(value:Hass){this.value=value;this.revision++;this.paint();}
 connectedCallback():void {
  if(!this.shadowRoot){const shadow=this.attachShadow({mode:'open'});const style=document.createElement('style');style.textContent=`:host{display:block;--ink:#251d2f;--paper:#fffef3;--sky:#86d4e8;--focus:#277f7e;--muted:#786d72;--line:#ddd6c5;background:#f4f1e6;color:#251d2f;font-family:system-ui,sans-serif}${styles}`;shadow.append(style);const mount=document.createElement('div');shadow.append(mount);this.reactRoot=createRoot(mount);}else if(!this.reactRoot){const mount=this.shadowRoot.querySelector('div');if(mount)this.reactRoot=createRoot(mount);}this.paint();
 }
 disconnectedCallback():void {this.reactRoot?.unmount();this.reactRoot=null;}
 private paint():void {if(!this.isConnected)return;this.reactRoot?.render(<ApartmentEditor sharedLayout {...(this.value?{hass:this.value}:{})} spriteBase={this.spriteBase} hassRevision={this.revision}/>);}
 getCardSize():number{return 12;}
}
if(!customElements.get('apartment-hotel-card'))customElements.define('apartment-hotel-card',ApartmentHotelCard);
