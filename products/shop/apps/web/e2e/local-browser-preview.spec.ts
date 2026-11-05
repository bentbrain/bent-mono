import { readFile,writeFile } from 'node:fs/promises';
import { expect,test } from './test';

const id='4c22bf7e-e698-4a0a-90c4-66c5549f1c45';
const revision='3c22bf7e-e698-4a0a-90c4-66c5549f1c45';
for(const color of ['White','Black']) {
  test(`browser renders ${color} flat and displaced lifestyle with server slots unavailable`,async({page},testInfo)=>{
    const artwork=await readFile('e2e/local/artwork.png');
    await page.route('**/api/configured-product-image/**',route=>route.fulfill({status:202}));
    await page.route('**/api/configured-product-lifestyle/**',route=>route.fulfill({status:202}));
    await page.route('**/api/product-preview/**',async route=>{
      // Cover a valid source that arrives after Playwright's default assertion deadline.
      if(color==='Black')await new Promise(resolve=>setTimeout(resolve,6_000));
      return route.fulfill({body:artwork,contentType:'image/png',headers:{'x-product-preview':JSON.stringify({
      revision,baseProductSlug:'staple-tee',settings:{cropX:.5,cropY:.5,cropZoom:1,depth:5,placementX:.39,placementY:.43,placementWidth:.22},
    })}});
    });
    // Hydration starts the backup timer; DOMContentLoaded does not prove it ran.
    const sourceReady=page.waitForResponse(response=>response.url().endsWith(`/api/product-preview/${id}/${revision}`) && response.status()===200);
    await page.goto(`/product/${id}?Color=${color}&Size=M`,{waitUntil:'domcontentloaded'});
    await sourceReady;
    const flat=page.locator('canvas[data-browser-preview="flat"][data-preview-ready="true"]:visible');
    await expect(flat).toBeVisible();
    await expect(flat.locator('..').getByText('Preparing preview…')).toHaveCount(0);
    await page.getByRole('button',{name:'Show lifestyle image',exact:true}).click();
    const lifestyle=page.getByAltText(`${color} bent.shop worn on a model`);
    await expect(lifestyle).toBeVisible();
    await expect.poll(()=>lifestyle.evaluate(image=>image instanceof HTMLImageElement && image.complete && image.naturalWidth===768)).toBe(true);
    await expect.poll(async()=>Math.round((await lifestyle.boundingBox())?.x ?? -100)).toBeLessThan(20);
    const pixels=await lifestyle.evaluate(async image=>{
      if(!(image instanceof HTMLImageElement))throw new Error('Image missing');
      const bytes=new Uint8Array(await (await fetch(image.src)).arrayBuffer());return Array.from(bytes);
    });
    await writeFile(testInfo.outputPath(`${color}-browser.webp`),Buffer.from(pixels));
    await page.screenshot({path:testInfo.outputPath(`${color}-browser-lifestyle.png`)});
    // All canonical reads are still pending; neither view can be supplied by a server result.
    expect(await lifestyle.getAttribute('src')).toMatch(/^blob:/);
  });
}

test('stored images arriving promptly never start the browser backup',async({page})=>{
  const artwork=await readFile('e2e/local/artwork.png');
  let backupReads=0;
  page.on('request',request=>{if(request.url().includes('/api/product-preview/'))backupReads++;});
  await page.route('**/api/configured-product-image/**',route=>route.fulfill({body:artwork,contentType:'image/png'}));
  await page.route('**/api/configured-product-lifestyle/**',route=>route.fulfill({body:artwork,contentType:'image/png'}));
  await page.goto(`/product/${id}?Color=White&Size=M`,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('button',{name:'Show lifestyle image',exact:true})).toBeVisible();
  // Cross the backup deadline with both canonical images available.
  await page.waitForTimeout(2_200);
  await expect(page.locator('canvas[data-preview-ready="true"]')).toHaveCount(0);
  expect(backupReads).toBe(0);
});
