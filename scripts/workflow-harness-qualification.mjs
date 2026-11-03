import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
export const harnessPaths=new Set([
 'public/scripts/workflow-harness.mjs','public/scripts/workflow-harness.test.mjs',
 'public/scripts/workflow-harness-qualification.mjs','public/scripts/workflow-harness-qualification.test.mjs',
 'scripts/workflow-harness.mjs','scripts/workflow-harness-qualify.mjs','scripts/workflow-harness-finalize.mjs'
]);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** Reuse unchanged core qualification, never regenerate or rewrite its proof.
 * A changed app, native binary, generated proof or source-input set fails shut. */
export function verifyUnchangedCore(root,previous,officialInputs) {
 const old=new Map(previous.files.map(f=>[f.path.replaceAll('\\','/'),f]));
 assert.equal(old.size,previous.files.length,'unique frozen files');
 for(const [p,f]of old) {
  assert(!path.isAbsolute(p)&&!p.split('/').includes('..'),'root relative source');
  if(!harnessPaths.has(p))assert.equal(hash(path.join(root,p)),f.sha256,'qualified core changed '+p);
 }
 assert(officialInputs.length>0);const seen=new Set();
 for(const p of officialInputs) {
  const file='public/'+p.replaceAll('\\','/');assert(!seen.has(file));seen.add(file);
  assert(old.has(file),'official input set gained unqualified file '+file);
  assert(!harnessPaths.has(file),'harness is outside core provenance');
 }
 // The freeze contains build outputs too; only known official roots are used
 // for the reverse set check, supplied by the official enumerator's baseline.
 return{unchangedFiles:previous.files.filter(f=>!harnessPaths.has(f.path.replaceAll('\\','/'))).length,officialInputs:seen.size};
}
