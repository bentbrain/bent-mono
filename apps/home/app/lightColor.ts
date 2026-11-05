import type {Entity} from './ha';
function byte(n:number):number{return Math.max(0,Math.min(255,Math.round(n)));}
export function kelvinColor(kelvin:number):[number,number,number]{
 const t=Math.max(1000,Math.min(40000,kelvin))/100;
 return [byte(t<=66?255:329.698727446*(t-60)**-.1332047592),byte(t<=66?99.4708025861*Math.log(t)-161.1195681661:288.1221695283*(t-60)**-.0755148492),byte(t>=66?255:t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307)];
}
export function entityColor(entity:Entity):[number,number,number]{
 const a=entity.attributes,rgb=a.rgb_color;
 const temperature=typeof a.color_temp_kelvin==='number'&&Number.isFinite(a.color_temp_kelvin)&&a.color_temp_kelvin>0?a.color_temp_kelvin:typeof a.color_temp==='number'&&Number.isFinite(a.color_temp)&&a.color_temp>0?1e6/a.color_temp:undefined;
 if(a.color_mode==='color_temp'&&temperature!==undefined)return kelvinColor(temperature);
 if(Array.isArray(rgb)&&rgb.length===3){const [r,g,b]=rgb;if(typeof r==='number'&&typeof g==='number'&&typeof b==='number'&&[r,g,b].every(Number.isFinite))return[byte(r),byte(g),byte(b)];}
 if(typeof a.color_temp_kelvin==='number'&&Number.isFinite(a.color_temp_kelvin))return kelvinColor(a.color_temp_kelvin);
 if(typeof a.color_temp==='number'&&Number.isFinite(a.color_temp)&&a.color_temp>0)return kelvinColor(1e6/a.color_temp);
 return[255,224,163];
}
