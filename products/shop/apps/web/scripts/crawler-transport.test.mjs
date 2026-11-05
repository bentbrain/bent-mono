import {createServer} from 'node:http';
import {once} from 'node:events';
import {request} from '@playwright/test';
import {expect,it} from 'vitest';
import {requestCrawlerPage} from '../e2e/crawler-request';
async function exercise(handler,check){
 let calls=0;
 const server=createServer((req,res)=>handler(req,res,++calls));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address || typeof address==='string')throw Error('Loopback TCP listener required.');
 const client=await request.newContext();
 try{await check(()=>requestCrawlerPage(client,`http://127.0.0.1:${address.port}/create`,'Googlebot'),()=>calls);}
 finally{await client.dispose();server.close();await once(server,'close');}
}
it('checks the actual crawler response after one TCP reset without rerunning the browser suite',async()=>{
 await exercise((req,res,count)=>{
  expect(req.headers['user-agent']).toBe('Googlebot');
  if(count===1)req.socket.resetAndDestroy();else res.end('<meta name="robots" content="noindex, nofollow">');
 },async(get,calls)=>{
  const response=await get();expect(response.ok()).toBe(true);
  expect(await response.text()).toContain('noindex, nofollow');expect(calls()).toBe(2);
 });
});
it('fails after a second connection reset instead of retrying indefinitely',async()=>{
 await exercise(req=>req.socket.resetAndDestroy(),async(get,calls)=>{
  await expect(get()).rejects.toThrow(/ECONNRESET|socket hang up|retries/i);expect(calls()).toBe(2);
 });
});
it('does not retry HTTP errors or follow redirects',async()=>{
 for(const status of [503,302])await exercise((_req,res)=>{
  res.writeHead(status,{Location:'/unexpected'});res.end('upstream response');
 },async(get,calls)=>{
  const response=await get();expect(response.status()).toBe(status);expect(response.ok()).toBe(false);expect(calls()).toBe(1);
 });
});
