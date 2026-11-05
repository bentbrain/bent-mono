// Deterministic build-time templates. No customer artwork is written to public assets.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { renderLifestyle } from './lifestyle.mjs';
const root=new URL('../../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('assets/lifestyle/featured.json',root),'utf8'));
const out=new URL('apps/web/public/mockups/lifestyle-v4/',root);
await mkdir(out,{recursive:true});
const records={};
const compilationSignature=await readFile(new URL("./lifestyle.mjs",import.meta.url));
for(const template of manifest.templates) {
  const width=768,height=1024;
  const source=await readFile(new URL(`assets/lifestyle/${template.base}`,root));
  const maskSource=await readFile(new URL(`assets/lifestyle/${template.mask}`,root));
  const base=await sharp(source).resize(width,height).png().toBuffer();
  const mask=await sharp(maskSource).resize(width,height).png().toBuffer();
  const artwork=await sharp({create:{width:750,height:940,channels:4,background:'#ffffff'}}).png().toBuffer();
  const rendered=await renderLifestyle({...template,base,lighting:base,mask,artwork,compile:true,diagnostics:false});
  const hash=createHash('sha256').update(source).update(maskSource).update(JSON.stringify(template)).update(compilationSignature).update("768x1024-rgb12-v1"+JSON.stringify(sharp.versions)).digest('hex').slice(0,16);
  const prefix=`${template.id}-${hash}`;
  await Promise.all([
    writeFile(new URL(`${prefix}-base.webp`,out),await sharp(base).webp({quality:90,alphaQuality:100}).toBuffer()),
    writeFile(new URL(`${prefix}-geometry.png`,out),rendered.geometryMap),
    writeFile(new URL(`${prefix}-light.png`,out),rendered.lightMap),
  ]);
  records[template.id]={prefix,width,height,lightTint:template.lightTint,inkWidth:Math.ceil(width*(template.quad[1][0]-template.quad[0][0])*2)};
}
await writeFile(new URL('apps/web/src/lib/lifestyle-templates.json',root),JSON.stringify(records,null,2)+'\n');
console.log(records);
const flats={};
for(const file of ['tee-white-v1.png','tee-black-v1.png','tote-cream-print-bar-1001.webp','tote-black-print-bar-1001.webp']) {
  const source=await readFile(new URL(`apps/web/public/mockups/${file}`,root));
  const hash=createHash('sha256').update(source).update("768-flat-v1"+JSON.stringify(sharp.versions)).digest('hex').slice(0,16);
  const name=`flat-${hash}.webp`;
  await writeFile(new URL(name,out),await sharp(source).resize(768,768).webp({quality:90}).toBuffer());
  flats[file]=`/mockups/lifestyle-v4/${name}`;
}
await writeFile(new URL('apps/web/src/lib/flat-preview-templates.json',root),JSON.stringify(flats,null,2)+'\n');

const flatNames={'staple-tee-white':'tee-white-v1.png','staple-tee-black':'tee-black-v1.png','cotton-tote-cream':'tote-cream-print-bar-1001.webp','cotton-tote-black':'tote-black-print-bar-1001.webp'};
await writeFile(new URL('server-manifest.json',out),JSON.stringify({lifestyle:records,flats:Object.fromEntries(Object.entries(flatNames).map(([key,name])=>[key,flats[name].split('/').at(-1)]))},null,2)+'\n');
