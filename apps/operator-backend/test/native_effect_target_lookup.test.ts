import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {projectNativeProgram} from '../src/evidence/native_program_projection.js';
import {assembleBoundedEvidenceContext,modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
const scope={session_id:'lookup',assignment_id:'assignment',run_id:'run',generation:1};
const field='projection.native_execution_audit.transaction.affected_element_ids';
function fixture(count=498){const ids=Array.from({length:count},(_,i)=>975124+i);return {
 schema:'revit-operator.dynamic-revit-program-run.v1',run_id:'native-run',requested_mode:'apply',execution_lane:'native',execution_status:'completed',execution_ok:true,
 native_outcome:{persistent_effect:'applied',native_transaction_state:'committed',verification_required:true,task_verified:false,program_result:'Created elements; not verification.',error:null},diagnostics:[],
 evidence:{nativeExecutionReceipt:JSON.stringify({schema:'dynamic-revit-native-execution-receipt/v1',success:true,verified:false,
 transaction:{status:'committed',committed:true,affected_element_ids:ids,added_element_ids:ids.slice(0,-2),modified_element_ids:ids.slice(-2,-1),deleted_element_ids:ids.slice(-1)},
 effect_observation:{retainedState:'x'.repeat(100000)}})}};}
function run(fn:()=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'effect-lookup-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}}
const save=(raw:any,options:any={})=>storeEvidence({scope,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',raw,...options},8192);

for(const count of [3,498,4096])test('model-visible native lookup resolves exact historical footprint at '+count+' targets',()=>run(()=>{
 const raw=fixture(count),before=JSON.stringify(raw),saved=save(raw),inline:any=saved.projection.inline_payload;
 const envelope=modelEvidenceEnvelope(assembleBoundedEvidenceContext({projections:[saved.projection],...scope}).projections);
 const hint=(envelope.evidence_projections[0]!.inline_payload as any)?.affected_target_lookup;
 assert(hint,'supported receipt field must be discoverable without JSON-string paging');
 assert.deepEqual(hint.fields,[field]);assert.equal(hint.evidence_id,saved.ref.evidence_id);assert.equal(hint.observed_count,count);
 assert(Buffer.byteLength(JSON.stringify(hint))<900,'large target arrays remain on demand');
 const retrieved=retrieveEvidence({scope,...hint,purpose:'Inspect historical effect targets'});
 assert.deepEqual((retrieved.selection as any)[field],JSON.parse(raw.evidence.nativeExecutionReceipt).transaction.affected_element_ids);
 assert.equal(retrieved.complete,false);assert.deepEqual(retrieved.missing_fields,[]);assert.equal(retrieved.evidence_ref.content_hash,saved.ref.content_hash);
 assert.equal(inline.native_outcome.task_verified,false);assert.equal(inline.retry_authorized,false);
 assert.match(hint.usage,/deleted|collateral/);assert.match(hint.usage,/not.*current|not.*verification/);
 assert.equal(JSON.stringify(raw),before);
 for(const key of ['session_id','assignment_id','run_id'])assert.throws(()=>retrieveEvidence({scope:{...scope,[key]:'foreign'},...hint,purpose:'wrong owner'}),/scope/);
}));
for(const variant of ['unknown','failed','read','foreign_source','untrusted','malformed','wrong_schema','missing_ids','duplicate_ids','bad_ids','too_many','union_mismatch','uncommitted'])test('no misleading effect lookup for '+variant,()=>run(()=>{
 const raw:any=fixture(),receipt=JSON.parse(raw.evidence.nativeExecutionReceipt),options:any={};
 if(variant==='unknown'){raw.native_outcome.native_transaction_state='unknown';raw.native_outcome.persistent_effect='unknown';raw.execution_ok=false;raw.execution_status='failed';}
 if(variant==='failed'){raw.execution_ok=false;raw.execution_status='failed';}
 if(variant==='read'){raw.requested_mode='read';raw.native_outcome.native_transaction_state='not_started';raw.native_outcome.persistent_effect='none';}
 if(variant==='foreign_source')options.source='unrelated';if(variant==='untrusted')options.trust_level='untrusted_caller';
 if(variant==='wrong_schema')receipt.schema='foreign';if(variant==='missing_ids')delete receipt.transaction.affected_element_ids;
 if(variant==='duplicate_ids')receipt.transaction.affected_element_ids.push(receipt.transaction.affected_element_ids[0]);
 if(variant==='bad_ids')receipt.transaction.affected_element_ids[0]='975124';
 if(variant==='too_many')receipt.transaction.affected_element_ids=Array.from({length:4097},(_,i)=>i+1);
 if(variant==='union_mismatch')receipt.transaction.modified_element_ids=[12];if(variant==='uncommitted')receipt.transaction.committed=false;
 raw.evidence.nativeExecutionReceipt=variant==='malformed'?'{':JSON.stringify(receipt);
 assert.equal((save(raw,options).projection.inline_payload as any)?.affected_target_lookup,undefined);
}));
test('optional lookup never crowds out exact program result at existing projection byte cap',()=>run(()=>{
 const raw=fixture(),saved=save(raw),full:any=projectNativeProgram(saved.ref,raw,8192);assert(full.affected_target_lookup);
 const {affected_target_lookup,...without}=full,cap=Buffer.byteLength(JSON.stringify(without));
 assert.deepEqual(projectNativeProgram(saved.ref,raw,cap),without);assert.equal(projectNativeProgram(saved.ref,raw,cap-1),null);
}));
