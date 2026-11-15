import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {copyDependency,sharedLibraries} from './linux-candidate.mjs';
import {nativeHostTarget,nativePackageCompatible} from './native-target.mjs';
import {copyCapsuleDependency} from './product-image-v5-capsule.mjs';

const target={os:'linux',cpu:'x64',libc:'glibc'};
const root=process.env.SHOP_NATIVE_PACKAGE_TEST_ROOT??tmpdir();
async function fixture(t){
 await mkdir(root,{recursive:true,mode:0o700});const directory=await mkdtemp(join(root,'native-collector-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const input=join(directory,'input'),output=join(directory,'output');await mkdir(join(input,'node_modules'),{recursive:true,mode:0o700});await mkdir(join(output,'node_modules'),{recursive:true,mode:0o700});
 await writeFile(join(input,'package.json'),'{}',{mode:0o600});
 async function pkg(name,metadata={}){const path=join(input,'node_modules',name);await mkdir(path,{recursive:true,mode:0o700});await writeFile(join(path,'package.json'),JSON.stringify({name,version:'1.0.0',...metadata}),{mode:0o600});await writeFile(join(path,'binding.node'),'synthetic package collector bytes, never executed',{mode:0o600});}
 await pkg('sharp',{optionalDependencies:{'@img/sharp-linux-x64':'1','@img/sharp-linuxmusl-x64':'1','@img/sharp-darwin-arm64':'1'}});
 await pkg('@img/sharp-linux-x64',{os:['linux'],cpu:['x64'],libc:['glibc'],optionalDependencies:{'@img/sharp-libvips-linux-x64':'1'}});
 await pkg('@img/sharp-libvips-linux-x64',{os:['linux'],cpu:['x64'],libc:['glibc']});
 await pkg('@img/sharp-linuxmusl-x64',{os:['linux'],cpu:['x64'],libc:['musl'],optionalDependencies:{'@img/sharp-libvips-linuxmusl-x64':'1'}});await pkg('@img/sharp-libvips-linuxmusl-x64',{os:['linux'],cpu:['x64'],libc:['musl']});
 await pkg('@img/sharp-darwin-arm64',{os:['darwin'],cpu:['arm64'],optionalDependencies:{'@img/sharp-libvips-darwin-arm64':'1'}});await pkg('@img/sharp-libvips-darwin-arm64',{os:['darwin'],cpu:['arm64']});
 return {input,output,pkg};
}
for(const [name,collector]of[['Linux runtime',copyDependency],['standalone capsule',copyCapsuleDependency]]){
 test(`${name} retains only the active glibc closure when incompatible native packages are installed`,async t=>{
  const f=await fixture(t),dependencies=[];await collector('sharp',join(f.input,'package.json'),f.output,dependencies,new Map(),false,target);
  assert.deepEqual(dependencies.map(item=>item.name).sort(),['@img/sharp-libvips-linux-x64','@img/sharp-linux-x64','sharp']);
  assert.equal((await readFile(join(f.output,'node_modules/@img/sharp-linux-x64/binding.node'))).toString(),'synthetic package collector bytes, never executed');
 });
 test(`${name} preserves host-local Darwin and musl target selection`,async t=>{
  for(const profile of [{os:'darwin',cpu:'arm64'},{os:'linux',cpu:'x64',libc:'musl'}]){
   const f=await fixture(t),dependencies=[];await collector('sharp',join(f.input,'package.json'),f.output,dependencies,new Map(),false,profile);
   const platform=profile.os==='darwin'?'darwin':'linuxmusl';assert.deepEqual(dependencies.map(item=>item.name).sort(),[`@img/sharp-${platform}-${profile.cpu}`,`@img/sharp-libvips-${platform}-${profile.cpu}`,'sharp'].sort());
  }
 });
 test(`${name} rejects incompatible required and missing active native dependencies`,async t=>{
  const f=await fixture(t);
  await assert.rejects(collector('@img/sharp-linuxmusl-x64',join(f.input,'package.json'),f.output,[],new Map(),false,target),/Required native dependency.*incompatible/);
  await assert.rejects(collector('missing-required-binding',join(f.input,'package.json'),f.output,[],new Map(),false,target),/dependency unavailable/);
  await rm(join(f.input,'node_modules/@img/sharp-libvips-linux-x64'),{recursive:true});
  await assert.rejects(collector('sharp',join(f.input,'package.json'),f.output,[],new Map(),false,target),/Active native dependency unavailable/);
 });
}
test('actual host target distinguishes libc and rejects unidentifiable Linux runtime',()=>{
 assert.deepEqual(nativeHostTarget({os:'linux',cpu:'x64',report:{header:{glibcVersionRuntime:'2.39'}}}),target);
 assert.deepEqual(nativeHostTarget({os:'linux',cpu:'x64',report:{header:{},sharedObjects:['/lib/ld-musl-x86_64.so.1']}}),{os:'linux',cpu:'x64',libc:'musl'});
 assert.deepEqual(nativeHostTarget({os:'darwin',cpu:'arm64'}),{os:'darwin',cpu:'arm64'});
 assert.throws(()=>nativeHostTarget({os:'linux',cpu:'x64',report:{header:{},sharedObjects:[]}}),/Identify the Linux libc/);
 assert.equal(nativePackageCompatible({os:['!darwin'],cpu:['x64'],libc:['glibc']},target),true);
 assert.equal(nativePackageCompatible({os:['linux'],cpu:['!x64']},target),false);
 assert.equal(nativePackageCompatible({os:'linux',cpu:'x64',libc:'glibc'},target),true);
 assert.equal(nativePackageCompatible({os:['!any']},target),false);
 assert.throws(()=>nativePackageCompatible({libc:[42]},target),/platform selectors/);
});
test('active Linux shared-library absence continues to fail closed',()=>{assert.throws(()=>sharedLibraries('libvips.so => not found\n'),/Linux shared library is unavailable/);});
