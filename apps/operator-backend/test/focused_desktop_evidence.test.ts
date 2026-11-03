import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {retrieveFocusedEvidenceV1} from '@revitoperator/assignment-kernel-v2-contracts/focused-evidence';
import {storeEvidence,retrieveEvidence,readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {gzipSync,gunzipSync} from 'node:zlib';
const scope={session_id:'desktop-evidence',assignment_id:'assignment',run_id:'run',generation:1};
const message='Subtask report (unverified; not completion). '+('Retained observation and protected scope. '.repeat(16))+
  'Targets12345,67890. Remaining: load a distinct family, scope the type swap, and check loaded typography. Do not save RVT.';
const raw={ok:true,session_id:scope.session_id,assistant_message:message,assignment_snapshot_v2:{rows:Array.from({length:200},(_,i)=>({id:i+1,context:'retained details '.repeat(25)}))}};
async function isolated(fn:(root:string)=>Promise<void>){
  const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'focused-evidence-client-'));
  process.env.OPERATOR_WORKSPACE_ROOT=root;
  try{await fn(root);}finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('focused-evidence-client-'));fs.rmSync(root,{recursive:true,force:true});}
}
const request=async(route:string,options:{body:string})=>{assert.equal(route,'/evidence/retrieve');return{ok:true,result:retrieveEvidence(JSON.parse(options.body))};};

test('owner receives shape recovery through the existing scoped client and reads the suggested nested array explicitly',()=>isolated(async()=>{
 const saved=storeEvidence({scope,source:'native:connector-observation',trust_level:'authoritative_native',raw:{results:[{elementId:42,connectors:Array.from({length:40},(_,i)=>({id:i,detail:'do-not-echo-value'.repeat(30)}))}]}});
 const original=readAuthoritativeEvidence(saved.ref,scope);
 const args={evidenceId:saved.ref.evidence_id,purpose:'Read retained connector state',itemRange:{path:'payload.items',start:0,count:2}};
 let calls=0;
 const wireRequest=async(route:string,options:{body:string})=>{calls++;try{return await request(route,options);}catch(error){return {error:String((error as Error).message)};}};
 await assert.rejects(retrieveFocusedEvidenceV1(()=>scope,args,wireRequest),error=>{
   assert.match(String(error),/results\[0\]\.connectors:array/);assert.doesNotMatch(String(error),/do-not-echo-value/);return true;
 });
 assert.equal(calls,1,'No silent retry or native/model action.');
 const out=await retrieveFocusedEvidenceV1(()=>scope,{...args,itemRange:{path:'results[0].connectors',start:0,count:2,fields:['id']}},wireRequest);
 assert.equal(calls,2);assert.equal(out.model_output.result.complete,false);
 assert.equal(out.model_output.native_postcondition_verified,false);assert.equal(out.model_output.whole_task_verified,false);
 assert.equal(out.model_output.source_identity.content_hash,saved.ref.content_hash);
 assert.deepEqual(readAuthoritativeEvidence(saved.ref,scope),original);
 assertBoundedModelEvidencePayload([{type:'function_call_output',call_id:'recovered',output:JSON.stringify(out.model_output)}]);
}));

test('ordinary narrative handoff crosses the actual immutable store, scoped client and unchanged model budget whole',()=>isolated(async()=>{
 const saved=storeEvidence({scope,source:'operator_desktop.function.delegate_revit_task',trust_level:'untrusted_caller',raw});
 assert.equal(saved.projection.helper_findings,undefined,'Reproduces ordinary narrative, not a fabricated structured helper return.');
 assert(!JSON.stringify(saved.projection).includes('Targets12345,67890'),'Reproduces lost continuation identities in the ordinary projection.');
 const original=readAuthoritativeEvidence(saved.ref,scope);
 const out=await retrieveFocusedEvidenceV1(()=>scope,{evidenceId:saved.ref.evidence_id,purpose:'Read the complete helper continuation.',fields:['assistant_message']},request);
 assert.equal(out.model_output.result.selection.assistant_message,message);assert.equal(out.model_output.source_identity.content_hash,saved.ref.content_hash);
 assert.equal(out.model_output.source_identity.byte_count,saved.ref.byte_count);assert.equal(out.model_output.result.complete,false);
 assert.equal(out.model_output.native_postcondition_verified,false);assert.equal(out.model_output.whole_task_verified,false);
 const wire={type:'function_call_output',call_id:'read',output:JSON.stringify(out.model_output)};
 assert(Buffer.byteLength(wire.output)<=8192);assertBoundedModelEvidencePayload([wire]);
 assert.deepEqual(readAuthoritativeEvidence(saved.ref,scope),original,'Read creates no replacement raw artifact or altered source.');
}));

test('actual store refuses foreign session/assignment/run/generation, invalid selectors and modified bytes',()=>isolated(async(root)=>{
 const saved=storeEvidence({scope,source:'operator_desktop.function.delegate_revit_task',trust_level:'untrusted_caller',raw});
 const args={evidenceId:saved.ref.evidence_id,purpose:'Inspect the retained report.',fields:['assistant_message']};
 for(const key of ['session_id','assignment_id','run_id','generation'] as const){const foreign={...scope,[key]:key==='generation'?2:'foreign'};
   await assert.rejects(retrieveFocusedEvidenceV1(()=>foreign,args,request),/outside/);}
 await assert.rejects(retrieveFocusedEvidenceV1(()=>scope,{...args,fields:[],textRange:{start:0,length:5}},request));
 const object=path.resolve(root,saved.ref.artifact_location);assert(object.startsWith(root+path.sep));
 const stored=fs.readFileSync(object),changed=Buffer.from(object.endsWith('.bin.gz')?gunzipSync(stored):stored);
 changed[changed.length-1]^=1;
 fs.writeFileSync(object,object.endsWith('.bin.gz')?gzipSync(changed):changed);
 await assert.rejects(retrieveFocusedEvidenceV1(()=>scope,args,request),/hash verification/);
 if(object.endsWith('.bin.gz')){
  fs.writeFileSync(object,'not a gzip stream');
  await assert.rejects(retrieveFocusedEvidenceV1(()=>scope,args,request),'Malformed compression must also fail closed');
 }
}));

test('missing whole fields and projected row coverage remain explicit through the client',()=>isolated(async()=>{
 const saved=storeEvidence({scope,source:'native:test-rows',trust_level:'authoritative_native',raw:{items:[{id:1,name:'first'},{id:2,name:'second'},{id:3,name:'third'}]}});
 const out=await retrieveFocusedEvidenceV1(()=>scope,{evidenceId:saved.ref.evidence_id,purpose:'Inspect one requested row.',itemRange:{path:'items',start:1,count:1,fields:['id','missing']}},request);
 assert.deepEqual(out.model_output.result.selection,[{row_index:1,values:{id:2,missing:null},missing_fields:['missing']}]);
 assert.equal(out.model_output.result.pagination.next_start,2);assert.equal(out.model_output.result.pagination.source_rows_exhausted,false);
 assert.equal(out.model_output.result.complete,false);assert.equal(out.model_output.whole_task_verified,false);assert.equal(out.model_output.source_identity.trust_level,'authoritative_native');
}));
