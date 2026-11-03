import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {storeEvidence,readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';
import {sweepImageEvidence,admitEvidenceImage,IMAGE_EVIDENCE_RETENTION} from '../src/evidence/image_retention.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS0AAAAASUVORK5CYII=','base64');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-image-retention-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;return{root,evidence:path.join(root,'evidence'),dispose:()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}};}
const image=(assignment='done',extra:any={})=>storeEvidence({scope:{session_id:'session',assignment_id:assignment},source:'storage-test',raw:png,media_type:'image/png',trust_level:'host_observed',verification_relevance:'supporting',...extra});
test('completed supporting images expire without changing immutable refs; missing pixels cannot verify work',{concurrency:false},()=>{
 const f=fixture();try{
  const stored=image(),refFile=path.join(f.evidence,'refs',stored.ref.evidence_id+'.json'),before=fs.readFileSync(refFile);
  const result=sweepImageEvidence(f.root,f.evidence,{now:Date.now()+8*24*3600_000,terminalAssignments:new Set(['done'])});assert.equal(result.removedObjects,1);assert.equal(result.removedBytes,png.length);assert.deepEqual(fs.readFileSync(refFile),before);
  assert.throws(()=>readAuthoritativeEvidence(stored.ref,{session_id:'session',assignment_id:'done'}),/unavailable or expired/);
  assert.match(fs.readFileSync(path.join(f.evidence,'image-retention.jsonl'),'utf8'),/image_expired/);
 }finally{f.dispose();}
});
test('active, unknown, shared non-image, required and explicit qualification pins prevent image deletion',{concurrency:false},()=>{
 for(const kind of ['active','required','pin','shared']){const f=fixture();try{
  const stored=image('done',kind==='required'?{verification_relevance:'required'}:{});
  if(kind==='pin')fs.writeFileSync(path.join(f.evidence,'retention-pins.json'),JSON.stringify({content_hashes:[stored.ref.content_hash]}));
  if(kind==='shared')image('done',{media_type:'application/octet-stream',source:'non-image-copy'});
  const result=sweepImageEvidence(f.root,f.evidence,{now:Date.now()+8*24*3600_000,terminalAssignments:new Set(kind==='active'?[]:['done'])});assert.equal(result.removedObjects,0);assert(fs.existsSync(path.join(f.root,stored.ref.artifact_location)));
 }finally{f.dispose();}}
});
test('legacy complete labels do not establish canonical terminal state; quota protects pending data and headroom',{concurrency:false},()=>{
 const f=fixture();try{
  const stored=image(),goal=path.join(f.root,'artifacts','goals','done');fs.mkdirSync(goal,{recursive:true});fs.writeFileSync(path.join(goal,'goal.json'),JSON.stringify({id:'done',status:'complete'}));
  assert.equal(sweepImageEvidence(f.root,f.evidence,{now:Date.now()+8*24*3600_000}).removedObjects,0);
  assert.throws(()=>admitEvidenceImage(f.root,f.evidence,'a'.repeat(64),png.length,{...IMAGE_EVIDENCE_RETENTION,maxObjects:1,maxBytes:png.length,minFreeBytes:0}),/budget_reached/);
  assert.throws(()=>admitEvidenceImage(f.root,f.evidence,stored.ref.content_hash.slice(7),png.length,{...IMAGE_EVIDENCE_RETENTION,minFreeBytes:Number.MAX_SAFE_INTEGER}),/disk_headroom/);
  assert(fs.existsSync(path.join(f.root,stored.ref.artifact_location)));
 }finally{f.dispose();}
});
test('a malformed ref or changed object stops cleanup rather than erasing failure evidence',{concurrency:false},()=>{
 const f=fixture();try{
  const stored=image(),file=path.join(f.root,stored.ref.artifact_location);fs.appendFileSync(file,'changed');
  assert.throws(()=>sweepImageEvidence(f.root,f.evidence,{now:Date.now()+8*24*3600_000,terminalAssignments:new Set(['done'])}),/digest_mismatch/);assert(fs.existsSync(file));
 }finally{f.dispose();}
});
test('repeated completed captures remain bounded after inspection while user models and source images stay intact',{concurrency:false},()=>{
 const f=fixture();try{
  const model=path.join(f.root,'User model.rvt'),source=path.join(f.root,'Reference.png');fs.writeFileSync(model,'user-owned model');fs.writeFileSync(source,png);
  const counts=[];for(let i=0;i<30;i++){
   image('done',{raw:Buffer.concat([png,Buffer.from([i])])});
   const result=sweepImageEvidence(f.root,f.evidence,{terminalAssignments:new Set(['done']),policy:{...IMAGE_EVIDENCE_RETENTION,maxObjects:3,maxBytes:3*(png.length+1)}});counts.push(result.objects);assert(result.objects<=3);assert(result.bytes<=3*(png.length+1));
  }
  assert.equal(counts.at(-1),3);assert.equal(fs.readFileSync(model,'utf8'),'user-owned model');assert(fs.readFileSync(source).equals(png));
 }finally{f.dispose();}
});
