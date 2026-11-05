import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applicationContractPath } from './contract-consumers.mjs';

test('reviewed renderer contract boundary matches its imports and both explicit image packagers',()=>{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','workers/video-renderer'],{encoding:'utf8'}).trim().split('\n');
 const references=[];
 for(const file of files.filter(path=>path.endsWith('.mjs') && !path.endsWith('.test.mjs'))) {
  const text=readFileSync(file,'utf8');
  assert.doesNotMatch(text,/@forever-tee\/contracts/);
  for(const match of text.matchAll(/packages\/contracts\/[^"'`\s]+/g))references.push(match[0]);
 }
 assert.equal(references.length,3);
 assert.ok(references.every(path=>path==='packages/contracts/src/product-mockup-geometry.js'));
 const geometry=readFileSync('packages/contracts/src/product-mockup-geometry.js','utf8');
 assert.doesNotMatch(geometry,/\b(?:import|require)\b|\bfrom\s*['"`]/);
 assert.equal(applicationContractPath('packages/contracts/src/product-mockup-geometry.js'),false);
 assert.equal(applicationContractPath('packages/contracts/src/unreviewed.ts'),false);
});
