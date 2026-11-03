import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {createHash} from 'node:crypto';
import {familyFileLoadVerificationFixtureV2 as fixture} from './fixtures/family_file_load_verification_fixture.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {verifiedChangePresentationV2} from '../src/assignments/verified_change_presentation_v2.js';
import {codexAssignmentEvidenceContextV2} from '../src/brains/codex_assignment_evidence.js';
import {familyLoadVerificationExclusionGuidanceV2,committedFamilySessionReadbackPlanV2} from '../src/verification/family_session_verification_v2.js';
import {prepareCodexAssignmentProgressV2} from '../src/brains/codex_assignment_progress.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {withFamilySchedulePreservation} from './family_load_schedule_preservation.fixtures.js';

for(const name of ['exact','wrong_family','wrong_symbol','missing_symbol','foreign_target','read_failure','schema_rejected','paused','stale','foreign_authority','partial_inventory','overwrite','unknown_effect','corrupt_retained_apply','collateral_modified','collateral_deleted',
 'preserved:exact','preserved:wrong_family','preserved:wrong_symbol','preserved:read_failure','preserved:schema_rejected','preserved:paused','preserved:stale','preserved:foreign_authority','preserved:partial_inventory','preserved:overwrite','preserved:unknown_effect','preserved:corrupt_retained_apply','preserved:current_schedule_changed','preserved:before_schedule_changed','preserved:untrusted_apply'] as const)
test(`new family file ${name}: host performs one separate read, preserves effects and durable verification truth`,async()=>{
 const preserved=name.startsWith('preserved:'),variant=preserved?name.slice('preserved:'.length):name;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-family-file-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f:any=fixture();if(preserved)withFamilySchedulePreservation(f);
  if(variant==='before_schedule_changed')f.apply.schedulePreservation.after[0].parameters.push({id:1,value:'changed'});
  if(variant==='partial_inventory')f.apply.changeTracking.exhaustiveChangeInventory=false;if(variant==='overwrite')f.input.body.overwriteParameterValues=true;
  const collateral=variant==='collateral_modified'||variant==='collateral_deleted';
  if(collateral){const ids=[1420970,1422218,1488968,1521719,1521731,1543793];
   f.apply.transaction[variant==='collateral_modified'?'modified_element_ids':'deleted_element_ids']=ids;
   f.apply.transaction.affected_element_ids=[...f.apply.transaction.added_element_ids,...ids];}
  const goal=createGoal({title:'Load the supplied annotation family',objective:'Load the supplied family; inspect its native identity before using it. Tagging remains separate.',acceptance_criteria:['Requested definition loaded.'],status:'active',related_session_id:'family-file-session',created_by:'family-file-principal',work_budget:{requested_effect:'apply',document_fingerprint:'family-file-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'family-file-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_tool:string,args:any){validations.push(args);if(variant==='schema_rejected'&&args.path==='/revit/get-element-summary')throw Error('read_schema_rejected');},async callTool(_tool:string,args:any,context:any){
   calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.path==='/revit/get-element-summary';if(read&&variant==='read_failure')throw Error('native_read_failed');
   const payload=structuredClone(read?f.payload:f.apply);
   if(read&&preserved){assert.deepEqual(args.body.preservationScheduleIds,[...f.apply.transaction.modified_element_ids].sort((a:number,b:number)=>a-b));assert.deepEqual(args.body.elementIds,[...f.apply.transaction.affected_element_ids].sort((a:number,b:number)=>a-b));}
   if(read&&variant==='current_schedule_changed')payload.schedulePreservation.items[0].parameters.push({id:1,value:'changed'});
   if(read&&variant==='wrong_family')payload.result[0].name='Other';if(read&&variant==='wrong_symbol')payload.result[1].className='Element';
   if(read&&variant==='missing_symbol')payload.result.splice(1,1);if(read&&variant==='foreign_target')payload.result[1].id=77;
   const current=getAssignmentKernelSnapshotV2(goal.id)!,op=current.operations[lease.operation_id]!;
   if(!read&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
   if(read&&variant==='corrupt_retained_apply'){const applied=Object.values(current.operations).find(o=>o.persistent_effect==='applied')!;const observation=current.observations[applied.observation_ids[0]!]!;const ref=JSON.parse(fs.readFileSync(path.join(root,'evidence/refs',observation.raw_payload_ref.replace('evidence:','')+'.json'),'utf8'));fs.writeFileSync(path.join(root,ref.artifact_location),'{}');}
   if(read&&variant==='untrusted_apply'){const applied=Object.values(current.operations).find(o=>o.persistent_effect==='applied')!;const observation=current.observations[applied.observation_ids[0]!]!;const file=path.join(root,'evidence/refs',observation.raw_payload_ref.replace('evidence:','')+'.json'),ref=JSON.parse(fs.readFileSync(file,'utf8'));ref.trust_level='untrusted';fs.writeFileSync(file,JSON.stringify(ref));}
   return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':variant==='unknown_effect'?'unknown':'applied',native_transaction_state:read?'not_applicable':variant==='unknown_effect'?'pending':'committed',authority:read&&variant==='foreign_authority'?'model':'native-host',affected_target_identities:read?[]:f.apply.transaction.affected_element_ids.map((id:number)=>'element_id:'+id).sort(),result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:read&&variant==='stale'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'family-file-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{const response:any=await handleCodexDynamicToolCall(runtime,{id:'load-request',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'file-load-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(snapshot.operations).find(o=>o.input.path==='/revit/load-family')!;
   assert.equal(calls.filter(x=>x.path==='/revit/load-family').length,1,'never repeat load');assert.equal(apply.persistent_effect,variant==='unknown_effect'?'unknown':'applied',JSON.stringify({result:apply.result}));
   if(variant!=='unknown_effect')assert.equal(response.success,true);
   const planned=!collateral&&!['paused','partial_inventory','overwrite','unknown_effect','before_schedule_changed'].includes(variant);
   assert.equal(calls.filter(x=>x.path==='/revit/get-element-summary').length,planned&&variant!=='schema_rejected'?1:0,
    JSON.stringify({messages:response.contentItems?.filter((x:any)=>x.type==='inputText'&&!x.text.startsWith('{')),plan:committedFamilySessionReadbackPlanV2(snapshot,apply),validations,verification:apply.verification_operation_ids}));
   if(planned)assert(validations.some(x=>x.path==='/revit/get-element-summary'));
   const verified=apply.verification_operation_ids.some(id=>snapshot.operations[id]!.observation_ids.some(oid=>snapshot.observations[oid]!.facts.some(fact=>fact.fact_id==='verification.postcondition_satisfied'&&fact.value===true)));
   assert.equal(verified,variant==='exact');
   assert.equal(verifiedChangePresentationV2(snapshot),variant==='exact'?'Verified in Revit: 1 family definition; 1 family type.':null,
    'Loaded native definitions never become placed annotation tags in a saved task presentation');
   if(variant==='unknown_effect')assert(snapshot.unresolved_unknown_operation_ids.includes(apply.operation_id),'unknown requires reconciliation, not a postcondition retry');
   else assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
   assert.equal(snapshot.terminal,false,'loaded identity cannot certify the complete task');
   if(collateral){const before=JSON.stringify(snapshot),pending=JSON.parse(codexAssignmentEvidenceContextV2(snapshot)).pending_verification.find((p:any)=>p.operation_id===apply.operation_id);
    assert.match(pending.guidance,variant==='collateral_modified'?/6 modified/:/6 deleted/,'Known collateral exclusion must be actionable rather than repeating an identity-only read');
    assert.match(pending.guidance,/1420970/);assert.match(pending.guidance,/does not verify/);
    assert.match(pending.guidance,/Do not reload/);assert.equal(pending.check_state,'no_recognized_postcondition');
    assert.equal(JSON.stringify(snapshot),before,'diagnostics never change settlement, effects or verification');
    for(const change of [
     (s:any,o:any)=>o.result.authority='model', (s:any,o:any)=>o.result.native_transaction_state='pending',
     (s:any,o:any)=>o.result.raw_payload_hash='0'.repeat(64), (s:any,o:any)=>o.result.status='failed',
     (s:any,o:any)=>o.result.binding.run_id='foreign-run', (s:any,o:any)=>o.binding.generation++,
     (s:any,o:any)=>o.request_identity.request_signature='foreign-request',
     (s:any,o:any)=>o.input.path='/revit/load-family-doc', (s:any,o:any)=>o.observation_ids=[],
     (s:any,o:any)=>s.observations[o.observation_ids[0]].authority='model',
     (s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
     (s:any,o:any)=>s.unresolved_unknown_operation_ids=['unknown-op'],
     (s:any,o:any)=>{s.operations.later={...structuredClone(o),operation_id:'later',result:{...o.result,completed_at:'2099-01-01T00:00:00Z'}};}
    ]){const clone=structuredClone(snapshot),op=clone.operations[apply.operation_id]!;change(clone,op);
     assert.equal(familyLoadVerificationExclusionGuidanceV2(clone,op),null,change.toString());}
    // These are isolated synthetic evidence records, never replacements of the
    // retained receipt. They exercise native payload limits independently from
    // the model-visible consumer and preserve the real snapshot/effect history.
    const projected=(payload:any,foreignScope=false,untrusted=false)=>{const clone=structuredClone(snapshot),op=clone.operations[apply.operation_id]!,ob=clone.observations[op.observation_ids[0]!]!;
     const evidence=storeEvidence({scope:{...op.binding,generation:op.binding.generation+(foreignScope?1:0),attempt_id:op.operation_id},source:'test-native-load',trust_level:untrusted?'host_observed':'authoritative_native',raw:payload});
     ob.raw_payload_ref='evidence:'+evidence.ref.evidence_id;ob.raw_payload_hash=op.result!.raw_payload_hash=createHash('sha256').update(canonicalJsonV2(payload)).digest('hex');
     return familyLoadVerificationExclusionGuidanceV2(clone,op);};
    assert.equal(projected(f.apply,true),null,'foreign retained scope is not authoritative');
    assert.equal(projected(f.apply,false,true),null,'host-observed bytes cannot confer native authority');
    for(const change of [
     (p:any)=>p.changeTracking.exhaustiveChangeInventory=false,(p:any)=>p.changeTracking.captureFailureCount=1,
     (p:any)=>p.transaction.committed=false,(p:any)=>p.transaction.modified_element_ids.push(p.familyId),
     (p:any)=>p.transaction.affected_element_ids.pop(),(p:any)=>p.transaction.affected_element_ids.push(99),
     (p:any)=>p.transaction.affected_element_ids[0]=-1,(p:any)=>p.transaction.added_element_ids.push(p.familyId),
     (p:any)=>p.transaction.modified_element_ids=null,(p:any)=>p.symbols[0].id=99,
     (p:any)=>p.transaction.deleted_element_ids=Array.from({length:2001},(_,i)=>i+1),
     (p:any)=>p.ok=false,(p:any)=>p.status='Reloaded'
    ]){const payload=structuredClone(f.apply);change(payload);assert.equal(projected(payload),null,change.toString());}
    const additive=structuredClone(f.apply);additive.transaction.modified_element_ids=[];additive.transaction.deleted_element_ids=[];
    additive.transaction.affected_element_ids=[...additive.transaction.added_element_ids];assert.equal(projected(additive),null,'legacy additive guidance retained');
    const many=structuredClone(f.apply);many.transaction.modified_element_ids=Array.from({length:20},(_,i)=>2000000+i);many.transaction.deleted_element_ids=[];
    many.transaction.affected_element_ids=[...many.transaction.added_element_ids,...many.transaction.modified_element_ids];
    const bounded=projected(many)!;assert.match(bounded,/20 modified/);assert.match(bounded,/4 more; ID list truncated/);assert.doesNotMatch(bounded,/2000019/);
    assert.equal(JSON.stringify(snapshot),before,'synthetic neighboring receipts leave original snapshot intact');
    const progress=prepareCodexAssignmentProgressV2(binding);
    assert.match(progress.prompt,variant==='collateral_modified'?/Gap contracts:[\s\S]*6 modified/:/Gap contracts:[\s\S]*6 deleted/,'ordinary progress gap carries the same actionable exclusion');}
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
