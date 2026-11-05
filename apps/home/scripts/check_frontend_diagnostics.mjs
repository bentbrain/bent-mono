import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const url=process.env.FRONTEND_TEST_URL??'http://localhost:3016/';
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const reports=[],statuses=[];page.on('request',r=>{if(r.url().endsWith('/api/telemetry'))reports.push(r.postDataJSON());});page.on('response',r=>{if(r.url().endsWith('/api/telemetry'))statuses.push(r.status());});
 await page.goto(url);await page.locator('.public-room[aria-busy="false"]').waitFor({timeout:90000});await page.waitForTimeout(1000);
 assert.equal(await page.locator('.public-status').count(),0,'Scene must load successfully');
 await page.getByRole('button',{name:'Rotate right',exact:true}).click();await page.getByRole('slider',{name:'Lounge lighting'}).fill('25');
 await page.evaluate(()=>{window.scrollTo(0,1000);window.dispatchEvent(new ErrorEvent('error',{error:new Error('QA controlled JavaScript failure')}));window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{promise:Promise.resolve(),reason:new Error('QA controlled rejection')}));document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost'));document.querySelector('canvas').dispatchEvent(new Event('webglcontextrestored'));});
 await page.waitForTimeout(500);
 const ui=await page.evaluate(()=>{const c=getComputedStyle(document.querySelector('.public-controls'));return{y:scrollY,height:document.documentElement.scrollHeight,viewport:innerHeight,paddingX:parseFloat(c.paddingLeft),paddingBottom:parseFloat(c.paddingBottom),body:getComputedStyle(document.body).overflow};});
 assert.equal(ui.y,0);assert.equal(ui.height,ui.viewport);assert.equal(ui.body,'hidden');assert.ok(ui.paddingX>=32);assert.ok(ui.paddingBottom>=36);
 for(const kind of ['scene-start','scene-ready','javascript-error','unhandled-rejection','webgl-context-lost','webgl-context-restored'])assert.ok(reports.some(r=>r.kind===kind),`Missing ${kind}`);
 assert.ok(statuses.every(s=>s===204),JSON.stringify(statuses));assert.equal(await page.getByText('QA controlled JavaScript failure').count(),0);
 await page.screenshot({path:'runs/frontend-mobile.png'});
 await page.close();
 const failure=await browser.newPage({viewport:{width:390,height:844}});const failures=[];failure.on('request',r=>{if(r.url().endsWith('/api/telemetry'))failures.push(r.postDataJSON());});
 await failure.route('**/models/pearl.glb.gz?*',route=>route.fulfill({status:503,body:'controlled failure'}));
 await failure.goto(url);await failure.getByText('The room could not load. Try refreshing this page.').waitFor({timeout:90000});await failure.waitForTimeout(500);
 assert.ok(failures.some(r=>r.kind==='scene-load-error'&&r.message.includes('pearl')&&r.message.includes('503')),'Log the actual failing model');
 assert.equal(await failure.getByText('503').count(),0,'Diagnostic details remain out of UI');
 console.log(JSON.stringify({ui,events:reports.map(r=>r.kind),statuses,loadFailure:failures.find(r=>r.kind==='scene-load-error')?.message}));
}finally{await browser.close();}
