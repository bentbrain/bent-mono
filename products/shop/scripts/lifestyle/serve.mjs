import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{dir:{type:'string',default:'.data/lifestyle/review'},port:{type:'string',default:'4178'}}});
const root=resolve(values.dir),port=Number(values.port);
if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid local port.');
const types={'.html':'text/html; charset=utf-8','.png':'image/png','.json':'application/json'};
createServer(async(request,response)=>{
  try {
    if (!['GET','HEAD'].includes(request.method)) {response.writeHead(405).end();return;}
    const path=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
    const file=resolve(root,`.${path==='/'?'/index.html':path}`);
    if (!file.startsWith(root+sep)||!types[extname(file)]) {response.writeHead(404).end();return;}
    const bytes=await readFile(file);
    response.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
    response.end(request.method==='HEAD'?undefined:bytes);
  } catch {response.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Lifestyle review: http://127.0.0.1:${port}`));
