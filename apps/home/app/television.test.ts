import {expect,test} from 'bun:test';
import {televisionMode,televisionPixels,TelevisionClock,TV_WIDTH,TV_HEIGHT} from './television';
import {APPLE_TV_ENTITY,type Hass} from './ha';
const player=(state:string):Hass=>({states:{[APPLE_TV_ENTITY]:{entity_id:APPLE_TV_ENTITY,state,attributes:{}}},callService:async()=>{throw Error('Display must not control playback');}});
test('Apple TV playback states drive the display; unavailable and disconnected never glow',()=>{
 for(const state of ['off','standby','unknown','unavailable'])expect(televisionMode(player(state))).toBe('off');
 expect(televisionMode(player('playing'))).toBe('playing');expect(televisionMode(player('paused'))).toBe('paused');
 for(const state of ['on','idle'])expect(televisionMode(player(state))).toBe('idle');
 expect(televisionMode({...player('playing'),connected:false})).toBe('off');expect(televisionMode(undefined)).toBe('off');expect(televisionMode(undefined,true)).toBe('playing');
});
test('Pixel artwork animates during playback, freezes on pause and resumes without a time jump',()=>{
 const clock=new TelevisionClock();clock.advance(0,'playing');
 const a=clock.advance(200,'playing'),b=clock.advance(400,'playing');expect(b).toBeGreaterThan(a);
 expect(clock.advance(600,'paused')).toBe(b);expect(clock.advance(10000,'paused')).toBe(b);
 expect(clock.advance(12000,'playing')).toBe(b);expect(clock.advance(12200,'playing')).toBeGreaterThan(b);
 expect(televisionPixels('playing',0)).not.toEqual(televisionPixels('playing',40));
 expect(televisionPixels('paused',40)).toEqual(televisionPixels('playing',40));
 expect(televisionPixels('playing',0).length).toBe(TV_WIDTH*TV_HEIGHT*4);
 expect(clock.advance(13000,'off')).toBe(0);
});
test('TV cycles four distinct pictures every eight seconds and keeps the paused picture',()=>{
 const pictures=[0,64,128,192].map(frame=>televisionPixels('playing',frame));
 for(let i=0;i<pictures.length;i++)for(let j=i+1;j<pictures.length;j++)expect(pictures[i]).not.toEqual(pictures[j]);
 for(const frame of [0,64,128,192])expect(televisionPixels('paused',frame)).toEqual(televisionPixels('playing',frame));
});
