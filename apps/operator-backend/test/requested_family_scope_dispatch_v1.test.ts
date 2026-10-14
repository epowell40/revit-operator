import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {manageAssignmentWorkPlan} from '../src/assignments/assignment_work_plan.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {projectWorkPlanScopeChecksV1} from '../src/assignments/work_plan_scope_check.js';
const native72=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/family-static-text-scope-72.json'),'utf8'));
const failure73=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/family-static-text-scope-failure-73.json'),'utf8'));
for(const variant of ['exact','reordered_scope','wrong_wording','truncated_inventory','native_refused','schema_refused','paused_after_census','explicit_references','wrong_item','control_refused','type_limit'] as const)
test('normal scope dispatcher '+variant+' owns every read and retains failed73/no-reference attempt before refreshed proof',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-scope-dispatch-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Finish firm text',objective:'Finish the firm text throughout the titleblocks; check them.',acceptance_criteria:['The requested text is correct.'],status:'active',related_session_id:'scope-host-session',created_by:'scope-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'scope-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  manageAssignmentWorkPlan({binding,action:'declare',declaration:{assumptions:[],items:[{item_id:'firm',description:'Firm text throughout titleblocks',source_basis:'User supplied redline',kind:'edit'}]}});
  const calls:any[]=[],validations:any[]=[],stops:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>({...binding,kernel_version:2}),queueAssignmentKernelV2TurnStop(...args:any[]){stops.push(args);},
   async validateToolArguments(tool:string,args:any){validations.push({tool,args});if(tool==='revit_call_tool'){
    assert.equal(args.method,'POST');assert(['/revit/find-elements','/revit/inspect-family-content'].includes(args.path));
    assert(!('contains' in args.body));assert(!('familyNameContains' in args.body));
    if(variant==='schema_refused'&&args.path==='/revit/inspect-family-content')throw Error('scope_native_schema_refused');
   }},async callTool(tool:string,args:any,context:any){
    calls.push({tool,args});
    if(tool==='operator_manage_work_plan'){
     if(variant==='control_refused')return {isError:true,content:[{type:'text',text:'work_plan_control_refused'}]};
     const scope={kind:args.scopeCheck.kind,category:args.scopeCheck.category,expected_text:args.scopeCheck.expected_text};
     const result=manageAssignmentWorkPlan({binding,action:args.action,item_id:args.itemId,scope_check:scope as any,operation_ids:args.operationIds});
     return {content:[{type:'text',text:JSON.stringify(result)}],isError:false};
    }
    const lease=context.assignmentKernelV2;assert(lease);context.onMcpAccepted();
    if(variant==='native_refused')throw Error('scope_native_refused');
    const ref=args.path==='/revit/find-elements'?native72.reads[0]:native72.reads.find((r:any)=>r.payload.source?.elementId===args.body.elementId);assert(ref);
    const payload=structuredClone(ref.payload);
    if(args.path==='/revit/inspect-family-content'){
     payload.otherElements=[];payload.familyParameters=[];payload.inventory.returnedElementCount=payload.staticText.length+payload.labels.length+payload.nestedInstances.length;
     if(variant==='wrong_wording')for(const text of payload.staticText)text.text=text.text.replaceAll('WSP','Other');
    }
    if(args.path==='/revit/find-elements'){
     if(variant==='truncated_inventory')payload.truncated=true;
     if(variant==='type_limit'){
      payload.items=Array.from({length:128},(_,i)=>({...payload.items[0],elementId:2000000+i,typeId:3000000+i,typeName:'Type '+i}));payload.elementIds=payload.items.map((x:any)=>x.elementId);payload.count=128;
     }
     if(variant==='paused_after_census')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    }
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
     schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',authority:'native-host',affected_target_identities:[],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
     raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'scope-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const args:any={action:'check_scope',itemId:variant==='wrong_item'?'absent':'firm',scopeCheck:failure73.request.scope};if(variant==='explicit_references')args.operationIds=['missing-old'];
   if(variant==='reordered_scope')args.scopeCheck={expected_text:args.scopeCheck.expected_text,category:args.scopeCheck.category,kind:args.scopeCheck.kind};
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'scope-request',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'scope-turn',tool:'operator_manage_work_plan',arguments:args}} as any);
   const s=getAssignmentKernelSnapshotV2(goal.id)!,requests=s.work_plan_scope_requests??[],checks=projectWorkPlanScopeChecksV1(s),nativeCalls=calls.filter(c=>c.tool==='revit_call_tool');
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,0,'Host verification never applies or repeats a model write');
   if(variant==='exact'||variant==='reordered_scope'||variant==='wrong_wording'){
    assert.equal(nativeCalls.length,3);assert.equal(requests.length,2);assert.deepEqual(requests[0]!.operation_ids,[],'Original unavailable attempt remains durable');
    assert.equal(requests[1]!.operation_ids.length,3);assert(checks[0]!.available);assert.equal(checks[0]!.declared_scope_satisfied,variant!=='wrong_wording');
    assert.equal(checks[0]!.satisfied_count,variant!=='wrong_wording'?26:0);assert(response.success);
    const before=calls.length;await handleCodexDynamicToolCall(runtime,{id:'scope-already-checked',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'scope-turn',tool:'operator_manage_work_plan',arguments:args}} as any);
    assert.equal(calls.length,before+1,'An available native result, including wrong text, is not silently retried to obtain a pass');
   }else{
    assert(!checks.some(c=>c.available&&c.declared_scope_satisfied));
    assert.equal(nativeCalls.length,['explicit_references','wrong_item','control_refused'].includes(variant)?0:1,'Refusal, truncation and pause stop the bounded native pass');
   }
   if(variant==='paused_after_census')assert.equal(s.execution_control?.state,'paused');
   assert(validations.length>=calls.length);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
