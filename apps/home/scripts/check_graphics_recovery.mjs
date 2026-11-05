import {chromium,webkit} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await (process.env.RECOVERY_BROWSER==='webkit'?webkit:chromium).launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.graphicsProbe={reject:false,failures:0,draws:0};const p=WebGL2RenderingContext.prototype,create=p.createVertexArray;
  p.createVertexArray=function(){if(window.graphicsProbe.reject){window.graphicsProbe.failures++;return null;}return create.call(this);};
  for(const key of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){const draw=p[key];p[key]=function(...args){window.graphicsProbe.draws++;return draw.apply(this,args);};}
 });
 await page.goto(process.env.RECOVERY_TEST_URL??'http://localhost:3016/');await page.locator('.public-room[aria-busy="false"]').waitFor({timeout:90000});await page.waitForTimeout(1000);
 await page.evaluate(()=>window.graphicsProbe.reject=true);
 for(const room of ['Lounge','Bedroom'])await page.getByRole('slider',{name:room+' lighting'}).fill('100');
 await page.getByRole('button',{name:'Rotate right',exact:true}).tap();await page.waitForTimeout(4000);
 const before=await page.evaluate(()=>window.graphicsProbe.draws);
 await page.getByRole('button',{name:'Rotate right',exact:true}).tap();await page.waitForTimeout(1200);
 const probe=await page.evaluate(()=>window.graphicsProbe);console.log(JSON.stringify({probe,drawsAfterRetry:probe.draws-before,errors}));
 assert.ok(probe.failures>0,'Drive the actual failed VAO allocation');
 assert.ok(probe.draws>before,'Render loop must continue after the allocation failure');
 assert.equal(await page.locator('.public-status').count(),0,'Recovered room is usable');
 assert.equal(await page.getByRole('slider',{name:'Lounge lighting'}).inputValue(),'100');assert.equal(await page.getByRole('slider',{name:'Bedroom lighting'}).inputValue(),'100');
 assert.deepEqual(errors,[]);await page.screenshot({path:'runs/graphics-recovery.png'});
}finally{await browser.close();}
