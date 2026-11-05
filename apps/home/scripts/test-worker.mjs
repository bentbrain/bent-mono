import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

const require=createRequire(import.meta.url);
const wrangler=join(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js');
const storage=await mkdtemp(join(tmpdir(),'bent-home-worker-'));
const reservation=createServer();
await new Promise((resolve,reject)=>reservation.once('error',reject).listen(0,'127.0.0.1',resolve));
const address=reservation.address();
if(!address||typeof address==='string')throw new Error('Unable to reserve test port');
const port=address.port;
await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
const worker=spawn(process.execPath,[wrangler,'dev','--local','--config','dist/server/wrangler.json','--ip','127.0.0.1','--port',String(port),'--persist-to',storage,'--var','PUBLIC_SYNC_TOKEN:worker-smoke-only'],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let output='';
const closed=new Promise(resolve=>worker.once('close',resolve));
try{
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Worker startup timed out\n'+output)),30000);
  const collect=chunk=>{
   output=(output+chunk.toString()).slice(-12000);
   if(output.includes('Ready on http://127.0.0.1:')){clearTimeout(timeout);resolve();}
  };
  worker.stdout.on('data',collect);worker.stderr.on('data',collect);
  worker.once('error',error=>{clearTimeout(timeout);reject(error);});
  worker.once('close',code=>{clearTimeout(timeout);reject(new Error('Worker exited '+code+'\n'+output));});
 });
 const base=`http://127.0.0.1:${port}/api/layout`;
 const initialResponse=await fetch(base);assert.equal(initialResponse.status,200);
 const initial=await initialResponse.json();assert.equal(initial.schema,1);
 const put=(layout,authenticated)=>fetch(base,{method:'PUT',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer worker-smoke-only'}:{})},body:JSON.stringify(layout)});
 const rejected=await put(initial,false);assert.equal(rejected.status,401);await rejected.text();
 // Keep this order: an unread rejected body previously broke the next Worker request.
 const next={...initial,revision:initial.revision+1};
 const saved=await put(next,true);assert.equal(saved.status,200,await saved.text());
 const stored=await fetch(base);assert.equal(stored.status,200);
 assert.equal((await stored.json()).revision,next.revision);
 const etag=stored.headers.get('etag');assert.ok(etag);
 const cached=await fetch(base,{headers:{'If-None-Match':etag}});assert.equal(cached.status,304);
 const stale=await put(initial,true);assert.equal(stale.status,409);await stale.text();
 console.log('Worker HTTP and local R2 passed: GET 200, rejected PUT 401, subsequent authorized PUT 200, stored revision, ETag 304, stale PUT 409.');
}finally{
 worker.kill('SIGTERM');
 await closed;
 await rm(storage,{recursive:true,force:true});
}
