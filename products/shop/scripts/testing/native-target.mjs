import assert from 'node:assert/strict';

export function nativeHostTarget({os=process.platform,cpu=process.arch,report=os==='linux'?process.report.getReport():undefined}={}) {
  if(os!=='linux')return {os,cpu};
  if(typeof report?.header?.glibcVersionRuntime==='string'&&report.header.glibcVersionRuntime.length)return {os,cpu,libc:'glibc'};
  assert.ok(report?.sharedObjects?.some(path=>/(?:libc\.musl-|ld-musl-)/.test(path)),'Identify the Linux libc before collecting native dependencies');
  return {os,cpu,libc:'musl'};
}
function matches(selectors,actual) {
  if(selectors===undefined)return true;
  if(typeof selectors==='string')selectors=[selectors];
  assert.ok(Array.isArray(selectors)&&selectors.length>0&&selectors.every(value=>typeof value==='string'&&/^!?[a-z0-9_-]+$/.test(value)),'Native package platform selectors must be explicit');
  if(selectors.includes('!any')||selectors.includes(`!${actual}`))return false;
  const positive=selectors.filter(value=>!value.startsWith('!'));
  return positive.length===0||positive.includes(actual)||positive.includes('any');
}
export function nativePackageCompatible(metadata,target) {
  assert.ok(target&&typeof target.os==='string'&&typeof target.cpu==='string'&&(target.os!=='linux'||['glibc','musl'].includes(target.libc)),'Exact native target platform required');
  return matches(metadata.os,target.os)&&matches(metadata.cpu,target.cpu)&&matches(metadata.libc,target.libc);
}
export function requireSharpTarget(dependencies,target) {
  const platform=target.os==='linux'&&target.libc==='musl'?'linuxmusl':target.os;
  const required=[`@img/sharp-${platform}-${target.cpu}`];
  if(['linux','darwin'].includes(target.os))required.push(`@img/sharp-libvips-${platform}-${target.cpu}`);
  for(const name of required)assert.ok(dependencies.some(item=>item.name===name),`Active native dependency unavailable: ${name}`);
}
