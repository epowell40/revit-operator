import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {desktopNativeResponseCall,assertDesktopNativeState,desktopNativeModelTools,desktopNativeToolContract,desktopNativeToolDescription,desktopNativeCatalog,executeDesktopNativeCall} from '../src/assignments/desktop_native_tools.js';
import {retainDesktopResponse} from '../src/desktop_response_store.js';
import {assertBoundedModelEvidencePayload} from '../src/evidence/model_context_budget.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {executeExternalProviderCallV2} from '../src/assignments/external_provider_lifecycle.js';
import {createOpenAiModelCallReceipt} from '../src/model_call_telemetry.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {CodexMcpToolRuntime} from '../src/codex/mcp_tool_runtime.js';
import {workspaceMcpRuntimes} from '../src/codex/workspace_mcp_runtime.js';
import {registerActiveProviderTurn} from '../src/codex/active_turns.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {routeConversation} from '../src/conversation_intake.js';
import {localDesktopNativeTransportAvailable} from '../src/assignments/desktop_native_transport_policy.js';
import {localExecutorCapability} from '../src/assignments/local_advisory_policy.js';

function retained():any{return {status:'complete',message_id:'message',binding:{session_id:'session'},response:{id:'response',status:'completed',
 model_call_receipt:{call_id:'response',success:true,route:'desktop_computer'},
 provider_response_usage:{disposition:'completed',message_id:'message',session_id:'session',raw_response_ids:['response']},
 output:[{type:'function_call',call_id:'tool-call',name:'native__revit_ping',arguments:'{}'}]}};}
test('native arguments come only from the actual retained owner response, including deferred calls',()=>{
 const record=retained();assert.deepEqual(desktopNativeResponseCall(record,'response','tool-call'),{tool:'revit_ping',arguments:{}});
 record.response.output[0]={...record.response.output[0],name:'native__invoke',arguments:JSON.stringify({tool:'revit_ping',arguments:{value:42}})};
 assert.deepEqual(desktopNativeResponseCall(record,'response','tool-call'),{tool:'revit_ping',arguments:{value:42}});
});
test('missing, foreign, failed, incomplete accounting, duplicate and non-native provider selections refuse',()=>{
 const mutations=[(r:any)=>r.status='pending',(r:any)=>r.status='error',(r:any)=>r.response.id='foreign',(r:any)=>r.response.status='incomplete',
  (r:any)=>r.response.model_call_receipt.success=false,(r:any)=>r.response.model_call_receipt.route='codex_agent',
  (r:any)=>r.response.model_call_receipt.call_id='foreign',(r:any)=>delete r.response.provider_response_usage,
  (r:any)=>r.response.provider_response_usage.message_id='foreign',(r:any)=>r.response.provider_response_usage.raw_response_ids=[],
  (r:any)=>r.response.output.push(r.response.output[0]),(r:any)=>r.response.output[0].name='delegate_revit_task',
  (r:any)=>r.response.output[0].type='computer_call',(r:any)=>r.response.output[0].arguments='[]'];
 for(const mutate of mutations){const r=retained();mutate(r);assert.throws(()=>desktopNativeResponseCall(r,'response','tool-call'));}
 assert.throws(()=>desktopNativeResponseCall(null,'response','tool-call'));
});
test('Pause, unknown, pending effects/reviews/input/usage and completion cannot gain native dispatch',()=>{
 const state:any={terminal:false,quiescent:true,unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],
  in_flight_provider_call_ids:[],provider_calls:{call:{state:'completed',completed_at:'2026-10-27T00:00:00Z',success:true,usage:{},upstream_receipt:{call_id:'response'}}}};
 assert.doesNotThrow(()=>assertDesktopNativeState(state,'response'));
 for(const patch of [{terminal:true},{quiescent:false},{execution_control:{state:'paused'}},{provider_usage_hold:{}},
  {unresolved_unknown_operation_ids:['unknown']},{pending_review_ids:['review']},{pending_input_variable_ids:['input']},
  {in_flight_provider_call_ids:['provider']},{completion_proposal:{}},{provider_calls:{}}])
  assert.throws(()=>assertDesktopNativeState({...state,...patch},'response'));
 assert.throws(()=>assertDesktopNativeState(state,'foreign'));
});
test('existing catalog schemas remain exact; deferred tools use a validated invocation instead of all schemas in prompt',()=>{
 const schema={type:'object',properties:{name:{type:'string'}},required:['name']};
 const tools=desktopNativeModelTools([{name:'revit_ping',description:'Read',inputSchema:schema},
  {name:'deferred',description:'Deferred',inputSchema:schema,deferLoading:true}]);
 assert.deepEqual(tools.map(t=>t.name),['native__revit_ping','native__invoke','native__describe_tool']);assert.equal(tools[0].parameters,schema);
 assert.match(tools.find(t=>t.name==='native__invoke')!.description,/native__describe_tool/);
});

test('current code executor stays directly callable with its exact SDK contract after fresh catalog assembly',()=>{
 const filename='desktop-native-program-contract293.json';
 const fixture=[path.join(import.meta.dirname,'fixtures',filename),path.resolve(import.meta.dirname,'../../test/fixtures',filename)].find(p=>fs.existsSync(p));
 assert(fixture,'actual retained host contract fixture must exist');
 const program=JSON.parse(fs.readFileSync(fixture,'utf8')).tool;
 assert.equal(program.name,'operator_run_dynamic_revit_program');
 assert.equal(program.deferLoading,true);
 const other={...program,name:'other_deferred_program'};
 // Catalogs are rebuilt after continuation/recovery; no conversation-held
 // schema or old catalog is needed to invoke the currently exposed executor.
 for(let turn=0;turn<2;turn++){
  const tools=desktopNativeModelTools([program,other]);
  const direct=tools.find(tool=>tool.name==='native__'+program.name);
  assert(direct,'existing executor must reach the normal Responses tool list');
  assert.equal(direct.parameters,program.inputSchema);
  assert.equal(direct.description,program.description);
  assert.equal(direct.strict,false);
  assert.equal(tools.some(tool=>tool.name==='native__other_deferred_program'),false);
 }
 assert.equal(desktopNativeModelTools([]).some(tool=>tool.name==='native__'+program.name),false,'absent current catalog cannot invent exposure');
 const record=retained();
 record.response.output[0]={...record.response.output[0],name:'native__'+program.name,arguments:'{"mode":"read","source":"exact owner code"}'};
 assert.deepEqual(desktopNativeResponseCall(record,'response','tool-call'),{tool:program.name,arguments:{mode:'read',source:'exact owner code'}});
});
test('native text/image arrays cannot bypass evidence text limits',()=>{
 const budget={item_bytes:100,request_bytes:200} as any;
 assert.doesNotThrow(()=>assertBoundedModelEvidencePayload([{type:'function_call_output',output:[{type:'input_text',text:'ok'},{type:'input_image',image_url:'data:image/png;base64,a'}]}],budget));
 assert.throws(()=>assertBoundedModelEvidencePayload([{type:'function_call_output',output:[{type:'input_text',text:'x'.repeat(101)}]}],budget),/exceeds/);
 assert.throws(()=>assertBoundedModelEvidencePayload([{type:'function_call_output',output:[{type:'unknown',text:'x'}]}],budget),/Invalid/);
});

test('contract discovery cannot invent exposure, accept caller schemas, or return malformed/ambiguous catalogs',()=>{
 const tool={name:'existing',description:'Exact guide',inputSchema:{type:'object'},deferLoading:true};
 assert.equal(desktopNativeToolContract([tool],{tool:'existing'}).tool,tool);
 for(const args of [{tool:'missing'},{tool:'native__existing'},{tool:'../existing'},{tool:'existing',inputSchema:{}},[],null])
  assert.throws(()=>desktopNativeToolContract([tool],args));
 assert.throws(()=>desktopNativeToolContract([],{tool:'existing'}),/not_exposed/);
 assert.throws(()=>desktopNativeToolContract([tool,tool],{tool:'existing'}),/not_exposed/);
 assert.throws(()=>desktopNativeToolContract([{...tool,inputSchema:null} as any],{tool:'existing'}),/contract_invalid/);
 assert.throws(()=>desktopNativeToolContract([{...tool,description:'x'.repeat(262145)}],{tool:'existing'}),/too_large/);
});

test('strict local desktop transport does not select advisory policy or admit hosted/untrusted/non-V2 profiles',()=>{
 const env={REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',
  OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'false'};
 const context={operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic-policy')};
 assert.equal(localDesktopNativeTransportAvailable(env,context),true);
 assert.equal(localExecutorCapability(env,context),null,'strict verification stays strict');
 assert.equal(localDesktopNativeTransportAvailable({...env,OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1'},context),true);
 for(const patch of [{OPERATOR_HOSTED_ENABLED:'true'},{REVIT_OPERATOR_MODE:'hosted'},{REVIT_OPERATOR_MODE:'production'},
  {OPERATOR_ASSIGNMENT_KERNEL_V2:'0'},{OPERATOR_TOOL_EXPOSURE_PROFILE:'general'},{OPERATOR_BRAIN:'rule'}])
  assert.equal(localDesktopNativeTransportAvailable({...env,...patch},context),false);
 assert.equal(localDesktopNativeTransportAvailable(env,undefined),false);
 assert.equal(localDesktopNativeTransportAvailable(env,{...context,principal:{subject:'foreign'}} as any),false);
 assert.equal(localDesktopNativeTransportAvailable(env,{operator_backend_auth:{...context.operator_backend_auth,allowed_origin:'https://remote.example'}} as any),false);
});

test('hosted primary actor uses its authenticated workstation courier without advisory-policy opt-in',()=>{
 const env={REVIT_OPERATOR_MODE:'hosted',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',
  OPERATOR_REVIT_TRANSPORT:'courier',OPERATOR_AUTH_MODE:'principal_jwt',OPERATOR_OPENAI_API_KEY:'test-provider-key'};
 const context={principal:{sub:'user',user_id:'user',tenant_id:'tenant',license_id:'license',roles:[],tier:null,claims:{}},
  operator_backend_auth:createOperatorBackendAuth('principal_jwt','synthetic-jwt')};
 assert.equal(localDesktopNativeTransportAvailable(env,context),true);
 assert.equal(localDesktopNativeTransportAvailable({...env,REVIT_OPERATOR_MODE:'production'},context),true);
 for(const patch of [{OPERATOR_REVIT_TRANSPORT:'direct'},{OPERATOR_ASSIGNMENT_KERNEL_V2:'0'},
  {OPERATOR_OPENAI_API_KEY:''},{OPERATOR_AUTH_MODE:'shared_token'},{REVIT_OPERATOR_MODE:'Hosted'}])
  assert.equal(localDesktopNativeTransportAvailable({...env,...patch},context),false);
 assert.equal(localDesktopNativeTransportAvailable(env,{...context,principal:undefined}),false);
 assert.equal(localDesktopNativeTransportAvailable(env,{...context,operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic')}),false);
});

test('self-hosted general transport does not opt into local experimental verification',()=>{
 const env={REVIT_OPERATOR_MODE:'self_hosted',OPERATOR_TOOL_EXPOSURE_PROFILE:'general',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',
  OPERATOR_BRAIN:'codex',OPERATOR_AUTH_MODE:'shared_token',OPERATOR_OPENAI_API_KEY:'test-provider-key',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1'};
 const context={operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic-policy')};
 assert.equal(localDesktopNativeTransportAvailable(env,context),true);
 assert.equal(localExecutorCapability(env,context),null);
 assert.equal(localDesktopNativeTransportAvailable(env,{...context,operator_backend_auth:{...context.operator_backend_auth,allowed_origin:'https://remote.example'}}),false);
});

test('only an absent documentation name yields a correction; malformed or ambiguous contracts still reject',()=>{
 const tool={name:'existing',description:'Exact guide',inputSchema:{type:'object'}};
 assert.equal(desktopNativeToolDescription([tool],{tool:'existing'}).success,true);
 const missing=desktopNativeToolDescription([tool],{tool:'operator_get_assignment_status'});
 assert.equal(missing.success,false);assert.equal(missing.payload.authorizationGranted,false);
 for(const args of [{tool:'../missing'},{tool:'missing',inputSchema:{}},null,[],{tool:''}])
  assert.throws(()=>desktopNativeToolDescription([tool],args));
 assert.throws(()=>desktopNativeToolDescription([tool,tool],{tool:'existing'}),/not_exposed/);
 assert.throws(()=>desktopNativeToolDescription([{...tool,inputSchema:null} as any],{tool:'existing'}),/contract_invalid/);
 assert.throws(()=>desktopNativeToolDescription([{...tool,description:'x'.repeat(262145)}],{tool:'existing'}),/too_large/);
});

for(const descriptionMode of ['invoke','direct','known','missing','large']) test(`bound desktop ${descriptionMode} preserves ownership without another model and is never redispatched`,async()=>{
 const describe=descriptionMode!=='invoke'&&descriptionMode!=='direct',missing=descriptionMode==='missing';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-native-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',
  OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0',OPERATOR_REVIT_TRANSPORT:'direct'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try {await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const objective='Update the marked note and inspect the actual sheet.';
  const intake=await routeConversation({version:'operator.backend.v1',session_id:'session',message_id:'source',user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,
    confidence:0.99,reason:'Requested note edit.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',
    operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});
  assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:'Read context',objective,acceptance_criteria:['Read actual context'],status:'active',related_session_id:'session',created_by:'local-host',
   work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:'source',source_user_request:objective,
    mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'run'});
  assert.equal(getAssignmentKernelSnapshotV2(goal.id)?.spec.execution_policy,undefined,'direct transport keeps strict assignment policy');
  const runtime=new CodexMcpToolRuntime({backendCwd:process.cwd(),workspaceRoot:root,codexHome:path.join(root,'.codex'),spawnEnv:{}});
  let nativeCalls=0;
  const fixtureName='desktop-native-program-contract293.json';
  const fixture=[path.join(import.meta.dirname,'fixtures',fixtureName),path.resolve(import.meta.dirname,'../../test/fixtures',fixtureName)].find(p=>fs.existsSync(p));
  const programTool=descriptionMode==='large'?JSON.parse(fs.readFileSync(fixture!,'utf8')).tool:
    {name:'operator_run_dynamic_revit_program',description:'C# SDK contract: report-only program; no Autodesk.Revit.DB.',inputSchema:{type:'object',properties:{source:{type:'string'},mode:{enum:['read','preview','apply']}},required:['source']},deferLoading:true};
  runtime.getDynamicToolNamespace=async()=>({tools:[{name:'revit_ping',description:'Read',inputSchema:{type:'object'}},programTool]});
  runtime.validateToolArguments=async()=>{}; // Transport fixture; production validator is unchanged.
  runtime.callTool=async(_name,_args,options:any)=>{nativeCalls++;options?.onMcpAccepted?.();return {content:[{type:'text',text:JSON.stringify({ok:true})}]};};
  workspaceMcpRuntimes.set(root,runtime);
  const catalog=await desktopNativeCatalog(binding);assert.equal(catalog.schema,'operator.desktop-native-tools.v1');
  assert.match(catalog.guidance,/apply the supported change directly/);
  assert.match(catalog.guidance,/compact scope ledger/);
  assert.match(catalog.guidance,/already-known arguments in the same response/);
  assert.match(catalog.guidance,/includeSchemas=true/);
  assert.match(catalog.guidance,/user-requested preview remains noncommitting/);
  assert.match(catalog.guidance,/"work_plan_declared":false/);
  assert.match(catalog.guidance,/no separate status request/);
  const receipt=createOpenAiModelCallReceipt({route:'desktop_computer',requested_model:'test-model',reasoning_effort:'medium',started_at_utc:new Date().toISOString(),duration_ms:1,
   response:{id:'response',status:'completed',model:'test-model',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  const response={...retained().response,model_call_receipt:receipt};
  if(describe)response.output[0]={...response.output[0],name:'native__describe_tool',arguments:JSON.stringify({tool:missing?'operator_get_assignment_status':programTool.name})};
  if(descriptionMode==='direct')response.output[0]={...response.output[0],name:'native__'+programTool.name,arguments:JSON.stringify({source:'exact owner source',mode:'read'})};
  await retainDesktopResponse({...binding,kernelVersion:2},'message',{},()=>executeExternalProviderCallV2({binding,model:'test-model',reasoning_effort:'medium',
   invoke:async()=>response,receipt:r=>r.model_call_receipt,errorReceipt:()=>null}),()=>null);
  const input={message_id:'message',response_id:'response',call_id:'tool-call'};
  await assert.rejects(executeDesktopNativeCall({...binding,generation:2},input),/owner_binding/);
  for(const patch of [{run_id:'foreign'},{session_id:'foreign'},{assignment_id:'foreign'}])
   await assert.rejects(executeDesktopNativeCall({...binding,...patch},input),/owner_binding/);
  const occupied=runtime.beginAssignmentKernelV2Lease(binding);
  await assert.rejects(executeDesktopNativeCall(binding,input),/runtime_already_owned/);
  runtime.endAssignmentKernelV2Lease(occupied);
  const unregister=registerActiveProviderTurn({sessionId:binding.session_id,messageId:'helper',threadId:'thread',turnId:'turn',binding,
   interrupt:async()=>{},steer:async()=>({turnId:'turn'}),interruptionRequested:()=>false});
  await assert.rejects(executeDesktopNativeCall(binding,input),/already_active/);unregister();
  const before=getAssignmentKernelSnapshotV2(goal.id)!;
  const result:any=await executeDesktopNativeCall(binding,{...input,arguments:{fake:'ignored'},tool:'not-trusted'});
  assert.equal(result.schema,'operator.desktop-native-result.v1');assert.equal(nativeCalls,describe?0:1);
  if(describe){
   const contract=JSON.parse(result.result.contentItems[0].text);
   if(descriptionMode==='large'){
    const doc=contract.evidence_projections[0].tool_documentation;
    assert.equal(doc.completion_eligible,false);assert.equal(doc.complete,false);
    assert.equal(doc.tools[0].name,programTool.name);
    assert.deepEqual(doc.tools[0].request_schema.required,programTool.inputSchema.required);
    assert(doc.tools[0].parameter_guidance.some((g:any)=>g.path.endsWith('.native_program.description')));
    assertBoundedModelEvidencePayload({type:'function_call_output',output:result.result.contentItems[0].text});
   }else if(missing){
    assert.equal(contract.completion_eligible,false);assert.equal(contract.authorizationGranted,false);
    assert.equal(result.result.success,false);assert.equal(result.stop_reason,null);
    assert.equal(contract.schema,'operator.desktop-native-tool-contract-unavailable.v1');
    assert.equal(contract.requested_tool,'operator_get_assignment_status');
    assert.equal(contract.native_action_dispatched,false);
    assert.match(contract.guidance,/current catalog/);
    assert.equal(contract.tool,undefined);assert.equal(contract.invocation,undefined);
   }else{
    assert.equal(contract.completion_eligible,false);assert.equal(contract.authorizationGranted,false);
    assert.equal(result.result.success,true);assert.deepEqual(contract.tool,programTool);
    assert.equal(contract.invocation.tool,'native__invoke');
   }
  }
  const after=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(after.provider_call_ids.length,before.provider_call_ids.length,'no helper provider');
  assert.equal(Object.keys(after.operations).length,Object.keys(before.operations).length+(describe?0:1),'documentation creates no model operation');
  if(!describe)assert.equal(Object.values(after.operations).at(-1)?.capability_id,descriptionMode==='direct'?programTool.name:'revit_ping');
  await assert.rejects(executeDesktopNativeCall(binding,input));assert.equal(nativeCalls,describe?0:1,'no repeat after settled or failed result');
  if(missing){
   assert.equal(after.outcome,before.outcome);assert.equal(after.terminal,before.terminal);
   const correctedReceipt=createOpenAiModelCallReceipt({route:'desktop_computer',requested_model:'test-model',reasoning_effort:'medium',started_at_utc:new Date().toISOString(),duration_ms:1,
    response:{id:'response2',status:'completed',model:'test-model',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
   const corrected={...retained().response,id:'response2',model_call_receipt:correctedReceipt,
    provider_response_usage:{disposition:'completed',message_id:'message2',session_id:binding.session_id,raw_response_ids:['response2']},
    output:[{type:'function_call',name:'native__describe_tool',call_id:'corrected-call',arguments:JSON.stringify({tool:programTool.name})}]};
   await retainDesktopResponse({...binding,kernelVersion:2},'message2',{},()=>executeExternalProviderCallV2({binding,model:'test-model',reasoning_effort:'medium',
    invoke:async()=>corrected,receipt:r=>r.model_call_receipt,errorReceipt:()=>null}),()=>null);
   const correctedResult:any=await executeDesktopNativeCall(binding,{message_id:'message2',response_id:'response2',call_id:'corrected-call'});
   assert.equal(correctedResult.result.success,true);assert.equal(correctedResult.stop_reason,null);
   assert.equal(JSON.parse(correctedResult.result.contentItems[0].text).tool.name,programTool.name);
   assert.equal(nativeCalls,0);assert.equal(Object.keys(getAssignmentKernelSnapshotV2(goal.id)!.operations).length,Object.keys(before.operations).length);
  }
 });}finally{workspaceMcpRuntimes.delete(root);__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__testOnlyResetGoalListCache();}
});
