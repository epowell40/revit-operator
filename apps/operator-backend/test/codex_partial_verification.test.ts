import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {prepareAssignmentTurn,bindPreparedAssignmentToRequest} from '../src/assignments/turn_preparation.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA} from '../src/assignments/assignment_kernel_v2_execution.js';
import {__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner,teammateLoopReceiptForOwner,__testOnlyResetTeammateLoopState} from '../src/teammate_loop_runtime.js';
import {deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {__testOnlyFinalizeDecision} from '../src/brain.js';
import {finalizeCanonicalAssignment} from '../src/assignments/canonical_finalization.js';
import {settleCodexAssignmentProgressV2} from '../src/brains/codex_assignment_progress.js';
import {renderTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';

for(const variant of ['connected','connected-c40','open-ends','wrong-height','create-round','create-rectangular'] as const)test(`dynamic handler retains partial native verification without a premature compatibility assertion: ${variant}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-partial-verification-'));
 const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_ASSIGNMENT_KERNEL_V2'],old=keys.map(k=>process.env[k]);
 process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2='1';__testOnlyResetGoalListCache();__testOnlyResetTeammateLoopState();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const fixtureName=variant==='connected-c40'?'c40-connected-duct-readback':variant==='create-round'?'c38-disconnected-round-duct-readback':variant==='create-rectangular'?'c35-open-duct-readback':'c37-connected-duct-readback';
  const f=JSON.parse(fs.readFileSync('test/fixtures/'+fixtureName+'.json','utf8'));
  const expectedVerified=variant==='connected'||variant==='connected-c40'||variant==='create-rectangular';
  if(variant==='create-rectangular'){const b=f.input.body;f.input={method:'POST',path:'/revit/create-duct',body:{levelId:b.levelId,ductTypeId:b.ductTypeId,ductShape:b.ductShape,ductSize:b.ductSize,systemType:b.systemType,startPoint:b.points[0],endPoint:b.points[1],dryRun:false}};}
  if(variant==='create-round'){
   const subject=f.connectors.results.find((r:any)=>r.id===1542942);f.parameters.items=f.parameters.items.filter((r:any)=>r.id===1542942);
   Object.assign(f.connectors,{results:[subject],requestedCount:1,scannedElementCount:1,matchedElementCount:1,totalScannedConnectorCount:2,physicallyConnectedConnectorCount:0,openPhysicalConnectorCount:2});
  }
  const targetId=Number(f.affected[0].split(':')[1]);
  if(variant==='open-ends'){
   f.connectors.physicallyConnectedConnectorCount=0;f.connectors.openPhysicalConnectorCount=2;
   f.connectors.results[0].openPhysicalConnectorCount=2;
   for(const c of f.connectors.results[0].connectors){c.isConnected=false;c.isPhysicallyConnected=false;c.physicalConnectionCount=0;c.physicalConnectedTo=[];c.connectedTo=[];}
  }
  if(variant==='wrong-height')f.connectors.results[0].connectors[0].origin[2]+=1;
  const prompt=variant==='create-rectangular'?'Create the marked rectangular supply duct, leave its ends open, and verify the result.':'Reconstruct the missing exhaust duct, connect it to the remaining compatible ductwork, and verify the result.';
  const prepared=prepareAssignmentTurn({sessionId:'verify-session',messageId:'reconstruct',userText:prompt,toolResults:[],source:'chat',createdBy:null,requestContext:{revit:{document:{projectIdentity:{fingerprint:'fixture-model'}}}}})!;
  const binding=prepared.bindingV2!;let dispatches=0;
  const runtime={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop:()=>{},callTool:async(_tool:string,args:any,context:any)=>{
   context.onMcpAccepted();dispatches++;const lease=context.assignmentKernelV2,apply=args.path===f.input.path;
   const payload=apply?{status:'Success',createdElementIds:[targetId],transaction:{status:'committed',committed:true}}:args.path==='/revit/get-parameters'?f.parameters:f.connectors;
   const receipt='receipt:'+lease.operation_id;
   return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
    operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:apply?'applied':'none',native_transaction_state:apply?'committed':'not_applicable',authority:'native-host',result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,receipt_id:receipt,native_correlation_id:receipt,raw_payload_hash:payloadDigestV2(payload).digest,request_identity:lease.request_identity,affected_target_identities:apply?f.affected:[],completed_at:new Date().toISOString()},
    observation:{raw_payload:payload,semantic_facts:[{fact_id:apply?'task.result_available':'verification.result_available',fact_class:apply?'domain':'verification',value:true}],verification_relevance:['task_result'],evidence_class:'task_result'}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,bindPreparedAssignmentToRequest({version:'operator.backend.v1',session_id:binding.session_id,user_text:prompt,context:{revit:{process_id:4242,source:{live:true},activeView:{id:1363433,name:'L4'},document:{title:'Mechanical model',projectIdentity:{fingerprint:'fixture-model'}}}}} as any,prepared));
  try{
   const run=(id:string,arguments_:any)=>handleCodexDynamicToolCall(runtime as any,{id,method:'item/tool/call',params:{namespace:'revit_operator',turnId:'verify-turn',tool:'revit_call_tool',arguments:arguments_}} as any) as Promise<any>;
   const applied=await run('apply',f.input);assert.equal(applied.success,true,JSON.stringify(applied));
   const params=await run('parameters',{method:'POST',path:'/revit/get-parameters',body:{elementIds:[targetId],includeEmpty:true}});
   assert.equal(params.success,true,JSON.stringify(params));
   const partial=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
   const parameterOp=Object.values(partial.operations).find(op=>op.request_identity?.path==='/revit/get-parameters')!;
   assert.equal(parameterOp.result?.status,'succeeded');assert.equal(parameterOp.observation_ids.length,1);
   assert.equal(partial.terminal,false);assert(deriveProgressGapsV2(partial).some(g=>g.kind==='verification_required'));
   assert.equal(teammateLoopReceiptForOwner(runtime)!.verified,false,'compatibility layer cannot advertise complete verification after only parameter readback');
   const connectors=await run('connectors',{method:'POST',path:'/revit/get-connectors',body:{elementIds:[targetId],includeAllRefs:true}});
   assert.equal(connectors.success,true,JSON.stringify(connectors));assert.equal(dispatches,3);
   const final=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
   const connectorOp=Object.values(final.operations).find(op=>op.request_identity?.path==='/revit/get-connectors')!;
   assert.equal(connectorOp.result?.status,'succeeded');assert.equal(connectorOp.observation_ids.length,1);
   assert.equal(final.outcome==='complete',expectedVerified);
   assert.equal(teammateLoopReceiptForOwner(runtime)!.verified,expectedVerified);
   assert.equal(deriveProgressGapsV2(final).some(g=>g.kind==='verification_required'),!expectedVerified);
   assert.deepEqual(final.unresolved_unknown_operation_ids,[]);
   const req=bindPreparedAssignmentToRequest({version:'operator.backend.v1',session_id:binding.session_id,user_text:prompt,tool_results:[]} as any,prepared);
   const decision:any={version:'operator.backend.v1',assistant_message:'Provider says this is done.',actions:[],provider_turn_usage:{retained:true}};
   if(expectedVerified){
    const terminal=settleCodexAssignmentProgressV2(binding)!;
    assert.equal(terminal.terminal,true);
    const message=renderTerminalResultV2(terminal);
    const finalized=__testOnlyFinalizeDecision(req,{...decision,assignment_snapshot_v2:{forged:true},terminal_result_v2:{forged:true}});
    assert.equal(finalized.assistant_message,message,'outer legacy guards must not contradict verified native work');
    assert.equal(finalized.terminal_result_v2?.outcome,'complete');
    assert.deepEqual(finalized.assignment_snapshot_v2,terminal);
    assert.deepEqual(finalized.provider_turn_usage,decision.provider_turn_usage);
    assert.deepEqual(finalized.actions,[]);
    for(const changed of [{session_id:'foreign-session'},{assignment_run_id:'stale-run'},{assignment_generation:binding.generation+1},{assignment_id:'foreign-task'}]){
     assert.equal(finalizeCanonicalAssignment({...req,...changed},{...decision,assignment_snapshot_v2:terminal}),null);
    }
   }else assert.equal(finalizeCanonicalAssignment(req,decision),null,'partial verification cannot bypass legacy handling as a terminal');
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();__closeForTests();keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});fs.rmSync(root,{recursive:true,force:true});}
});
