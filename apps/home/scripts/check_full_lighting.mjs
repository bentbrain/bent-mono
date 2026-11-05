// Real renderer regression: both rooms at 100%, moving cats, all four cameras.
// The fixture reads the already-public layout; it never changes saved furniture or HA lights.
import {chromium,webkit} from 'playwright';
import {strict as assert} from 'node:assert';
import {mkdir} from 'node:fs/promises';
const root=process.cwd(),directory=root+'/runs/full-lighting';await mkdir(directory,{recursive:true});
const snapshot=await (await fetch(process.env.FULL_LIGHTING_LAYOUT_URL??'https://home.bent.build/api/layout')).json();
await Bun.write(directory+'/layout.json',JSON.stringify(snapshot));
await Bun.write(directory+'/main.ts',`
import {startApartmentWorld,type WorldOptions} from '../../app/worldScene';
import {parseItems} from '../../app/editorState';
import {DEFAULT_ENVIRONMENT} from '../../app/lighting';
import {simulatedLights} from '../../app/public-view/lighting';
import {parsePublicLayout} from '../../app/public-view/snapshot';
const canvas=document.querySelector('canvas');if(!canvas)throw Error('Missing canvas');
const layout=parsePublicLayout(await(await fetch('/layout.json')).json());
const items=parseItems(JSON.stringify(layout.items),true);
const {world}=startApartmentWorld(canvas);
const options:WorldOptions={q:0,items,selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',fittings:true,cats:[],frame:0,devices:false,vacuum:null,environment:{...DEFAULT_ENVIRONMENT,mode:'night'},sceneLights:simulatedLights(items,layout.roles,100,100,layout.ramps)};
world.update(options);await world.load('/models');Object.assign(window,{world,options});document.body.dataset.ready='true';
`);
const build=await Bun.build({entrypoints:[directory+'/main.ts'],outdir:directory,target:'browser'});assert.ok(build.success);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname;
 if(path==='/')return new Response('<canvas width="960" height="720"></canvas><script type="module" src="/main.js"></script>',{headers:{'Content-Type':'text/html'}});
 if(path==='/main.js')return new Response(Bun.file(process.env.FULL_LIGHTING_BASELINE??directory+'/main.js'));
 if(path==='/layout.json')return new Response(Bun.file(directory+'/layout.json'));
 const name=path.slice('/models/'.length);if(path.startsWith('/models/')&&/^[\w.-]+$/.test(name))return new Response(Bun.file(root+'/public/models/'+name));
 return new Response('Not found',{status:404});
}});
const browser=await (process.env.FULL_LIGHTING_BROWSER==='webkit'?webkit:chromium).launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
 const page=await browser.newPage({viewport:{width:960,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url.href+'?static');await page.waitForFunction(()=>document.body.dataset.ready==='true',{},{timeout:90000});await page.waitForTimeout(3000);
 const results=await page.evaluate(async()=>{
  const w=window.world,gl=document.querySelector('canvas').getContext('webgl2');w.setPresentationPaused(true);
  let draws=0,staticShadowDraws=0;
  for(const method of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){const draw=gl[method];gl[method]=function(...args){draws++;return draw.apply(this,args);};}
  for(const source of w.sources.values())source.shadow.onBeforeShadowMapRenderMeshObservable.add(mesh=>{if(!mesh.morphTargetManager&&!mesh.skeleton)staticShadowDraws++;});
  const next=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  async function frame(q,tick){w.update({...window.options,q,cats:[{id:'pearl',x:2.5+tick*.01,z:3,direction:0,animation:'walk',frame:tick%8},{id:'maree',x:6.5,z:3+tick*.01,direction:1,animation:'walk',frame:tick%8}]});w.setPresentationPaused(false);const start=performance.now();w.render(1000+tick*100);w.setPresentationPaused(true);const ms=performance.now()-start;await next();return ms;}
  const results=[];
  for(let q=0;q<4;q++){
   for(let i=0;i<8;i++)await frame(q,i);draws=0;staticShadowDraws=0;const times=[];
   for(let i=8;i<28;i++)times.push(await frame(q,i));
   const pixels=new Uint8Array(960*720*4);gl.readPixels(0,0,960,720,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let visiblePixels=0;
   for(let i=0;i<pixels.length;i+=4)if(Math.abs(pixels[i]-pixels[0])+Math.abs(pixels[i+1]-pixels[1])+Math.abs(pixels[i+2]-pixels[2])>30)visiblePixels++;
   results.push({q,visiblePixels,drawsPerFrame:draws/20,staticShadowDraws,p95:times.sort((a,b)=>a-b)[18],glError:gl.getError(),contextLost:gl.isContextLost()});
  }
  const cacheBytes=w.shadowCachePool?.bytes??0;w.dispose();return {views:results,cacheBytes,disposedCacheBytes:w.shadowCachePool?.bytes??0};
 });
 console.log(JSON.stringify({items:snapshot.items.length,results,errors}));
 assert.ok(results.cacheBytes>0&&results.cacheBytes<=48*1024*1024);assert.equal(results.disposedCacheBytes,0);
 for(const result of results.views){assert.equal(result.staticShadowDraws,0,'Moving cats must reuse the static lamp shadows');assert.ok(result.drawsPerFrame<4000,`Full-brightness draw budget exceeded: ${result.drawsPerFrame}`);assert.equal(result.glError,0);assert.equal(result.contextLost,false);assert.ok(result.visiblePixels>50000,'The furnished room must remain visible at full brightness');}
 assert.deepEqual(errors,[]);await page.locator('canvas').screenshot({path:directory+'/full-brightness.png'});
}finally{await browser.close();server.stop();}
