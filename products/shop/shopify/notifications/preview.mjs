import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {buildAll,root} from './build.mjs';
import {renderEmail} from './render.mjs';
const manifest=await buildAll();
const options=manifest.map(x=>`<option value="${x.template}">${x.template.replaceAll('_',' ')}</option>`).join('');
http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/source'){
  const builder=(await readFile(root+'branding/build-template.mjs','utf8')).split('export const buildEmail = ')[1].trim().replace(/;$/,'');
  const css=await readFile(root+'branding/email.css','utf8');
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><h1>Generator source</h1><textarea aria-label="Generator source">'+JSON.stringify({builder,css}).replaceAll('&','&amp;').replaceAll('<','&lt;')+'</textarea></html>');return;
 }
 if(url.pathname==='/'){
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><meta charset="utf-8"><title>bent.shop email previews</title><style>body{font:14px monospace;color:#0647ff;margin:24px}select,button{font:inherit;padding:10px;background:white;color:#0647ff;border:1px solid #0647ff}iframe{display:block;width:700px;max-width:100%;height:1000px;border:1px solid #0647ff;margin-top:24px}</style><h1>bent.shop email previews</h1><p>Local sample data. Layout is approximate; validate final output in Shopify. Links are disabled in the preview.</p><p><a href="/source">Generator source</a></p><select id="template" aria-label="Email template">${options}</select> <button id="phone">Phone · 390px</button> <button id="desktop">Desktop · 700px</button><iframe sandbox title="Email preview" src="/email/order_confirmation"></iframe><script>const frame=document.querySelector('iframe');document.querySelector('select').value='order_confirmation';document.querySelector('select').onchange=e=>frame.src='/email/'+e.target.value;document.querySelector('#phone').onclick=()=>frame.style.width='390px';document.querySelector('#desktop').onclick=()=>frame.style.width='700px';</script></html>`);return;}
 const slug=url.pathname.replace('/email/','');
 if(!manifest.some(x=>x.template===slug)){res.writeHead(404);res.end();return;}
 try{res.setHeader('Content-Type','text/html');res.end((await renderEmail(await readFile(root+'dist/'+slug+'.liquid','utf8'))).replace(/href="[^"]*"/g,'href="#preview-link"'));}catch(error){res.writeHead(500);res.end('Preview failed: '+error.message);}
}).listen(43822,'127.0.0.1',()=>console.log('Email previews: http://127.0.0.1:43822'));
