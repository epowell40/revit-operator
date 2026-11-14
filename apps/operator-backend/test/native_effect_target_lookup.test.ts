import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {projectNativeProgram} from '../src/evidence/native_program_projection.js';
import {retrieveFocusedEvidenceV1} from '@revitoperator/assignment-kernel-v2-contracts/focused-evidence';
import {assembleBoundedEvidenceContext,modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
const scope={session_id:'lookup',assignment_id:'assignment',run_id:'run',generation:1};
const field='projection.native_execution_audit.transaction.affected_element_ids';
function fixture(count=498){const ids=Array.from({length:count},(_,i)=>975124+i);return {
 schema:'revit-operator.dynamic-revit-program-run.v1',run_id:'native-run',requested_mode:'apply',execution_lane:'native',execution_status:'completed',execution_ok:true,
 native_outcome:{persistent_effect:'applied',native_transaction_state:'committed',verification_required:true,task_verified:false,program_result:'Created elements; not verification.',error:null},diagnostics:[],
 evidence:{nativeExecutionReceipt:JSON.stringify({schema:'dynamic-revit-native-execution-receipt/v1',success:true,verified:false,
 transaction:{status:'committed',committed:true,affected_element_ids:ids,added_element_ids:ids.slice(0,-2),modified_element_ids:ids.slice(-2,-1),deleted_element_ids:ids.slice(-1)},
 effect_observation:{retainedState:'x'.repeat(100000)}})}};}
async function run(fn:()=>void|Promise<void>){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'effect-lookup-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{await fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}}
const save=(raw:any,options:any={})=>storeEvidence({scope,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',raw,...options},8192);

for(const count of [3,498,742,4096])test('model-visible native lookup resolves exact historical footprint at '+count+' targets',()=>run(async()=>{
 const raw=fixture(count),before=JSON.stringify(raw),saved=save(raw),inline:any=saved.projection.inline_payload;
 const envelope=modelEvidenceEnvelope(assembleBoundedEvidenceContext({projections:[saved.projection],...scope}).projections);
 const hint=(envelope.evidence_projections[0]!.inline_payload as any)?.affected_target_lookup;
 assert(hint,'supported receipt field must be discoverable without JSON-string paging');
 assert.equal(hint.tool,'operator_retrieve_evidence');assert.equal(hint.arguments.evidenceId,saved.ref.evidence_id);assert.equal(hint.observed_count,count);
 assert(Buffer.byteLength(JSON.stringify(hint))<1000,'large target arrays remain on demand');
 const request=async(route:string,options:{body:string})=>{assert.equal(route,'/evidence/retrieve');return {ok:true,result:retrieveEvidence(JSON.parse(options.body))};};
 let args=hint.arguments,got:number[]=[];let pages=0;
 do{const out=await retrieveFocusedEvidenceV1(()=>scope,args,request),r:any=out.model_output.result;pages++;
   assert.equal(r.complete,false);assert.equal(out.model_output.native_postcondition_verified,false);assert.equal(out.model_output.whole_task_verified,false);
   assert.equal(out.model_output.source_identity.content_hash,saved.ref.content_hash);assert(r.returned_bytes<=4096);assert(Buffer.byteLength(JSON.stringify(out.model_output))<=8192);
   got.push(...(Array.isArray(r.selection)?r.selection:r.selection[field]));
   args=r.pagination?.has_more?{...args,itemRange:{...args.itemRange,start:r.pagination.next_start}}:null;
 }while(args);
 assert.deepEqual(got,JSON.parse(raw.evidence.nativeExecutionReceipt).transaction.affected_element_ids);
 assert.equal(pages,count<=498?1:Math.ceil(count/256));
 assert.equal(inline.native_outcome.task_verified,false);assert.equal(inline.retry_authorized,false);
 assert.match(hint.usage,/deleted|collateral/);assert.match(hint.usage,/not.*current|not.*verification/);
 assert.equal(JSON.stringify(raw),before);
 for(const key of ['session_id','assignment_id','run_id'])await assert.rejects(()=>retrieveFocusedEvidenceV1(()=>({...scope,[key]:'foreign'}),hint.arguments,request),/scope/);
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

test('derived historical pages remain partial even when exhausted and cannot be forged by raw projection',()=>run(()=>{
 const raw:any=fixture(3);raw.projection={native_execution_audit:{transaction:{affected_element_ids:[999]}}};
 const saved=save(raw),args={scope,evidence_id:saved.ref.evidence_id,purpose:'Inspect retained IDs',item_range:{path:field,start:0,count:256},max_bytes:4096};
 const out=retrieveEvidence(args);assert.deepEqual(out.selection,[975124,975125,975126]);assert.equal(out.complete,false);
 assert.equal(out.pagination?.has_more,false);assert.equal(out.selection_origins?.[field],'deterministic_projection');
 for(const options of [{trust_level:'untrusted_caller'},{source:'foreign'}]){
   const untrusted=save(raw,options);assert.throws(()=>retrieveEvidence({...args,evidence_id:untrusted.ref.evidence_id}),/must select an array/);
 }
 assert.throws(()=>retrieveEvidence({...args,item_range:{...args.item_range,path:'projection.native_execution_audit.transaction'}}),/must select an array/);
 assert.throws(()=>retrieveEvidence({...args,item_range:{...args.item_range,path:'projection.native_execution_audit.__proto__'}}));
}));

test('derived paging retains byte-limited continuation for large numeric identities',()=>run(()=>{
 const raw:any=fixture(300),receipt=JSON.parse(raw.evidence.nativeExecutionReceipt);
 const ids=Array.from({length:300},(_,i)=>Number.MAX_SAFE_INTEGER-i);receipt.transaction={...receipt.transaction,affected_element_ids:ids,added_element_ids:ids,modified_element_ids:[],deleted_element_ids:[]};raw.evidence.nativeExecutionReceipt=JSON.stringify(receipt);
 const saved=save(raw),out=retrieveEvidence({scope,evidence_id:saved.ref.evidence_id,purpose:'Inspect byte bounded IDs',item_range:{path:field,start:0,count:256},max_bytes:4096});
 assert.equal(out.complete,false);assert.equal(out.pagination?.byte_limited,true);assert(out.pagination!.returned_count<256);assert.equal(out.pagination!.next_start,out.pagination!.returned_count);assert(out.returned_bytes<=4096);
 assert.deepEqual(out.selection,ids.slice(0,out.pagination!.returned_count));
}));
