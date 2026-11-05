import {expect,test,spyOn} from 'bun:test';
import {cleanReport,telemetryApi} from './telemetryApi';
import {diagnosticText} from './telemetry';
const payload={id:'12345678-1234-1234-1234-123456789abc',kind:'scene-load-error',release:'test',message:'Model failed',context:{quarter:0,items:72,lounge:19,bedroom:0}};
function request(body:unknown,headers:Record<string,string>={}){return new Request('https://home.bent.build/api/telemetry',{method:'POST',headers:{Origin:'https://home.bent.build','Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
test('telemetry stores only bounded diagnostic fields and strips layout, HA and URL credentials',()=>{
 const cleaned=cleanReport({...payload,layout:[{entityId:'light.private',x:4}],token:'private',context:{...payload.context,entityId:'light.private'},stack:'at https://home.bent.build/assets/main.js?token=secret:2:3\nat https://private.test/path?token=secret',breadcrumbs:Array.from({length:20},()=>({action:'rotate',at:100,layout:'private'}))});
 const json=JSON.stringify(cleaned);expect(json).not.toContain('private');expect(json).not.toContain('secret');expect(json).toContain('/assets/main.js');expect(json).toContain('"items":72');
 expect(cleaned?.breadcrumbs).toHaveLength(12);expect(diagnosticText('x'.repeat(2000))).toHaveLength(1500);expect(cleanReport({kind:'arbitrary'})).toBeNull();
});
test('telemetry endpoint logs an anonymous report and rejects foreign origins, oversized and malformed payloads',async()=>{
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try{
  expect((await telemetryApi(request(payload))).status).toBe(204);expect(log).toHaveBeenCalledTimes(1);expect(log.mock.calls[0]?.[0]).toContain('frontend-diagnostic');
  expect((await telemetryApi(request(payload,{Origin:'https://foreign.test'}))).status).toBe(403);
  expect((await telemetryApi(request({}))).status).toBe(400);
  expect((await telemetryApi(request({...payload,message:'x'.repeat(9000)}))).status).toBe(413);
  expect(log).toHaveBeenCalledTimes(1);
 }finally{log.mockRestore();}
});
