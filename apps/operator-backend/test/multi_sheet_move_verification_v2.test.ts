import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {sheetMove79Fixture} from './fixtures/sheet_move_79_fixture.js';
import {viewportProjectionFixture} from './fixtures/viewport_projection_pose_fixture.js';
import {sheetMovePostconditionSatisfiedV2} from '../src/verification/sheet_move_postcondition_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

for(const representation of ['box','projection'] as const)for(const kind of ['single','multi'] as const)for(const variant of ['exact','wrong_z','missing_z','wrong_owner','read_failure','paused_after_first_read'] as const)
test(`ordinary ${representation} ${kind}-sheet move ${variant}: separate guarded reads close only complete native batch`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sheet-multi-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=representation==='box'?sheetMove79Fixture(kind,true):viewportProjectionFixture(kind),calls:any[]=[],earlyCredit:boolean[]=[];
  const goal=createGoal({title:'Align the sheet groups',objective:'Align the sheet groups.',acceptance_criteria:['The requested move is verified.'],status:'active',related_session_id:'sheet-session',created_by:'sheet-principal',work_budget:{requested_effect:'apply',document_fingerprint:'sheet-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'sheet-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const hasPass=(s:any,op:any)=>op.verification_operation_ids.some((id:string)=>s.operations[id].observation_ids.some((oid:string)=>s.observations[oid].facts.some((f:any)=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},async callTool(_tool:string,args:any,context:any){
   calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.path==='/revit/sheets';
   const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
   const subject=Object.values(snapshot.operations).find(o=>o.persistent_effect==='applied');
   if(read&&subject)earlyCredit.push(hasPass(snapshot,subject));
   const index=read?f.actual_sheets.findIndex((s:any)=>s.sheetId===args.body.sheetId):-1;
   const ownerIndex=read?[...new Set(f.native_apply.snapshots.map((s:any)=>s.before.ownerViewId))].indexOf(args.body.sheetId):-1;
   if(read&&variant==='read_failure'&&ownerIndex===f.actual_sheets.length-1)throw Error('exact owner read failed');
   const p=structuredClone(read?f.actual_sheets[index]:f.native_apply);
   if(read&&index===f.actual_sheets.length-1){
    if(variant==='wrong_z'){if(representation==='box')p.viewportGeometry[0].center.z+=.01;else p.viewportGeometry[0].placementAnchor.pointXyz[2]+=.01;}
    if(variant==='missing_z'){if(representation==='box')delete p.viewportGeometry[0].center.z;else p.viewportGeometry[0].placementAnchor.pointXyz.pop();}
    if(variant==='wrong_owner'){p.sheetId++;p.sheetElementId++;}
   }
   if(read&&ownerIndex===0&&variant==='paused_after_first_read')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
   const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
   return {content:[{type:'text',text:JSON.stringify(p)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
    schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',affected_target_identities:f.input.body.ids.map((id:number)=>'element_id:'+id),result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(p)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
    observation:{raw_payload:p,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'sheet-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-sheet-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'sheet-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(response.success,true);assert.equal(apply.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/move-elements').length,1,'never retry the mutation to obtain verification');
   assert(earlyCredit.every(x=>!x),'partial owner reads never pass the batch');
   const expectedReadCount=variant==='paused_after_first_read'?1:f.actual_sheets.length;
   assert.equal(calls.filter(c=>c.path==='/revit/sheets').length,expectedReadCount);
   const shouldPass=variant==='exact'||(kind==='single'&&variant==='paused_after_first_read');
   assert.equal(hasPass(s,apply),shouldPass);
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!shouldPass);
   assert.deepEqual(s.unresolved_unknown_operation_ids,[]);
   if(variant==='exact'){
    const last=apply.verification_operation_ids.map(id=>s.operations[id]!).filter(o=>o.result).sort((a,b)=>Date.parse(a.result!.completed_at)-Date.parse(b.result!.completed_at)).at(-1)!;
    const actual=f.actual_sheets.find((p:any)=>p.sheetId===(last.input.body as any).sheetId);
    assert(sheetMovePostconditionSatisfiedV2(s,apply,last.result!,actual));
    for(const mutate of [(n:any)=>n.unresolved_unknown_operation_ids=['old-unknown'],(n:any)=>n.operations.later={...apply,operation_id:'later',result:{...apply.result,completed_at:'2999-01-01T00:00:00Z'}}]){
     const n=structuredClone(s);mutate(n);assert.equal(sheetMovePostconditionSatisfiedV2(n,n.operations[apply.operation_id],last.result!,actual),false);
    }
    if(kind==='multi'){
     for(const mutate of [
      (n:any,p:any)=>n.observations[p.observation_ids[0]].binding.generation++,
      (n:any,p:any)=>n.observations[p.observation_ids[0]].raw_payload_hash='f'.repeat(64),
      (_n:any,p:any)=>p.result.completed_at='2000-01-01T00:00:00Z',
      (_n:any,p:any)=>p.result.request_identity={...p.result.request_identity,request_signature:'foreign-signature'},
      (_n:any,p:any)=>p.verification_of_operation_id='foreign-apply'
     ]){
      const n=structuredClone(s),priorId=apply.verification_operation_ids.find(id=>id!==last.operation_id)!;
      const prior=n.operations[priorId];mutate(n,prior);
      assert.equal(sheetMovePostconditionSatisfiedV2(n,n.operations[apply.operation_id],last.result!,actual),false,'foreign/stale/altered retained read cannot fill the missing owner');
     }
    }
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
