import test from 'node:test';
import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {completionOutboxKeyV2,retainCompletionOutboxV2} from '@revitoperator/assignment-kernel-v2-contracts/completion-outbox';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,openAssignmentKernelChildOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2} from '../src/assignments/assignment_kernel_v2_execution.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';

test('lost HTTP acknowledgement of retained native batch delivers same receipt twice with one committed observation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-batch-ack-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 const server=createServer();
 try{
  const goal=createGoal({title:'Parameter batch delivery',objective:'Update the selected tag parameters.',acceptance_criteria:['Requested changes independently verified.'],status:'active',
   related_session_id:'ack-session',created_by:'ack-principal',work_budget:{requested_effect:'apply',document_fingerprint:'ack-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'ack-run'});const initial=getAssignmentKernelSnapshotV2(goal.id)!;
  const payload=JSON.parse(fs.readFileSync('test/fixtures/parameter-native-batch-32.json','utf8').replace(/^\uFEFF/,'')).native_payload;
  const changes=payload.diffs.map((d:any)=>({elementId:d.elementId,parameterName:d.parameterName,value:'0',expectedOldValue:'1'}));
  const lease=openAssignmentKernelOperationV2({snapshot:initial,controller_request_id:'one-apply',provider_turn_id:'ack-turn',
   capability_id:'revit_call_tool',classified_effect:'apply',arguments:{method:'POST',path:'/revit/set-parameter',body:{changes,apply:true,dryRun:false}}});
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const record={content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',
   result_id:'batch-ack:'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',
   native_transaction_state:'committed',authority:'native-host',result_schema_id:'operator-native/POST:/revit/set-parameter/v2',observation_required:true,
   affected_target_identities:payload.changedElementIds.map((id:number)=>'element_id:'+id),raw_payload_hash:payloadDigestV2(payload).digest,
   request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'task.edit_applied',value:true}],verification_relevance:['execution']}}};
  let requests=0;let firstState:any;
  server.on('request',async(req,res)=>{
   let raw='';for await(const chunk of req)raw+=chunk;requests++;
   try{
    assert.equal(req.url,'/api/assignments/v2/operations/results');assert.equal(req.headers['x-operator-token'],'test-only-ack');
    const body=JSON.parse(raw);assert.equal(body.operation_id,lease.operation_id);
    const settled=settleAssignmentKernelOperationV2(lease,body.mcp_result);
    if(!firstState)firstState=settled.snapshot;
    if(requests===1){req.socket.destroy();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result_id:settled.result.result_id}));
   }catch(error){res.writeHead(400);res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const module=await import(pathToFileURL(path.resolve('../mcp-server/dist/lib/operatorBackendClient.js')).href);
  const client=module.createOperatorBackendClient({baseUrl:`http://127.0.0.1:${(server.address() as any).port}`,token:'test-only-ack'});
  const body={...lease.binding,operation_id:lease.operation_id,mcp_result:record};
  assert.deepEqual(await client.settleAssignmentOperationV2(body),{ok:true,result_id:record.structuredContent.operation_result_v2.result_id});
  const final=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(requests,2);assert.deepEqual(final,firstState);assert.equal(Object.keys(final.operations).length,1);
  assert.equal(Object.keys(final.observations).length,1);assert.equal(final.operations[lease.operation_id]!.persistent_effect,'applied');
  assert.equal(final.operations[lease.operation_id]!.verification_operation_ids.length,0,'delivery alone is not a separate postcondition check');
  assert.notEqual(final.outcome,'complete');
  const conflict=structuredClone(body);conflict.mcp_result.structuredContent.operation_result_v2.raw_payload_hash='0'.repeat(64);
  await assert.rejects(client.settleAssignmentOperationV2(conflict),/status 400/);assert.equal(requests,3);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),final);
 }finally{
  server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  __testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  fs.rmSync(root,{recursive:true,force:true});
 }
});

for(const variant of ['retained','missing','wrong_signature'] as const)test(`failed discovery handoff ${variant} recovers exact child without native replay or completion credit`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-delivery-replay-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const goal=createGoal({title:'Panel leaders',objective:'Turn off the panel tag leaders.',acceptance_criteria:['The requested edit is established.'],status:'active',
   related_session_id:'delivery-session',created_by:'delivery-principal',work_budget:{requested_effect:'apply',document_fingerprint:'delivery-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'delivery-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  let calls=0,childId='';
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},async callTool(_tool:string,_args:any,context:any){
   calls++;context.onMcpAccepted();const parent=context.assignmentKernelV2;
   const child=openAssignmentKernelChildOperationV2({binding,parent_operation_id:parent.operation_id,child_ordinal:0,operation_role:'child',classified_effect:'read',
    capability_id:'native:GET:/revit/tool-registry',method:'GET',path:'/revit/tool-registry',arguments:null});childId=child.operation_id;
   markAssignmentKernelOperationDispatchStartedV2(child);
   const payload=JSON.parse(fs.readFileSync('test/fixtures/registry-native-read-31.json','utf8')).native_payload;
   if(variant!=='missing'){
    const record={content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',
     result_id:'retained:'+childId,operation_id:childId,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',authority:'native-host',
     result_schema_id:'operator-native/GET:/revit/tool-registry/v2',observation_required:true,affected_target_identities:[],raw_payload_hash:payloadDigestV2(payload).digest,
     request_identity:child.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[{fact_id:'control.result_available',fact_class:'control',value:true}],verification_relevance:['control']}}};
    retainCompletionOutboxV2(root,completionOutboxKeyV2(root),child,record);
    if(variant==='wrong_signature'){
     const file=fs.readdirSync(path.join(root,'runtime/assignment-completions-v2')).find(f=>f.endsWith('.json'))!;
     const p=path.join(root,'runtime/assignment-completions-v2',file),corrupt=JSON.parse(fs.readFileSync(p,'utf8'));corrupt.signature='0'.repeat(64);fs.writeFileSync(p,JSON.stringify(corrupt));
    }
   }
   return {isError:true,content:[{type:'text',text:'assignment_kernel_v2_native_settlement_failed:retained discovery handoff'}]};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'delivery-test',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'discovery',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'discovery-turn',tool:'revit_search_tools',
    arguments:{query:'find elements tags native api operations sheet viewports capture view',max:8,includeSchemas:true}}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
   assert.equal(calls,1);assert.equal(response.success,false);assert.notEqual(s.outcome,'complete');
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,0);
   assert.equal(s.operations[childId]!.settlement_state,variant==='retained'?'settled':'awaiting_result');
   assert.equal(s.in_flight_operation_ids.length,variant==='retained'?0:2);
   if(variant==='retained'){
    assert.equal(s.operations[childId]!.result!.status,'succeeded');
    assert(Object.values(s.observations).every(o=>o.evidence_class==='control'&&!(o.eligible_criterion_ids?.length)));
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
