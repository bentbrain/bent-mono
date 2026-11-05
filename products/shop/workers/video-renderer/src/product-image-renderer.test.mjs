import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {renderProductImage} from './product-image-renderer.mjs';
import {loadLifestyleTemplate} from './lifestyle-template.mjs';
const settings={cropX:.5,cropY:.5,cropZoom:1,depth:5,placementX:.3,placementY:.3,placementWidth:.3};
test('flat renders preserve base-only artwork and use the physical print aspect for both products',async()=>{
  const source=await sharp({create:{width:100,height:140,channels:4,background:'#ff0000'}}).composite([{input:await sharp({create:{width:50,height:70,channels:4,background:'#0000ff'}}).png().toBuffer(),left:0,top:0}]).png().toBuffer();
  for(const baseProductSlug of ['staple-tee','cotton-tote']) {
    const mockup=await sharp({create:{width:1500,height:1500,channels:4,background:'#ffffff'}}).png().toBuffer();
    const base=await renderProductImage({artwork:source,mockup,baseProductSlug,settings:settings,view:'flat',printMode:'base-image-only'});
    const recursive=await renderProductImage({artwork:source,mockup,baseProductSlug,settings:settings,view:'flat',printMode:'recursive'});
    const withoutRecursion=await renderProductImage({artwork:source,mockup,baseProductSlug,settings:{...settings,depth:0},view:'flat',printMode:'recursive'});
    const metadata=await sharp(base).metadata();assert.equal(metadata.width,1500);assert.equal(metadata.height,1500);assert.equal(metadata.format,'webp');
    assert.notDeepEqual(base,recursive);
    assert.deepEqual(withoutRecursion,base);
  }
});
test('lifestyle native output uses the reviewed masters and delivers compact WebP',async()=>{
  const root=new URL('../../../assets/lifestyle/',import.meta.url);
  const templates=JSON.parse(await readFile(new URL('featured.json',root),'utf8'));
  const source=await sharp({create:{width:200,height:250,channels:4,background:'#ff0000'}}).png().toBuffer();
  for(const color of ['white','black']) {
    const mockup=await readFile(new URL(`featured-blank-${color}.png`,root));
    const output=await renderProductImage({artwork:source,mockup,template:await loadLifestyleTemplate(templates,color,file=>readFile(new URL(file,root))),
      baseProductSlug:'staple-tee',settings:settings,view:'lifestyle',printMode:'base-image-only'});
    const metadata=await sharp(output).metadata();assert.equal(metadata.width,1086);assert.equal(metadata.height,1448);assert.equal(metadata.format,'webp');assert.ok(output.length<200000);
  }
});
