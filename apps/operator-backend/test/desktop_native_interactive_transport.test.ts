import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {executeDesktopNativeCall,desktopNativeInteractionState,desktopNativeInteractionTools,retainNativeInteractiveProviderResponse,desktopNativeInteractiveResponseAllowed,DESKTOP_NATIVE_AWAIT_TOOL,withDesktopNativeProviderReadiness} from '../src/assignments/desktop_native_tools.js';
import {example} from './native_accessory_preservation.fixtures.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA} from '../src/assignments/assignment_kernel_v2_execution.js';
import {OPERATION_RESULT_V2_SCHEMA,appliedOperationHasVerifiedPostconditionV2} from '../src/domain/assignment-kernel/index.js';
import {retainDesktopResponse,readDesktopResponse} from '../src/desktop_response_store.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2,appendCurrentAssignmentKernelEventV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {executeExternalProviderCallV2} from '../src/assignments/external_provider_lifecycle.js';
import {createOpenAiModelCallReceipt} from '../src/model_call_telemetry.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {CodexMcpToolRuntime} from '../src/codex/mcp_tool_runtime.js';
import {workspaceMcpRuntimes} from '../src/codex/workspace_mcp_runtime.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {routeConversation} from '../src/conversation_intake.js';

for(const scenario of ['failure','pause','readback','readback_pause'] as const)test(`one retained desktop invocation stays canonical in flight and consumes its original result (${scenario})`,async()=>{
 const pause=scenario==='pause',readback=scenario.startsWith('readback'),f=example('pipe');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-native-interactive-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',
  OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0',OPERATOR_REVIT_TRANSPORT:'direct'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 let release!:(value:any)=>void;
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const objective='Insert one loaded balancing damper on the marked duct and inspect the result.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'session',message_id:'source',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,
    confidence:0.99,reason:'Requested accessory insertion.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',
    operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});
  assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:'Insert damper',objective,acceptance_criteria:['Insert and inspect the requested damper.'],status:'active',related_session_id:'session',created_by:'local-host',
   work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:'source',source_user_request:objective,
    mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'run'});
  const snapshot=()=>getAssignmentKernelSnapshotV2(goal.id)!;
  appendCurrentAssignmentKernelEventV2({goal_id:goal.id,binding:snapshot().current_binding,event_id:'fixture-plan',actor:'operator-work-plan',
   occurred_at:new Date().toISOString(),body:{event_type:'work_plan_declared',declaration:{items:[{item_id:'damper',description:objective,source_basis:objective}],assumptions:[]}}});
  const runtime=new CodexMcpToolRuntime({backendCwd:process.cwd(),workspaceRoot:root,codexHome:path.join(root,'.codex'),spawnEnv:{}});
  let nativeCalls=0,placementLease:any,readLease:any,releaseRead!:(value:any)=>void,startedRead!:()=>void;
  const readStarted=new Promise<void>(resolve=>startedRead=resolve),readResult=new Promise<any>(resolve=>releaseRead=resolve);
  const native=new Promise<any>(resolve=>{release=resolve;});
  runtime.getDynamicToolNamespace=async()=>({tools:[{name:'revit_call_tool',description:'Native dispatch',inputSchema:{type:'object'}}]});
  runtime.validateToolArguments=async()=>{}; // This fixture replaces transport only; real request contract has separate native tests.
  runtime.callTool=async(_name,args:any,options:any)=>{nativeCalls++;options?.onMcpAccepted?.();
   if(readback&&args.path==='/revit/get-connectors'){readLease=options.assignmentKernelV2;startedRead();return readResult;}
   placementLease=options.assignmentKernelV2;return native;};
  workspaceMcpRuntimes.set(root,runtime);
  async function provider(message:string,output:any[],interactive=false){
   const responseId='response-'+message;
   const receipt=createOpenAiModelCallReceipt({route:'desktop_computer',requested_model:'fixture-model',reasoning_effort:'medium',started_at_utc:new Date().toISOString(),duration_ms:1,
    response:{id:responseId,status:'completed',model:'fixture-model',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
   const response={id:responseId,status:'completed',model_call_receipt:receipt,output,
    provider_response_usage:{disposition:'completed',message_id:message,session_id:'session',raw_response_ids:[responseId]}};
   await retainDesktopResponse({...binding,kernelVersion:2},message,{},()=>withDesktopNativeProviderReadiness(binding,()=>executeExternalProviderCallV2({binding,model:'fixture-model',reasoning_effort:'medium',
    ...(interactive?{nativeInteractiveInput:true as const}:{}),invoke:async()=>response,receipt:r=>r.model_call_receipt,errorReceipt:()=>null})),()=>null);
   if(interactive)retainNativeInteractiveProviderResponse(binding,response);
   return {message_id:message,response_id:responseId,call_id:'call-'+message};
  }
  const request=readback?f.input:{method:'POST',path:'/revit/place-mep-accessory-interactively',body:{expectedModelPath:'C:\\fixture\\model.rvt',viewId:12,
   expectedViewUniqueId:'view-uid',accessoryTypeId:20,expectedAccessoryTypeUniqueId:'type-uid',maximumPlacements:1,targetHosts:[{elementId:31,uniqueId:'host-uid'}]}};
  const first=await provider('start',[{type:'function_call',call_id:'call-start',name:'native__revit_call_tool',arguments:JSON.stringify(request)}]);
  let timer:ReturnType<typeof setTimeout>;
  const result:any=await Promise.race([executeDesktopNativeCall(binding,first),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('pending input was not returned: '+JSON.stringify({operations:snapshot().operations,control:snapshot().execution_control,outcome:snapshot().outcome,quiescent:snapshot().quiescent,providers:snapshot().in_flight_provider_call_ids}))),3000);})]).finally(()=>clearTimeout(timer));
  assert.equal(result.schema,'operator.desktop-native-pending.v1',JSON.stringify(result));
  assert.equal(result.input_readiness,'unconfirmed','dispatch ownership must not assert native UI readiness');
  assert.match(result.message,/still preparing/);
  assert.match(result.message,/requested accessory type/);
  assert.match(result.message,/Do not press Escape to clear/);
  assert.match(DESKTOP_NATIVE_AWAIT_TOOL.description,/already ended.*without.*Escape/);
  assert.equal(result.success,undefined);assert.equal(result.persistent_effect,undefined);
  assert.equal(nativeCalls,1);assert.equal(snapshot().quiescent,false);
  assert.deepEqual(snapshot().in_flight_operation_ids,[result.operation_id]);
  assert.equal(snapshot().operations[result.operation_id].settlement_state,'awaiting_result');
  assert.equal(desktopNativeInteractionState(binding).input_operation_id,result.operation_id);
  assert.deepEqual(desktopNativeInteractionTools(binding,[{type:'computer'},{type:'function',name:'native__save_as'}])?.map((t:any)=>t.name??t.type),
   ['computer','native__await_interactive_placement']);
  await assert.rejects(executeDesktopNativeCall(binding,first),/result_must_be_consumed/);assert.equal(nativeCalls,1);
  await assert.rejects(executeExternalProviderCallV2({binding,model:'fixture-model',reasoning_effort:'medium',invoke:async()=>({}),receipt:()=>{throw Error('denied call must not run');},errorReceipt:()=>null}),/admission/);
  const next=await provider('input',[{type:'function_call',call_id:'call-input',name:'native__await_interactive_placement',arguments:'{}'}],true);
  assert.equal(snapshot().provider_call_ids.length,2,'same owner receives an accounted input turn; no helper');
  assert.equal(snapshot().quiescent,false);assert.equal(snapshot().operations[result.operation_id].settlement_state,'awaiting_result');
  const record=readDesktopResponse({...binding,kernelVersion:2},next.message_id)!;
  assert.equal(desktopNativeInteractiveResponseAllowed(binding,record),true,'same accounted response can recover without redispatch');
  for(const change of [(r:any)=>r.response.output[0].arguments='{"injected":true}',(r:any)=>r.message_id='other',
    (r:any)=>r.binding.generation++,(r:any)=>r.status='pending',(r:any)=>r.response.id='foreign']) {
    const other=structuredClone(record);change(other);assert.equal(desktopNativeInteractiveResponseAllowed(binding,other),false);
  }
  assert.equal(desktopNativeInteractiveResponseAllowed(binding,readDesktopResponse({...binding,kernelVersion:2},'start')),false,'old pre-placement response is not an input continuation');
  if(readback){
   const envelope=(lease:any,payload:any,effect:'none'|'applied')=>({content:[{type:'text',text:'Retained native fixture'}],structuredContent:{
    schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,operation_result_v2:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:'result-'+lease.operation_id,
     operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:effect,
     native_transaction_state:effect==='applied'?'committed':'not_applicable',authority:'native-host',result_schema_id:'operator-native/POST:'+lease.request_identity.path+'/v2',
     observation_required:true,raw_payload_hash:payloadDigestV2(payload).digest,receipt_id:'receipt-'+lease.operation_id,native_correlation_id:'native-'+lease.operation_id,
     request_identity:snapshot().operations[lease.operation_id]!.request_identity,completed_at:new Date().toISOString(),...(effect==='applied'?{affected_target_identities:f.affected}:{})},
    observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.result_available',fact_class:'control',value:true}],verification_relevance:['task_result']}}});
   release(envelope(placementLease,f.apply,'applied'));
   let watchdog:ReturnType<typeof setTimeout>;await Promise.race([readStarted,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('automatic read not started: '+JSON.stringify(snapshot().operations))),4000);})]).finally(()=>clearTimeout(watchdog));
   assert.equal(snapshot().operations[result.operation_id].settlement_state,'settled');
   assert.deepEqual(snapshot().in_flight_operation_ids,[readLease.operation_id]);assert.equal(desktopNativeInteractionState(binding).input_operation_id,null);
   // Exact194 phase: placement settled, original invocation's read still in flight.
   // The strict provider boundary continues to reject a direct premature call.
   await assert.rejects(executeExternalProviderCallV2({binding,model:'fixture-model',reasoning_effort:'medium',nativeInteractiveInput:true,
    invoke:async()=>({}),receipt:()=>{throw Error('must not dispatch');},errorReceipt:()=>null}),/await_operation/);
   let arrived=false;const continuation=provider('after-read',[{type:'function_call',call_id:'call-after-read',name:'native__await_interactive_placement',arguments:'{}'}],true).then(v=>{arrived=true;return v;});
   await new Promise(resolve=>setTimeout(resolve,15));assert.equal(arrived,false);assert.equal(snapshot().provider_call_ids.length,2);
   if(scenario==='readback_pause'){
    controlAssignmentExecutionV2({binding,command_id:'pause-readback',expected_command_id:null,action:'pause'});
    releaseRead(envelope(readLease,f.after,'none'));await assert.rejects(continuation,/admission/);
    assert.equal(snapshot().provider_call_ids.length,2);assert.equal(nativeCalls,2);assert.equal(snapshot().execution_control?.state,'paused');
    assert.equal(desktopNativeInteractionState(binding).pending_result,true);
    await executeDesktopNativeCall(binding,next);assert.equal(nativeCalls,2);return;
   }
   releaseRead(envelope(readLease,f.after,'none'));const completed=await continuation;
   assert.equal(snapshot().provider_call_ids.length,3);assert.equal(nativeCalls,2);
   assert.equal(appliedOperationHasVerifiedPostconditionV2(snapshot(),result.operation_id),true);
   assert.equal(desktopNativeInteractionState(binding).pending_result,true,'waiting does not consume original result');
   const consumed:any=await executeDesktopNativeCall(binding,completed);assert.equal(consumed.schema,'operator.desktop-native-result.v1');
   assert.equal(desktopNativeInteractionState(binding).pending_result,false);assert.equal(nativeCalls,2);assert.notEqual(snapshot().outcome,'complete');
   return;
  }
  if(pause){
    controlAssignmentExecutionV2({binding,command_id:'pause-native',expected_command_id:null,action:'pause'});
    assert.equal(desktopNativeInteractionState(binding).input_operation_id,null);
    assert.equal(desktopNativeInteractiveResponseAllowed(binding,record),false);
    assert.deepEqual(desktopNativeInteractionTools(binding,[{type:'computer'}])?.map((t:any)=>t.name??t.type),['native__await_interactive_placement']);
    await assert.rejects(executeExternalProviderCallV2({binding,model:'fixture-model',reasoning_effort:'medium',nativeInteractiveInput:true,
      invoke:async()=>({}),receipt:()=>{throw Error('paused call must not run');},errorReceipt:()=>null}),/admission/);
  }
  // A deliberately failed transport response exercises real conservative settlement, not fabricated native success.
  release({isError:true,content:[{type:'text',text:JSON.stringify({error:'fixture-native-receipt-unavailable'})}]});
  for(let i=0;i<50&&snapshot().in_flight_operation_ids.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(snapshot().in_flight_operation_ids.length,0);
  assert.equal(desktopNativeInteractionState(binding).pending_result,true);
  assert.equal(desktopNativeInteractionState(binding).input_operation_id,null,'returned native invocation cannot accept more input');
  // The final computer output still needs its tool declaration on the next
  // Responses request. This declaration never grants action-time input rights.
  assert.deepEqual(desktopNativeInteractionTools(binding,[{type:'computer'},{type:'function',name:'native__save_as'}])?.map((t:any)=>t.name??t.type),
   pause?['native__await_interactive_placement']:['computer','native__await_interactive_placement']);
  assert.equal(desktopNativeInteractiveResponseAllowed(binding,record),false);
  const original=executeDesktopNativeCall(binding,next);
  await assert.rejects(executeDesktopNativeCall(binding,next),/owned_interaction_required/);
  const settled:any=await original;assert.equal(settled.schema,'operator.desktop-native-result.v1');
  assert.equal(nativeCalls,1);assert.equal(desktopNativeInteractionState(binding).pending_result,false);
  assert.equal(desktopNativeInteractionState(binding).input_operation_id,null);
  assert.equal(desktopNativeInteractiveResponseAllowed(binding,record),false,'native return closes input recovery');
  assert.equal(snapshot().in_flight_operation_ids.length,0);
  assert.notEqual(snapshot().outcome,'complete','transport completion never certifies insertion');
  await assert.rejects(executeDesktopNativeCall(binding,next),/owned_interaction_required/);
  assert.equal(nativeCalls,1,'no redispatch even for a failed original result');
 });}finally{release?.({isError:true,content:[]});workspaceMcpRuntimes.delete(root);__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__testOnlyResetGoalListCache();}
});
