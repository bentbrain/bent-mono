import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildEmail, logoUrl } from './branding/build-template.mjs';
export const root = fileURLToPath(new URL('.', import.meta.url));
export const style = `<!-- bent.shop email style v1 -->\n<style>\n${(await readFile(root+'branding/email.css','utf8')).trim()}\n</style>\n<!-- /bent.shop email style v1 -->`;
export function restoreEmail(source) {
 return source.replace(style+'\n','')
  .replace(/\{% comment %\}bent.shop original header v1\n([\s\S]*?)\n\/bent.shop original header v1\{% endcomment %\}\n<!-- bent.shop header v1 -->[\s\S]*?<!-- \/bent.shop header v1 -->/g,'$1')
  .replace(/\{% comment %\}bent.shop preview v1\{% endcomment %\}[\s\S]*?\{% else %\}\n([\s\S]*?)\n\{% endif %\}\n\{% comment %\}\/bent.shop preview v1\{% endcomment %\}/g,'$1');
}
export async function buildAll() {
 await mkdir(root+'dist',{recursive:true});
 const manifest=[];
 for(const file of (await readdir(root+'sources')).filter(f=>f.endsWith('.liquid')).sort()){
  const source=await readFile(root+'sources/'+file,'utf8');
  const result=buildEmail(source,style,logoUrl);
  if(restoreEmail(result.html)!==source)throw new Error('Original template did not round-trip: '+file);
  await writeFile(root+'dist/'+file,result.html);
  manifest.push({template:file.replace('.liquid',''),images:result.imageCount,headers:result.headerCount,sha256:createHash('sha256').update(result.html).digest('hex')});
 }
 await writeFile(root+'dist/manifest.json',JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log('Built '+(await buildAll()).length+' customer notification templates.');
