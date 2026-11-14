import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {selectNativeExecutionAudit} from '../src/evidence/native_execution_audit.js';
const scope={session_id:'audit',assignment_id:'assignment',run_id:'run',generation:1};
const field='projection.native_execution_audit';
function fixture(){return {schema:'revit-operator.dynamic-revit-program-run.v1',execution_lane:'native',evidence:{nativeExecutionReceipt:JSON.stringify({
 schema:'dynamic-revit-native-execution-receipt/v1',source_hash:'sha256:'+'a'.repeat(64),document_fingerprint:'sha256:'+'b'.repeat(64),
 document_session_id:'document',document_revision_before:1,verified:false,retry_permitted:false,read_only:false,success:true,
 transaction:{status:'committed',committed:true,affected_element_ids:[1,2],added_element_ids:[1],modified_element_ids:[2],deleted_element_ids:[]},
 program_result:'2 elements',error:null,effect_observation:{rows:Array.from({length:800},(_,i)=>({id:i,observed:'x'.repeat(2000)}))}})}};}
function run(fn:()=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-audit-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}}
test('large native receipt audit selects exact needed fields, keeps raw evidence and refuses legacy whole-field oversize',()=>run(()=>{
 const raw=fixture(),original=JSON.stringify(raw),saved=storeEvidence({scope,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',raw},8192);
 const request={scope,evidence_id:saved.ref.evidence_id,purpose:'Review executed code outcome',max_bytes:196608};
 assert.throws(()=>retrieveEvidence({...request,fields:['payload.evidence.nativeExecutionReceipt']}),/exceeds/);
 const selected=retrieveEvidence({...request,fields:[field]}),audit=(selected.selection as any)[field],native=JSON.parse(raw.evidence.nativeExecutionReceipt);
 const {effect_observation,...expected}=native;assert.deepEqual(audit,expected);assert.equal(audit.effect_observation,undefined);
 assert.equal(selected.complete,false);assert.equal(selected.selection_origins?.[field],'deterministic_projection');assert.equal(selected.evidence_ref.content_hash,saved.ref.content_hash);
 assert(selected.returned_bytes<2000);assert.equal(JSON.stringify(raw),original);assert.deepEqual(selected.missing_fields,[]);
 for(const key of ['run_id','session_id','assignment_id'])assert.throws(()=>retrieveEvidence({...request,scope:{...scope,[key]:'foreign'},fields:[field]}),/scope/);
 const artifact=path.join(rootFromEnv(),saved.ref.artifact_location);fs.appendFileSync(artifact,'tampered');assert.throws(()=>retrieveEvidence({...request,fields:[field]}));
}));
const rootFromEnv=()=>process.env.OPERATOR_WORKSPACE_ROOT!;
test('audit is unavailable for untrusted, foreign or malformed native evidence and never sanitizes unknown outcomes',()=>run(()=>{
 const raw=fixture(),saved=storeEvidence({scope,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',raw},8192);
 for(const patch of [{source:'other'},{trust_level:'untrusted_caller' as const},{secret_screening_status:'blocked' as any}])assert.equal(selectNativeExecutionAudit({...saved.ref,...patch},raw),null);
 for(const receipt of ['invalid','{}','[]'])assert.equal(selectNativeExecutionAudit(saved.ref,{...raw,evidence:{nativeExecutionReceipt:receipt}}),null);
 assert.equal(selectNativeExecutionAudit(saved.ref,{...raw,execution_lane:'foreign'}),null);
 const native=JSON.parse(raw.evidence.nativeExecutionReceipt);native.transaction.status='unknown';native.verified=true;delete native.document_session_id;
 const selected=selectNativeExecutionAudit(saved.ref,{...raw,evidence:{nativeExecutionReceipt:JSON.stringify(native)}})!;
 assert.equal((selected.transaction as any).status,'unknown');assert.equal(selected.verified,true);assert(!Object.hasOwn(selected,'document_session_id'),'missing fields stay missing for consumer rejection');
}));
