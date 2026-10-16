import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {projectParameterBindingReadbackMatchesV2,projectParameterBindingRequestV2,projectParameterBindingReadIdV2,projectParameterBindingPostconditionSatisfiedV2} from '../src/verification/project_parameter_binding_v2.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
import {operationTargetSelectorV2,verificationCapabilityAdmissionV2} from '../src/verification/verification_capability_admission_v2.js';
const local=new URL('./fixtures/project-parameter-binding.json',import.meta.url);
const file=fs.existsSync(local)?local:new URL('../../test/fixtures/project-parameter-binding.json',import.meta.url);
const fixture=()=>JSON.parse(fs.readFileSync(file,'utf8'));

test('new shared instance binding needs actual identity and complete separate native owner readback',()=>{
 const f=fixture();assert.equal(projectParameterBindingReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false);
 const operation={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input};
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.applied}).principal_target_tokens,['id:41','parameterid:41']);
 assert.deepEqual(operationTargetSelectorV2({operation,value:{owners:[{id:1001}],categoryId:-2008013}}).principal_target_tokens,[]);
 assert.equal(verificationCapabilityAdmissionV2({apply:operation,verification:{...operation,arguments:{body:{action:'detail',parameterId:41}}}}).admissible,true);
 for(const body of [{action:'list'},{action:'detail',parameterId:41,instanceBinding:true},{action:'detail',parameterId:'41'}])
  assert.equal(verificationCapabilityAdmissionV2({apply:operation,verification:{...operation,arguments:{body}}}).admissible,false);
});
test('request modes keep type binding, rebinding, preview and engineering quantities distinct',()=>{
 const f=fixture();assert.equal(projectParameterBindingRequestV2({...f.input.body,instanceBinding:false})?.isInstance,false);
 for(const extra of [{dryRun:true},{dryRun:null},{rebindIfExists:true},{categoryNames:[]},{instanceBinding:null},{dataType:'airflow'},{name:' '},{parameterId:41}])
  assert.equal(projectParameterBindingRequestV2({...f.input.body,...extra}),null,JSON.stringify(extra));
 assert.equal(projectParameterBindingReadIdV2({action:'detail',parameterId:41}),41);
 for(const extra of [{parameterId:0},{parameterId:'41'},{instanceBinding:true},{dryRun:false}])
  assert.equal(projectParameterBindingReadIdV2({action:'detail',parameterId:41,...extra}),null);
});
test('an existing unbound shared identity preserves its prior owner data rather than fabricating a new element',()=>{
 const f=fixture();f.applied.existingParameterElementIdBefore=41;f.applied.transaction.added_element_ids=[];f.applied.transaction.modified_element_ids.push(41);
 f.applied.ownerValuesBefore=structuredClone(f.read.owners);
 f.applied.ownerValuesBefore[0].hasValue=true;f.applied.ownerValuesBefore[0].value='Existing note';
 f.applied.bindingReadback.owners[0].hasValue=true;f.applied.bindingReadback.owners[0].value='Existing note';
 f.read.owners[0].hasValue=true;f.read.owners[0].value='Existing note';
 assert.equal(projectParameterBindingReadbackMatchesV2(f.input,f.applied,f.read),true);
 f.read.owners[0].value='Other';assert.equal(projectParameterBindingReadbackMatchesV2(f.input,f.applied,f.read),false);
});
test('wrong type, GUID, member coverage, request resolution, values or authoritative inventory never pass',()=>{
 const changes:Array<(f:any)=>void>=[
  f=>f.read.parameter.guid='00000000-0000-0000-0000-000000000042',f=>f.read.parameter.isInstance=false,
  f=>f.read.parameter.uniqueId='foreign',f=>f.read.parameter.dataTypeId='other',f=>f.read.complete=false,
  f=>f.read.owners.pop(),f=>f.read.owners.push(f.read.owners[0]),f=>f.read.owners[0].value='invented',
  f=>f.read.owners[0].typeId=999,f=>f.read.owners[0].userModifiable=false,
  f=>f.applied.transaction.pending=true,f=>f.applied.transaction.committed=false,
  f=>f.applied.transaction.added_element_ids.push(99),f=>f.applied.transaction.modified_element_ids.push(99),
  f=>f.applied.transaction.deleted_element_ids.push(99),f=>f.applied.changeTracking.exhaustiveChangeInventory=false,
  f=>f.applied.requestResolution.categoryRequests[0].requested='Mechanical Equipment',
  f=>f.applied.requestResolution.categoryRequests[0].id=-2001140,
  f=>f.applied.requestResolution.dataTypeToken='number',f=>f.applied.requestedDefinition.isInstance=false,
  f=>f.applied.externalDefinitionEffect.selectionRestored=false,f=>f.applied.otherBindingsHashBefore='b'.repeat(64),
  f=>f.applied.ownerValuesBefore[0].uniqueId='foreign',f=>f.applied.ownerValuesBefore[1]=f.applied.ownerValuesBefore[0]
 ];
 for(const change of changes){const f=fixture();change(f);assert.equal(projectParameterBindingReadbackMatchesV2(f.input,f.applied,f.read),false);}
 // Even mutually consistent apply-local and fresh echoes cannot replace preservation against before-state.
 for(const change of [(v:any)=>v.owners[0].value='fiction',(v:any)=>v.parameter.isInstance=false,(v:any)=>v.otherBindingsHash='b'.repeat(64)]){
  const f=fixture();change(f.applied.bindingReadback);change(f.read);
  assert.equal(projectParameterBindingReadbackMatchesV2(f.input,f.applied,f.read),false);
 }
});

for(const variant of ['exact','wrong_instance','partial','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary binding ${variant} uses one guarded read and never replays the committed mutation`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-binding-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=fixture(),goal=createGoal({title:'Add a per-device schedule note',objective:'Add a per-device schedule note.',acceptance_criteria:['An instance text field is available.'],status:'active',
   related_session_id:'binding-session',created_by:'binding-principal',work_budget:{requested_effect:'apply',document_fingerprint:'binding-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'binding-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(args.body.action==='detail'){
    assert.deepEqual(args,{method:'POST',path:'/revit/project-parameters',body:{action:'detail',parameterId:41}});
    if(variant==='read_schema_rejected')throw Error('read_schema_rejected');
   }},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.body.action==='detail';
    if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=structuredClone(read?f.read:f.applied);
    if(read){if(variant==='wrong_instance')payload.parameter.isInstance=false;if(variant==='partial')payload.complete=false;if(variant==='wrong_target')payload.parameter.id++;}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:read?['element_id:41']:['element_id:1001','element_id:1002','element_id:41'],result_schema_id:'operator-native/POST:/revit/project-parameters/v2',observation_required:true,
      raw_payload_hash:read&&variant==='wrong_digest'?'e'.repeat(64):createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:!read&&variant==='unretained_apply'?{status:'Success'}:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'binding-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   await handleCodexDynamicToolCall(runtime,{id:'user-binding-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'binding-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied',JSON.stringify(apply.result));assert.equal(calls.filter(c=>c.body.action==='create').length,1);
   assert.equal(validations.filter(a=>a.body.action==='detail').length,['unretained_apply','paused_after_commit'].includes(variant)?0:1);
   assert.equal(calls.filter(c=>c.body.action==='detail').length,['unretained_apply','read_schema_rejected','paused_after_commit'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact');
   if(variant==='exact'){
    const read=s.operations[apply.verification_operation_ids[0]!]!,result=read.result!;
    assert.equal(projectParameterBindingPostconditionSatisfiedV2(s,apply,result,f.read),true);
    for(const change of [
     (v:any)=>v.unresolved_unknown_operation_ids.push('prior-unknown'),
     (v:any)=>(v.input_invalidated_operation_ids??=[]).push(apply.operation_id),
     (v:any)=>v.operations[read.operation_id].input.body.parameterId++,
     (v:any)=>{const later=structuredClone(apply);later.operation_id='later';later.result.completed_at=new Date(Date.parse(apply.result!.completed_at)+1).toISOString();v.operations.later=later;}
    ]){const changed=structuredClone(s);change(changed);assert.equal(projectParameterBindingPostconditionSatisfiedV2(changed,changed.operations[apply.operation_id]!,result,f.read),false);}
    assert.equal(projectParameterBindingPostconditionSatisfiedV2(s,apply,{...result,binding:{...result.binding,generation:result.binding.generation+1}},f.read),false);
    assert.equal(projectParameterBindingPostconditionSatisfiedV2(s,apply,{...result,completed_at:apply.result!.completed_at},f.read),false);
   }
   if(variant!=='unretained_apply')assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
