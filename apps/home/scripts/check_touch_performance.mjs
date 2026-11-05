import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
 const page=await context.newPage();
 await page.clock.setFixedTime(new Date('2026-09-10T20:00:00+10:00'));
 await page.goto(process.env.TOUCH_TEST_URL??'http://localhost:3003/');await page.waitForFunction(()=>!document.querySelector('[role="status"]'),{},{timeout:90000});
 await page.waitForTimeout(3500);
 const cdp=await context.newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const box=await page.locator('.public-room').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
 await page.evaluate(()=>{
  window.drawProbe=0;const gl=document.querySelector('canvas').getContext('webgl2');for(const method of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){const draw=gl[method];gl[method]=function(...args){window.drawProbe++;return draw.apply(this,args);};}
  const frames=[],latencies=[];let previous=0,lastInput=0,active=true;
  const tick=now=>{if(previous)frames.push(now-previous);previous=now;if(active)requestAnimationFrame(tick);};requestAnimationFrame(tick);
  document.querySelector('.public-room').addEventListener('pointermove',()=>lastInput=performance.now());
  const observer=new MutationObserver(()=>{if(lastInput)latencies.push(performance.now()-lastInput);});observer.observe(document.querySelector('canvas'),{attributes:true,attributeFilter:['style']});
  window.finishTouchProbe=()=>{active=false;observer.disconnect();return {frames,latencies};};
 });
 const touch=(type,r,dx=0)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{id:1,x:x-r+dx,y},{id:2,x:x+r+dx,y}]});
 await touch('touchStart',45);await page.evaluate(()=>window.drawProbe=0);
 for(let i=0;i<80;i++){await touch('touchMove',45+i*.5,Math.sin(i/20)*20);await page.waitForTimeout(16);}
 const drawsDuringGesture=await page.evaluate(()=>window.drawProbe);
 await touch('touchEnd');
 const raw=await page.evaluate(()=>window.finishTouchProbe());
 const percentile=(arr,p)=>arr.slice().sort((a,b)=>a-b)[Math.floor((arr.length-1)*p)];
 const metrics={frames:raw.frames.length,p95:percentile(raw.frames,.95),max:Math.max(...raw.frames),over50:raw.frames.filter(v=>v>50).length,inputP95:percentile(raw.latencies,.95)};
 await page.waitForTimeout(500);const drawsAfterRelease=await page.evaluate(()=>window.drawProbe);
 console.log(JSON.stringify({...metrics,drawsDuringGesture,drawsAfterRelease}));
 assert.equal(drawsDuringGesture,0,'Do not redraw the GPU scene during touch');assert.ok(drawsAfterRelease>0,'Resume the live scene after touch');
 assert.ok(metrics.p95<45,`Touch frame p95 ${metrics.p95.toFixed(1)}ms exceeds 45ms`);
}finally{await browser.close();}
