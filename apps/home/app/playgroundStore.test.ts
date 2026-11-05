import {expect,test} from 'bun:test';
import {nextPlaygroundName,playgroundLayoutKey,readPlaygroundIndex} from './playgroundStore';

test('playground versions round-trip and require a valid active version',()=>{
 const value={activeId:'one',versions:[{id:'one',name:'First idea'},{id:'two',name:'Second idea'}]};
 expect(readPlaygroundIndex(JSON.stringify(value))).toEqual(value);
 expect(()=>readPlaygroundIndex(JSON.stringify({...value,activeId:'missing'}))).toThrow('Invalid playground index');
});

test('playground names fill the first available numbered slot',()=>{
 expect(nextPlaygroundName([{id:'one',name:'Layout 1'},{id:'three',name:'Layout 3'}])).toBe('Layout 2');
 expect(playgroundLayoutKey('abc')).toBe('apartment-hotel-playground-layout-v1-abc');
});
