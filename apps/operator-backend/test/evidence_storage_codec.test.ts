import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash}from'node:crypto';
import {storeEvidence,readAuthoritativeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
test('ordinary evidence CAS compresses large JSON once and preserves exact native bytes, selectors and scope',{concurrency:false},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-evidence-codec-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const scope={session_id:'session',assignment_id:'assignment'},raw={items:Array.from({length:5000},(_,id)=>({id,name:'Room '+id,description:'unchanged observed parameter '.repeat(4)}))},bytes=Buffer.from(JSON.stringify(raw));
  let ref:any;for(let i=0;i<30;i++){
   const stored=storeEvidence({scope,source:'native-storage-fixture',trust_level:'authoritative_native',raw});ref=stored.ref;
   assert(ref.artifact_location.endsWith('.bin.gz'));assert(readAuthoritativeEvidence(ref,scope).equals(bytes));if(i)assert.equal(stored.stored_unique_bytes,0);
  }
  const object=path.join(root,ref.artifact_location);assert(fs.statSync(object).size<bytes.length/10);assert.equal(fs.readdirSync(path.dirname(object)).length,1);
  assert.throws(()=>readAuthoritativeEvidence(ref,{...scope,assignment_id:'foreign'}),/scope/);
  const before=fs.readFileSync(object);fs.writeFileSync(object,before.subarray(0,20));assert.throws(()=>readAuthoritativeEvidence(ref,scope));
 }finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy uncompressed objects retain their exact bytes and location',{concurrency:false},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-evidence-legacy-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const raw={text:'legacy '.repeat(20000)},bytes=Buffer.from(JSON.stringify(raw)),hash=createHash('sha256').update(bytes).digest('hex'),file=path.join(root,'evidence','objects','sha256',hash.slice(0,2),hash+'.bin');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  const scope={session_id:'session',assignment_id:'assignment'},stored=storeEvidence({scope,source:'legacy-native-storage',trust_level:'authoritative_native',raw});assert(!stored.ref.artifact_location.endsWith('.gz'));assert.equal(stored.stored_unique_bytes,0);assert(readAuthoritativeEvidence(stored.ref,scope).equals(bytes));assert(fs.readFileSync(file).equals(bytes));
 }finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
test('invalid metadata and malformed JSON leave no orphan evidence object',{concurrency:false},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-evidence-failed-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const scope={session_id:'session',assignment_id:'assignment'};
  for(const extra of [{raw:'{invalid',media_type:'application/json'},{raw:{ok:true},bounded_summary:'X'.repeat(1000)}])assert.throws(()=>storeEvidence({scope,source:'invalid-storage',trust_level:'untrusted_caller',...extra}));
  const count=(folder:string):number=>fs.existsSync(folder)?fs.readdirSync(folder,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?count(path.join(folder,e.name)):1),0):0;
  assert.equal(count(path.join(root,'evidence','objects')),0);
 }finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
