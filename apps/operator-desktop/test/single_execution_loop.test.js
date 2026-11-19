import assert from 'node:assert/strict';import test from 'node:test';
import {pathToFileURL} from 'node:url';import path from 'node:path';
process.env.OPERATOR_DESKTOP_NO_LISTEN='1';
process.env.OPERATOR_TOKEN||='single-executor-synthetic-token';
const desktop=await import(new URL('../server.js',import.meta.url).href);
const prompt='Inspect the current sheet and retain the native observations.';
const catalog={schema:'operator.desktop-native-tools.v1',guidance:'You are the sole execution agent.',
 tools:[{type:'function',name:'native__revit_ping',description:'Read',parameters:{type:'object'},strict:false}]};

for(const executionMode of [undefined,'single_actor_review_v1'])test('ordinary desktop loop dispatches native work and mode-specific review '+(executionMode??'legacy'),async()=>{
 const routes=[];let providers=0,delegates=0;
 const assignment=await desktop.beginSidecarComputerAssignment(prompt,[],{
  ensureComputerBackendSession:async()=>'session',readBackendJson:async(route,opts)=>{
   assert.equal(route,'/api/agent-goal');const body=JSON.parse(opts.body);
   return {goal:{id:'assignment',work_budget:{requested_effect:'read'}},assignment_run:{assignment_id:'assignment',run_id:body.assignment_run_id,generation:1,kernel_version:2}};
  }});
 const result=await desktop.executeComputerLoopForTest(prompt,{
  readBackendComputerConfig:async()=>({available:true,model:'gpt-6.1-terra',reasoning_effort:'medium',desktop_native_tools:true}),
  buildHybridBackendContext:async()=>({revit:{schema:'revit-operator.context.v1',observed_at_utc:new Date().toISOString(),source:{live:true},process_id:123,version:'2024',courier_executor_id:'current',document:{title:'Current model',path:'C:/workspace/current.rvt',projectIdentity:{fingerprint:'current-project'},activeView:{id:45,name:'M103',type:'DrawingSheet'},selection:[]}}}),captureScreenshot:async()=>'AAAA',
  tryFastConfirmedScheduleOpen:async()=>null,tryFastEnlargedPlanPlacementFromPrompt:async()=>null,tryFastSheetNameUpdate:async()=>null,
  tryFastSheetParameterUpdateFromPrompt:async()=>null,tryFastPanelParameterUpdateFromPrompt:async()=>null,
  retainAndProjectFunctionOutput:async(_call,output)=>({model_output:output.native_model_output,evidence_ref:null}),
  executeFunctionToolCallSafely:async()=>{delegates++;throw Error('No helper/other executor should run');},
  readBackendJson:async(route,opts)=>{
   routes.push(route);const body=JSON.parse(opts.body);assert.equal(body.assignment_id,assignment.goal_id);
   if(route.endsWith('/catalog'))return {...catalog,execution_mode:executionMode};
   if(route==='/desktop/computer/result'){
    assert.equal(body.message_id,'actual-message');
    assert.equal(body.continuation_outputs.length,1,'retain executed output only, not the unexecuted later call');
    assert.equal(body.continuation_outputs[0].call_id,'native-call');
    return {status:'retained'};
   }
   assert.equal(route,'/api/assignments/v2/desktop-native/call');assert.equal(body.message_id,'actual-message');
   assert.equal(body.response_id,'actual-response');assert.equal(body.call_id,'native-call');
   return {schema:'operator.desktop-native-result.v1',result:{success:true,contentItems:[{type:'inputText',text:'Retained native observation.'}]},stop_reason:'canonical-stop'};
  },
  requestComputerResponse:async(body)=>{
   providers++;assert(!body.tools.some(t=>t.name==='delegate_revit_task'));assert(body.tools.some(t=>t.name==='native__revit_ping'));
   assert(body.tools.some(t=>t.name==='review_current_work'));assert.match(body.instructions,/sole execution agent/);
   assert.doesNotMatch(body.instructions,/delegate_revit_task|queue_revit_batch_job|inspect_revit_context|helper performs|helper findings|scoped handoff/);
   if(executionMode==='single_actor_review_v1'){
    assert.doesNotMatch(body.instructions,/final native inspection checklist item pending|For the final review, pass complete_inspection_item_id/);
    assert.match(body.instructions,/work-plan item IDs are not native inspection IDs/);
    assert.equal(body.tools.find(t=>t.name==='review_current_work').parameters.properties.complete_inspection_item_id,undefined);
   }else assert.match(body.instructions,/final native inspection checklist item pending/);
   assert.match(body.instructions,/drafted.*backchecked/);
   assert.match(body.instructions,/when a visible question affects the next edit or at final review/);
   assert.doesNotMatch(body.instructions,/use review_current_work after a useful bounded change/);
   assert.match(body.instructions,/unfinished parent.*open/);
   assert.match(body.tools.find(t=>t.name==='review_current_work').description,/fresh scoped review.*prior.*open/);
   const initialContext=body.input.flatMap(m=>m.content??[]).find(c=>c.type==='input_text'&&c.text?.includes('operator.execution-orientation.v1'));
   assert(initialContext,'already-observed native orientation is delivered without another model tool turn');
   const packet=JSON.parse(initialContext.text);assert.equal(packet.document.title,'Current model');assert.equal(packet.active_view.id,45);assert.equal(packet.verification_authority,false);
   return {id:'actual-response',desktop_message_id:'actual-message',output_text:'',output:[
    {type:'function_call',name:'native__revit_ping',call_id:'native-call',arguments:'{}'},
    {type:'function_call',name:'native__revit_ping',call_id:'must-not-dispatch-after-stop',arguments:'{}'}]};
  }
 });
 assert.equal(providers,1);assert.equal(delegates,0);assert.deepEqual(routes,['/api/assignments/v2/desktop-native/catalog','/api/assignments/v2/desktop-native/call','/desktop/computer/result']);
 assert.match(result,/Checking the canonical task result/);assert.doesNotMatch(result,/complete|success/i);
});

test('one owner response executes independent native calls serially and stops the remaining batch on canonical control',async()=>{
 let providers=0,active=0;const dispatched=[];
 await desktop.beginSidecarComputerAssignment(prompt,[],{
  ensureComputerBackendSession:async()=>'batch-session',readBackendJson:async(_route,opts)=>{
   const body=JSON.parse(opts.body);return {goal:{id:'batch-assignment',work_budget:{requested_effect:'read'}},
    assignment_run:{assignment_id:'batch-assignment',run_id:body.assignment_run_id,generation:1,kernel_version:2}};
  }});
 const result=await desktop.executeComputerLoopForTest(prompt,{
  readBackendComputerConfig:async()=>({available:true,model:'gpt-6.1-terra',reasoning_effort:'medium',desktop_native_tools:true}),
  buildHybridBackendContext:async()=>({revit:{courier_executor_id:'current'}}),captureScreenshot:async()=>'AAAA',
  tryFastConfirmedScheduleOpen:async()=>null,tryFastEnlargedPlanPlacementFromPrompt:async()=>null,tryFastSheetNameUpdate:async()=>null,
  tryFastSheetParameterUpdateFromPrompt:async()=>null,tryFastPanelParameterUpdateFromPrompt:async()=>null,
  retainAndProjectFunctionOutput:async(_call,output)=>({model_output:output.native_model_output,evidence_ref:null}),
  executeFunctionToolCallSafely:async()=>{throw Error('No second executor');},
  readBackendJson:async(route,opts)=>{
   if(route.endsWith('/catalog'))return catalog;
   if(route==='/desktop/computer/result'){
    const checkpoint=JSON.parse(opts.body);assert.equal(checkpoint.continuation_outputs.length,2);
    assert.deepEqual(checkpoint.continuation_outputs.map(v=>v.call_id),['first','second']);return {status:'retained'};
   }
   assert.equal(route,'/api/assignments/v2/desktop-native/call');assert.equal(active,0,'native calls never overlap');active++;
   const body=JSON.parse(opts.body);dispatched.push(body.call_id);assert.equal(body.response_id,'batch-response');
   await new Promise(resolve=>setTimeout(resolve,1));active--;
   return {schema:'operator.desktop-native-result.v1',result:{success:true,contentItems:[{type:'inputText',text:'Retained observation.'}]},
    stop_reason:body.call_id==='second'?'canonical-stop':null};
  },
  requestComputerResponse:async()=>{
   providers++;assert.equal(providers,1,'no handoff or bookkeeping provider round');
   return {id:'batch-response',desktop_message_id:'batch-message',output_text:'',output:['first','second','must-not-run'].map(call_id=>
    ({type:'function_call',name:'native__revit_ping',call_id,arguments:'{}'}))};
  }
 });
 assert.deepEqual(dispatched,['first','second']);assert.equal(providers,1);assert.equal(active,0);
 assert.match(result,/Checking the canonical task result/);
});
