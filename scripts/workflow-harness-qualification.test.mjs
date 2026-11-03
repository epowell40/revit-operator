import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{sha256}from'./workflow-harness.mjs';import{verifyUnchangedCore,harnessPaths}from'./workflow-harness-qualification.mjs';
test('harness-only reuse refuses changed core, new official input, traversal and proof changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-qualification-'));
 try {
  const core='public/apps/operator-backend/src/a.ts',proof='public/artifacts/proof.json',harness='public/scripts/workflow-harness.mjs';
  for(const p of [core,proof,harness]){fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),'baseline');}
  const freeze={files:[core,proof,harness].map(p=>({path:p,sha256:sha256(path.join(root,p))}))};
  assert(verifyUnchangedCore(root,freeze,['apps/operator-backend/src/a.ts']));fs.writeFileSync(path.join(root,harness),'new tested harness');assert(verifyUnchangedCore(root,freeze,['apps/operator-backend/src/a.ts']));
  assert.throws(()=>verifyUnchangedCore(root,freeze,['apps/operator-backend/src/new.ts']));
  for(const p of [core,proof]){fs.writeFileSync(path.join(root,p),'changed');assert.throws(()=>verifyUnchangedCore(root,freeze,['apps/operator-backend/src/a.ts']));fs.writeFileSync(path.join(root,p),'baseline');}
  assert.throws(()=>verifyUnchangedCore(root,{files:[...freeze.files,{path:'../outside',sha256:'x'}]},['apps/operator-backend/src/a.ts']));
  assert(!harnessPaths.has('public/apps/operator-backend/src/a.ts'));assert(!harnessPaths.has('scripts/workflow-owned-runtime.ps1'));
  assert(harnessPaths.has('scripts/workflow-harness-finalize.mjs'));assert(!harnessPaths.has('scripts/workflow-arbitrary-runtime.mjs'));
 }finally{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true});}
});
