import {readdir,readFile,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {join} from 'node:path';
// Build artifacts only. Preserve the source GLBs and the native HA asset format.
const directory='dist/client/models';let rawBytes=0,packedBytes=0;
for(const name of await readdir(directory)){
 if(!name.endsWith('.glb'))continue;
 const raw=await readFile(join(directory,name)),packed=gzipSync(raw,{level:9});
 if(!gunzipSync(packed).equals(raw))throw Error(`Lossless model verification failed: ${name}`);
 await writeFile(join(directory,name+'.gz'),packed);rawBytes+=raw.length;packedBytes+=packed.length;
}
console.log(`Verified lossless model transport: ${rawBytes} → ${packedBytes} bytes`);
