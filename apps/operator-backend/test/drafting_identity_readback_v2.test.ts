import fs from'node:fs';import os from'node:os';import path from'node:path';import test from'node:test';import assert from'node:assert/strict';
import{payloadDigestV2}from'@revitoperator/payload-digest-v2';import{storeEvidence}from'../src/evidence/evidence_store.js';
import{committedDraftingIdentityReadbackPlanV2,committedDraftingIdentityRefreshPlanV2}from'../src/verification/regular_schedule_recheck_v2.js';

const faults:Record<string,(s:any,o:any,p:any)=>void>={
 exact:()=>{},paused:s=>s.execution_control={state:'paused'},terminal:s=>s.terminal=true,
 proposed:s=>s.completion_proposal={},unknown:s=>s.unresolved_unknown_operation_ids=['old'],inflight:s=>s.in_flight_operation_ids=['pending'],
 invalidated:(s,o)=>s.input_invalidated_operation_ids=[o.operation_id],foreign:(_s,o)=>o.binding={...o.binding,generation:2},
 nonnative:(_s,o)=>o.result.authority='model',uncommitted:(_s,o)=>o.result.native_transaction_state='pending',
 signature:(_s,o)=>o.result.request_identity={...o.request_identity,request_signature:'foreign'},
 missingEvidence:(_s,o)=>o.observation_ids=[],changedDigest:(_s,o)=>o.result.raw_payload_hash='0'.repeat(64),
 priorCheck:(s,o)=>{o.verification_operation_ids=['failed'];s.operations.failed={operation_id:'failed',result:{status:'failed'}};},
 allowExisting:(_s,o)=>o.input.body.allowExisting=true,extraInput:(_s,o)=>o.input.body.unreviewed=true,
 wrongPayloadName:(_s,_o,p)=>p.name='Another view',wrongPayloadScale:(_s,_o,p)=>p.scale=200,
 notCreated:(_s,_o,p)=>p.created=false,wrongType:(_s,_o,p)=>p.viewType='FloorPlan',
 missingAddition:(_s,_o,p)=>p.transaction.added_element_ids=[],deleted:(_s,_o,p)=>p.transaction.deleted_element_ids=[99],
 pending:(_s,_o,p)=>p.transaction.status='pending',contradictoryPending:(_s,_o,p)=>p.transaction.pending=true,rolledBack:(_s,_o,p)=>p.transaction.rolled_back=true,foreignTarget:(_s,o)=>o.result.affected_target_identities=['element_id:99']
};
for(const[name,fault]of Object.entries(faults))test(`initial drafting identity planner ${name} only schedules evidence`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-draft-plan-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const binding={assignment_id:'draft-assignment',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'a'.repeat(64)};
  const input={method:'POST',path:'/revit/create-drafting-view',body:{name:'Vector working detail',scale:100,allowExisting:false}};
  const request={capability_id:'revit_call_tool',method:input.method,path:input.path,request_signature:'request'};
  const payload={created:true,success:true,applied:true,viewId:20,name:input.body.name,scale:100,viewType:'DraftingView',transaction:{status:'committed',committed:true,added_element_ids:[20],modified_element_ids:[],deleted_element_ids:[]}};
  const op:any={operation_id:'draft',binding,input,request_identity:request,requested_effect:'apply',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',persistent_effect:'applied',verification_operation_ids:[],observation_ids:['obs'],
   result:{operation_id:'draft',binding,request_identity:request,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',authority:'native-host',receipt_id:'receipt',native_correlation_id:'native',completed_at:'2026-10-22T19:00:00Z',affected_target_identities:['element_id:20']}};
  const s:any={current_binding:binding,terminal:false,outcome:'active',in_flight_operation_ids:[],unresolved_unknown_operation_ids:[],input_invalidated_operation_ids:[],operations:{draft:op},observations:{}};
  // Payload faults are retained with their own authentic digest, so the payload
  // predicates must reject them rather than depending on a hash mismatch.
  const hash=payloadDigestV2(payload).digest;op.result.raw_payload_hash=hash;
  fault(s,op,payload);if(name!=='changedDigest')op.result.raw_payload_hash=payloadDigestV2(payload).digest;
  const stored=storeEvidence({scope:{session_id:binding.session_id,assignment_id:binding.assignment_id,run_id:binding.run_id,generation:1,attempt_id:'draft'},source:'synthetic-native-create',trust_level:'authoritative_native',raw:payload});
  s.observations.obs={operation_id:'draft',binding,authority:'native-host',raw_payload_hash:payloadDigestV2(payload).digest,raw_payload_ref:'evidence:'+stored.ref.evidence_id,facts:[]};
  const before=JSON.stringify(s);assert.deepEqual(committedDraftingIdentityReadbackPlanV2(s,op),name==='exact'?{method:'POST',path:'/revit/get-element-summary',body:{elementIds:[20]}}:null,name);
  assert.equal(committedDraftingIdentityRefreshPlanV2(s,op),null,'An unchecked creation never borrows refresh proof');
  assert.equal(JSON.stringify(s),before,'Scheduling does not change history, dispatch or proof');
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});
