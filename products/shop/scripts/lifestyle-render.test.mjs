import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {renderLifestyle} from './lifestyle/render.mjs';

const solid=async(background,width=64,height=64)=>sharp({create:{width,height,channels:4,background}}).png().toBuffer();
const decode=async bytes=>sharp(bytes).ensureAlpha().raw().toBuffer();
const options={quad:[[0.25,0.25],[0.75,0.25],[0.75,0.75],[0.25,0.75]],displacement:0,shading:0,texture:0,lightReference:1};
const pixel=(data,x,y)=>[...data.subarray((y*64+x)*4,(y*64+x)*4+4)];

test('transparent artwork preserves every base pixel, including alpha',async()=>{
  const base=await solid({r:17,g:33,b:81,alpha:0.6});
  const artwork=await solid({r:255,g:0,b:255,alpha:0});
  const result=await renderLifestyle({...options,base,artwork});
  assert.deepEqual(await decode(result.image),await decode(base));
});

test('perspective clips ink to the calibrated trapezoid and preserves its colour',async()=>{
  const base=await solid('#ffffff'),artwork=await solid('#e03060');
  const result=await renderLifestyle({...options,base,artwork,quad:[[.35,.2],[.65,.2],[.85,.8],[.15,.8]]});
  const data=await decode(result.image);
  assert.deepEqual(pixel(data,32,32),[224,48,96,255]);
  assert.deepEqual(pixel(data,12,16),[255,255,255,255]);
  assert.deepEqual(pixel(data,14,46),[224,48,96,255]);
});

test('black cloth does not multiply white ink into black',async()=>{
  const result=await renderLifestyle({...options,base:await solid('#101010'),lighting:await solid('#e6e6e6'),
    artwork:await solid('#ffffff'),shading:1,lightReference:.9});
  const data=await decode(result.image);
  assert.ok(pixel(data,32,32)[0]>245);
  assert.deepEqual(pixel(data,5,5),[16,16,16,255]);
});

test('template light tint grades only visible ink without changing the input artwork',async()=>{
  const base=await solid('#806050'),artwork=await solid('#ffffff');
  const original=Buffer.from(artwork);
  const neutral=await renderLifestyle({...options,base,artwork});
  const result=await renderLifestyle({...options,base,artwork,lightTint:[.96,.98,1]});
  const data=await decode(result.image);
  assert.deepEqual(pixel(data,32,32),[245,250,255,255]);
  assert.deepEqual(pixel(data,5,5),pixel(await decode(base),5,5));
  assert.deepEqual(artwork,original);
  assert.deepEqual((await renderLifestyle({...options,base,artwork,lightTint:[1,1,1]})).image,neutral.image);
  assert.deepEqual(await decode((await renderLifestyle({...options,base,artwork,lightTint:[.96,.98,1],mask:await solid('#000')})).image),await decode(base));
  for(const lightTint of [[1,1],[1,NaN,1],[1,1,2]]) await assert.rejects(renderLifestyle({...options,base,artwork,lightTint}),/Light tint/);
});

test('premultiplied sampling prevents hidden transparent magenta from bleeding into ink',async()=>{
  const artwork=await sharp(Buffer.from([255,0,255,0,0,255,0,255]),{raw:{width:2,height:1,channels:4}}).png().toBuffer();
  const result=await renderLifestyle({...options,base:await solid('#000000'),artwork});
  const data=await decode(result.image),edge=pixel(data,31,32);
  assert.equal(edge[0],0);assert.equal(edge[2],0);assert.ok(edge[1]>0);
});

test('explicit displacement moves the artwork and an occlusion mask excludes ink',async()=>{
  const artwork=await sharp(Buffer.from([255,0,0,255,0,0,255,255]),{raw:{width:2,height:1,channels:4}}).png().toBuffer();
  const base=await solid('#ffffff'),displacementMap=await solid({r:255,g:128,b:128});
  const normal=await renderLifestyle({...options,base,artwork});
  const shifted=await renderLifestyle({...options,base,artwork,displacementMap,displacement:8});
  assert.notDeepEqual(pixel(await decode(normal.image),30,32),pixel(await decode(shifted.image),30,32));
  const masked=await renderLifestyle({...options,base,artwork,mask:await solid('#000000')});
  assert.deepEqual(await decode(masked.image),await decode(base));
});

test('garment clipping stays in photo space under displacement and preserves excluded pixels exactly',async()=>{
  const base=await solid('#6a4831'),artwork=await solid('#ff00ff');
  // Transparent white outside the fabric must exclude ink, not become opaque white.
  const mask=await sharp(Buffer.from('<svg width="64" height="64"><rect width="64" height="64" fill="white" fill-opacity="0"/><rect x="24" y="20" width="16" height="24" fill="white"/></svg>')).png().toBuffer();
  const result=await renderLifestyle({...options,quad:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],
    displacement:80,displacementMap:await solid({r:255,g:128,b:128}),base,artwork,mask});
  const data=await decode(result.image),original=await decode(base);
  for(let y=0;y<64;y++) for(let x=0;x<64;x++) {
    if(x<24 || x>=40 || y<20 || y>=44) assert.deepEqual(pixel(data,x,y),pixel(original,x,y));
  }
  assert.notDeepEqual(pixel(data,32,32),pixel(original,32,32));
  await assert.rejects(renderLifestyle({...options,base,artwork,mask:await solid('#fff',32,32)}),/mask must match/);
});

test('same inputs are deterministic; invalid geometry and settings fail explicitly',async()=>{
  const input={...options,base:await solid('#888888'),artwork:await solid('#112233')};
  assert.deepEqual((await renderLifestyle(input)).image,(await renderLifestyle(input)).image);
  await assert.rejects(renderLifestyle({...input,quad:[[0,0],[0,0],[0,0],[0,0]]}),/convex/);
  await assert.rejects(renderLifestyle({...input,quad:[[0,0],[1,1],[1,0],[0,1]]}),/convex/);
  await assert.rejects(renderLifestyle({...input,displacement:NaN}),/Invalid displacement/);
});

test('reflected highlights brighten black ink only inside printed and unmasked pixels',async()=>{
  const base=await solid('#444444');
  const input={...options,base,lighting:await solid('#eeeeee'),artwork:await solid('#000000'),lightReference:.5};
  const flat=await decode((await renderLifestyle(input)).image);
  const lit=await decode((await renderLifestyle({...input,highlights:1})).image);
  assert.equal(pixel(flat,32,32)[0],0);
  assert.ok(pixel(lit,32,32)[0]>20);
  assert.deepEqual(pixel(lit,5,5),pixel(flat,5,5));
  const masked=await renderLifestyle({...input,highlights:1,mask:await solid('#000000')});
  assert.deepEqual(await decode(masked.image),await decode(base));
});

test('the photographed shadow dims bright ink while highlights do not wash out unlit ink',async()=>{
  const light=Buffer.alloc(64*64*4,255);
  for (let y=0;y<64;y++) for (let x=0;x<32;x++) {
    for(let c=0;c<3;c++) light[(y*64+x)*4+c]=128;
  }
  const lighting=await sharp(light,{raw:{width:64,height:64,channels:4}}).png().toBuffer();
  const input={...options,base:await solid('#888888'),artwork:await solid('#dddddd'),lighting,shading:1};
  const shaded=await decode((await renderLifestyle(input)).image);
  assert.ok(pixel(shaded,22,32)[0]<pixel(shaded,42,32)[0]-70);
  const dark=await decode((await renderLifestyle({...input,lighting:await solid('#404040'),artwork:await solid('#000000'),highlights:1})).image);
  assert.equal(pixel(dark,32,32)[0],0);
});
