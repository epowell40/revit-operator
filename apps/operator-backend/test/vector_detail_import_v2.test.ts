import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../src/domain/assignment-kernel/verified_work_targets.js';
import {vectorSourceProofRecordV2} from '../src/verification/vector_detail_source_proof_v2.js';
import {prepareVectorSourceProofV2} from '../src/verification/vector_detail_source_proof_v2.js';
import {vectorDetailImportPostconditionSatisfiedV2} from '../src/verification/vector_detail_import_v2.js';
import {readEvidenceRef,readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';
import {vectorImportFixture} from './vector_detail_import.fixtures.js';

for(const variant of ['exact_first','exact_continuation','exact_last','tampered_plan','missing_source','foreign_source','bad_native_projection','wrong_part','read_failure','paused_after_commit','incomplete_inventory']as const)
test(`ordinary vector import ${variant} keeps source/native verification integral without replay`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-vector-proof-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const positive=variant.startsWith('exact_'),partIndex=variant==='exact_continuation'?1:variant==='exact_last'?2:0;
  const f=await vectorImportFixture(root,variant==='foreign_source'?'another-session':'vector-session',partIndex);
  if(variant==='tampered_plan'){
   const altered=structuredClone(f.plan);altered.entities[0].points[1][0]+=1; // Keep its embedded nativePlanSha256 unchanged.
   const packed=gzipSync(Buffer.from(JSON.stringify(altered))),sha=createHash('sha256').update(packed).digest('hex');
   fs.writeFileSync(path.join(root,f.prepared.native_plan_artifact.relative_path),packed);
   f.input.body.expectedNativePlanFileSha256=sha;f.applied.nativePlanFileSha256=sha;f.nativeRead.nativePlanFileSha256=sha;
  }
  if(variant==='missing_source')fs.unlinkSync(path.join(root,f.attachment.relative_path!));
  if(variant==='bad_native_projection')f.nativeRead.sourceProjection.sourceNativeProjectionMatches=false;
  if(variant==='wrong_part')f.nativeRead.partIndex+=1;
  if(variant==='incomplete_inventory')f.applied.changeTracking.exhaustiveChangeInventory=false;
  const goal=createGoal({title:'Copy this diagram',objective:'Copy the attached diagram into an editable drafting view.',acceptance_criteria:['The editable diagram is present.'],status:'active',
   related_session_id:'vector-session',created_by:'vector-principal',work_budget:{requested_effect:'apply',document_fingerprint:'vector-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'vector-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const isRead=args.path===f.readInput.path;
    if(isRead&&variant==='read_failure')throw Error('native-vector-read-failed');
    const payload=structuredClone(isRead?f.nativeRead:f.applied);
    if(!isRead&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:isRead?'none':'applied',native_transaction_state:isRead?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:isRead?['element_id:30']:f.affected,result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:payload,semantic_facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},
      {fact_id:'verification.vector_original_source_comparison',fact_class:'control',value:'forged producer assertion'}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'vector-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{
   const response=await handleCodexDynamicToolCall(runtime,{id:'vector-import',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'vector-turn',tool:'revit_call_tool',arguments:f.input}}as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path===f.input.path).length,1);
   assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['paused_after_commit','incomplete_inventory'].includes(variant)?0:1,JSON.stringify({response,calls}));
   const read=apply.verification_operation_ids.map(id=>s.operations[id]!).find(Boolean);
   const facts=read?.observation_ids.flatMap(id=>s.observations[id]!.facts)??[],verified=facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true);
   assert.equal(verified,positive,JSON.stringify({response,facts}));
   assert(!facts.some(f=>f.fact_id==='verification.vector_original_source_comparison'&&f.value==='forged producer assertion'));
   if(positive){
    assert.deepEqual(verifiedNativeWorkTargetIdentitiesV2(s,apply.operation_id),['element_id:20']);
    const fact=facts.find(f=>f.fact_id==='verification.vector_original_source_comparison')!;assert(fact);const proof=JSON.parse(String(fact.value));assert.equal(proof.state,'matched');
    const evidence=readEvidenceRef(proof.evidence_id);assert.equal(evidence.trust_level,'host_observed');assert.equal(evidence.content_hash,proof.content_hash);
    const record=JSON.parse(readAuthoritativeEvidence(evidence,{...binding,attempt_id:read!.operation_id}).toString('utf8'));
    assert.equal(record.matches,true);assert.equal(record.sourceSha256,f.attachment.sha256);assert.equal(record.sourcePartEntityCount,f.applied.createdContentCount);
    assert.equal(vectorSourceProofRecordV2({record,evidence}as any,read!.result!),null,'Retained or producer JSON cannot impersonate the backend-issued source proof.');
    const raw={structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:read!.result!,observation:{raw_payload:f.nativeRead,semantic_facts:[]}}};
    const issued=await prepareVectorSourceProofV2({operation_id:read!.operation_id,assignment_id:goal.id,binding},raw,s);assert(issued);
    assert.equal(vectorDetailImportPostconditionSatisfiedV2(s,apply,read!.result!,f.nativeRead,issued),true);
    for(const edit of [(v:any)=>v.unresolved_unknown_operation_ids.push('old-unknown'),(v:any)=>(v.input_invalidated_operation_ids??=[]).push(apply.operation_id),
     (v:any)=>(v.input_invalidated_operation_ids??=[]).push(read!.operation_id),(v:any)=>v.operations[read!.operation_id].input.body.partIndex+=1,
     (v:any)=>v.operations[apply.operation_id].input.body.expectedNativePlanSha256='f'.repeat(64),
     (v:any)=>v.operations[read!.operation_id].binding.generation+=1]){
     const v=structuredClone(s);edit(v);assert.equal(vectorDetailImportPostconditionSatisfiedV2(v,v.operations[apply.operation_id]!,read!.result!,f.nativeRead,issued),false);
    }
    assert.equal(vectorDetailImportPostconditionSatisfiedV2(s,apply,{...read!.result!,completed_at:new Date(Date.parse(apply.result!.completed_at)-1).toISOString()},f.nativeRead,issued),false);
    assert.equal(vectorSourceProofRecordV2(issued,{...read!.result!,result_id:'different-result'}),null);
    assert.equal(vectorSourceProofRecordV2(issued,{...read!.result!,raw_payload_hash:'f'.repeat(64)}),null);
   }
   if(variant!=='incomplete_inventory')assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!positive);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
});
