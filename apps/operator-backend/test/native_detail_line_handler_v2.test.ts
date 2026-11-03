import fs from'node:fs';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';import test from'node:test';import assert from'node:assert/strict';
import{detailLineGraphFixture}from'./native_detail_line_graph.fixtures.js';
import{createGoal,__testOnlyResetGoalListCache}from'../src/goals/service.js';
import{createAssignmentKernelForGoalV2}from'../src/assignments/assignment_kernel_v2_factory.js';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{beginTeammateLoopOwner,endTeammateLoopOwner}from'../src/teammate_loop_runtime.js';
import{handleCodexDynamicToolCall}from'../src/brains/codex_dynamic_tool_handler.js';
import{runWithRequestContext}from'../src/request_context.js';import{createOperatorBackendAuth}from'../src/operator_backend_auth.js';
import{canonicalJsonV2}from'../src/domain/assignment-kernel/index.js';import{checkedEditIsCurrentV2}from'../src/verification/current_postcondition_v2.js';
import{controlAssignmentExecutionV2}from'../src/assignments/assignment_kernel_v2_controls.js';
import{committedNativeDetailLineReadbackPlanV2,committedNativeDetailLineRefreshPlanV2,nativeDetailLinePostconditionSatisfiedV2}from'../src/verification/native_detail_line_graph_v2.js';
for(const variant of ['exact','later_batch','later_batch_wrong_old','later_batch_pause','wrong_geometry','foreign_owner','truncated','read_failure','schema_refused','pause','foreign_receipt','mixed_mutation']as const)
test(`ordinary detail-line graph ${variant} checks once without replay`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-detail-lines-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=detailLineGraphFixture(),goal=createGoal({title:'Draft two lines',objective:'Copy two straight strokes into the working detail.',acceptance_criteria:['The requested lines are present.'],status:'active',related_session_id:'line-session',created_by:'test-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  if(variant==='mixed_mutation')f.input.body.operations.push({id:'unrelated',op:'call',target:'$owner',memberId:'method:Unrelated.Mutate()',args:[]});
  const second=detailLineGraphFixture();for(const step of second.input.body.operations.filter(s=>['a','b'].includes(s.id)))for(const p of step.args)p.y+=4;
  for(const id of ['lineA','lineB']){const r=second.applied.results[id];r.id+=2;r.unique_id='fixture-line-'+r.id;Object.assign(second.applied.operations.find((s:any)=>s.id===id).result_preview,r);}
  second.applied.transaction.added_element_ids=[103,104];for(const n of second.fresh.views[0].items){n.elementId+=2;n.uniqueId='fixture-line-'+n.elementId;n.curve.start.y+=4;n.curve.end.y+=4;}
  createAssignmentKernelForGoalV2({goal,run_id:'line-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];let batches=0;
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_t:string,args:any){if(args.path==='/revit/view-owned-detailing'&&variant==='schema_refused')throw Error('read_schema_refused');},async callTool(_t:string,args:any,ctx:any){
   calls.push(args);ctx.onMcpAccepted();const reading=args.path==='/revit/view-owned-detailing',lease=ctx.assignmentKernelV2;
   if(reading&&variant==='read_failure')throw Error('native_read_failed');
   const payload=structuredClone(reading?f.fresh:batches++?second.applied:f.applied);
   if(reading&&batches===2){payload.views[0].items.push(...structuredClone(second.fresh.views[0].items));payload.views[0].totalOwnedCount=4;payload.views[0].returnedCount=4;}
   if(reading&&batches===2&&variant==='later_batch_wrong_old')payload.views[0].items[0].curve.end.y=20;
   if(reading&&variant==='wrong_geometry')payload.views[0].items[1].curve.end.y=20;
   if(reading&&variant==='foreign_owner')payload.views[0].items[0].ownerViewId=99;
   if(reading&&variant==='truncated')payload.views[0].truncated=true;
   if(!reading&&(variant==='pause'||variant==='later_batch_pause'&&batches===2))controlAssignmentExecutionV2({binding,command_id:'pause-after-lines',expected_command_id:null,action:'pause'});
   return{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:!reading&&variant==='foreign_receipt'?'model':'native-host',affected_target_identities:reading?['element_id:41']:payload.transaction.added_element_ids.map((id:number)=>'element_id:'+id),result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.domain_succeeded',fact_class:'control',value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'line-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  try{await handleCodexDynamicToolCall(runtime,{id:'create-lines',method:'item/tool/call',params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:'line-turn',arguments:f.input}}as any);
   if(variant.startsWith('later_batch'))await handleCodexDynamicToolCall(runtime,{id:'second-distinct-lines',method:'item/tool/call',params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:'line-turn',arguments:second.input}}as any);
   const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,applies=Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply'),applied=applies[0]!;
   assert.equal(calls.filter(c=>c.path===f.input.path).length,variant.startsWith('later_batch')?2:1,'Never replay a mutation');
   assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['schema_refused','pause','foreign_receipt','mixed_mutation'].includes(variant)?0:variant==='later_batch_pause'?1:variant.startsWith('later_batch')?3:1,'A separate exact-owner native read is required; later work refreshes earlier lines');
   assert.equal(checkedEditIsCurrentV2(snapshot,applied.operation_id),variant==='exact'||variant==='later_batch','Only a complete authentic matching native read earns proof');
   if(variant==='later_batch_wrong_old')assert(checkedEditIsCurrentV2(snapshot,applies[1]!.operation_id),'New batch stays checked; mismatch of old geometry remains open');
   if(variant==='later_batch_pause')assert.equal(checkedEditIsCurrentV2(snapshot,applies[1]!.operation_id),false,'Pause retains committed work without post-pause dispatch');
   if(variant==='later_batch'){
    assert(applies.every(o=>checkedEditIsCurrentV2(snapshot,o.operation_id)),'Later distinct additions require current exact prior line geometry proof');
    const old=structuredClone(snapshot),first=old.operations[applied.operation_id]!;first.verification_operation_ids=[...first.verification_operation_ids].sort((a,b)=>old.operations[a]!.admitted_assignment_version!-old.operations[b]!.admitted_assignment_version!).slice(0,1);
    assert.equal(checkedEditIsCurrentV2(old,first.operation_id),false,'Retained earlier check is stale before a new native read');
    assert.deepEqual(committedNativeDetailLineRefreshPlanV2(old,first),f.readInput);
    const latest=first.verification_operation_ids[0]!;
    const faults:Record<string,(s:any,o:any)=>void>={paused:s=>s.execution_control={state:'paused'},unknown:s=>s.unresolved_unknown_operation_ids=['old'],inflight:s=>s.in_flight_operation_ids=['pending'],failed:s=>s.operations[latest].result.status='failed',foreign:s=>s.operations[latest].result.authority='model',missing:s=>s.operations[latest].observation_ids=[],digest:s=>s.operations[latest].result.raw_payload_hash='0'.repeat(64),selector:s=>s.operations[latest].input.body.viewId=99};
    for(const[name,fault]of Object.entries(faults)){const altered=structuredClone(old),a=altered.operations[first.operation_id]!;fault(altered,a);assert.equal(committedNativeDetailLineRefreshPlanV2(altered,a),null,name);}
   }
   if(variant==='exact'){
    const before=canonicalJsonV2(snapshot),hypothetical=structuredClone(snapshot),op=hypothetical.operations[applied.operation_id]!;op.verification_operation_ids=[];
    assert.deepEqual(committedNativeDetailLineReadbackPlanV2(hypothetical,op),f.readInput);
    const faults:Record<string,(s:any,o:any)=>void>={paused:s=>s.execution_control={state:'paused'},terminal:s=>s.terminal=true,unknown:s=>s.unresolved_unknown_operation_ids=['old'],inflight:s=>s.in_flight_operation_ids=['pending'],invalidated:(s,o)=>s.input_invalidated_operation_ids=[o.operation_id],foreign:(_s,o)=>o.binding.generation++,unretained:(_s,o)=>o.observation_ids=[],changedDigest:(_s,o)=>o.result.raw_payload_hash='0'.repeat(64),wrongReceipt:(_s,o)=>o.result.request_identity.request_signature='foreign',uncommitted:(_s,o)=>o.result.native_transaction_state='pending',nonnative:(_s,o)=>o.result.authority='model'};
    for(const[name,mutate]of Object.entries(faults)){const altered=structuredClone(hypothetical),a=altered.operations[op.operation_id]!;mutate(altered,a);assert.equal(committedNativeDetailLineReadbackPlanV2(altered,a),null,name);}
    const read=snapshot.operations[applied.verification_operation_ids[0]!]!;
    assert(nativeDetailLinePostconditionSatisfiedV2(snapshot,applied,read.result!,f.fresh));
    for(const[name,mutate]of Object.entries({stale:(s:any,r:any):void=>{s.operations[r.operation_id].opened_at='2020-01-01T00:00:00Z';},foreign:(_s:any,r:any):void=>{r.binding.generation++;},badDigest:(_s:any,r:any):void=>{r.raw_payload_hash='0'.repeat(64);},failed:(_s:any,r:any):void=>{r.status='failed';},wrongSignature:(_s:any,r:any):void=>{r.request_identity.request_signature='other';}})){
     const altered=structuredClone(snapshot),a=altered.operations[applied.operation_id]!,r=altered.operations[read.operation_id]!.result!;mutate(altered,r);assert.equal(nativeDetailLinePostconditionSatisfiedV2(altered,a,r,f.fresh),false,name);
    }
    assert.equal(canonicalJsonV2(snapshot),before,'Fault planning never changes canonical history');
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
});
