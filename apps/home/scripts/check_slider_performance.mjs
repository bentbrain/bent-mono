import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.clock.setFixedTime(new Date('2026-09-11T20:00:00+10:00'));
 await page.goto(process.env.SLIDER_TEST_URL??'http://localhost:3016/');
 await page.locator('.public-room[aria-busy="false"]').waitFor({timeout:90000});await page.waitForTimeout(7000);
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const slider=page.getByRole('slider',{name:'Lounge lighting'}),box=await slider.boundingBox();assert.ok(box);
 await page.evaluate(()=>{window.frameTimes=[];let prev=performance.now();const tick=now=>{window.frameTimes.push(now-prev);prev=now;window.frameProbe=requestAnimationFrame(tick);};window.frameProbe=requestAnimationFrame(tick);});
 await page.mouse.move(box.x+box.width*.55,box.y+box.height/2);await page.mouse.down();
 for(let i=0;i<45;i++){await page.mouse.move(box.x+box.width*(.55+i*.009),box.y+box.height/2);await page.waitForTimeout(16);}
 const times=await page.evaluate(()=>{cancelAnimationFrame(window.frameProbe);return window.frameTimes;});await page.mouse.up();await page.waitForTimeout(1000);
 const sorted=times.slice().sort((a,b)=>a-b),metrics={frames:times.length,p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),over100:times.filter(t=>t>100).length,level:await slider.inputValue(),errors};console.log(JSON.stringify(metrics));
 assert.deepEqual(errors,[]);assert.ok(Number(metrics.level)>90);assert.ok(metrics.p95<150,`Slider p95 ${metrics.p95}ms exceeds the throttled-device budget`);
}finally{await browser.close();}
