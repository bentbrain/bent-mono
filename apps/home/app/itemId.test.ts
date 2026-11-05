import {expect,test} from 'bun:test';
import {createItemId} from './itemId';
import {placeable,parseItems,type Item} from './editorState';
test('Placement IDs work with the Crypto API available on local HTTP',()=>{
 const localHttpCrypto:Pick<Crypto,'getRandomValues'>={getRandomValues:crypto.getRandomValues.bind(crypto)};
 expect('randomUUID' in localHttpCrypto).toBe(false);
 const ids=new Set(Array.from({length:1000},()=>createItemId(localHttpCrypto)));
 expect(ids.size).toBe(1000);
 const item:Item={id:createItemId(localHttpCrypto),productId:'casalino',x:2.5,z:3.5,rotation:0,entityId:''};
 expect(placeable(item,[])).toBe(true);expect(parseItems(JSON.stringify([item]))).toEqual([item]);
});
