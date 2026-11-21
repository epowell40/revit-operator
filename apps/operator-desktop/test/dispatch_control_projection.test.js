import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
import * as contracts from '@revitoperator/assignment-kernel-v2-contracts';
import {assertComputerDispatchSnapshot} from '../saved_computer_assignment.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('async function assertComputerActionControl('),body=source.slice(start,source.indexOf('\n}\n',start)+2);
const pending=['pending_review_ids','pending_input_variable_ids','unresolved_unknown_operation_ids','in_flight_operation_ids','in_flight_provider_call_ids'];
function publication(){const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'};
 return {schema:'revit-operator.assignment-kernel-publication/v2',assignment_id:'task',assignment_version:12,
  snapshot:{schema:'revit-operator.assignment-snapshot/v2',assignment_version:12,current_binding:binding,
   execution_control:{state:'running',command_id:'resume',changed_at:'2026-11-21T00:00:00Z'},outcome:'active',terminal:false,quiescent:true,
   provider_budget_exhausted:false,completion_proposal:null,provider_call_ids:[],provider_calls:{},...Object.fromEntries(pending.map(k=>[k,[]]))},
  provider_ledger:{schema:'revit-operator.assignment-provider-ledger/v2',assignment_id:'task',run_id:'run',generation:1,call_ids:[],in_flight_call_ids:[],calls:{}}};}
function harness(reply){
 const p=publication(),state={sidecarAssignment:{...p.snapshot.current_binding,goal_id:'task',kernel_version:2,control_command_id:'resume'}},requests=[];
 const check=runInNewContext(body+';assertComputerActionControl',{
  computerState:state,computerRunTestHooks:null,parseAssignmentDispatchControlV1:contracts.parseAssignmentDispatchControlV1,assertComputerDispatchSnapshot,
  sidecarAssignmentBindingPayload:()=>({assignment_id:'task',assignment_run_id:'run',assignment_generation:1}),
  sidecarAssignmentKernelPublicationFromResponse:r=>r.assignment_kernel_v2,
  validateSidecarAssignmentKernelPublication:v=>contracts.parseAssignmentKernelPublicationV2(v),
  readBackendJson:async(route,options)=>{requests.push({route,options});return reply(p,requests.length);}
 });return {check,state,requests,p};
}
test('actual per-action guard requests compact control freshly and rejects a later Pause before dispatch',async()=>{
 const h=harness((p,n)=>{if(n===2)p.snapshot.execution_control={...p.snapshot.execution_control,state:'paused',command_id:'pause'};
  return {assignment_dispatch_control_v1:contracts.projectAssignmentDispatchControlV1(p)};});
 await h.check();await assert.rejects(h.check(),/paused/);assert.equal(h.requests.length,2);assert.equal(h.state.stopRequested,true);
 for(const r of h.requests){assert.equal(r.options.headers['x-operator-assignment-handoff'],'dispatch_control_v1');assert.equal(r.options.cache,'no-store');}
});
test('old server full-publication response remains compatible without another request',async()=>{
 const h=harness(p=>({assignment_kernel_v2:p}));await h.check();assert.equal(h.requests.length,1);
});
test('malformed compact data and transport uncertainty never fall back or repeat a control request',async()=>{
 for(const reply of [()=>({assignment_dispatch_control_v1:null}),()=>{throw Error('transport unknown');}]){
  const h=harness(reply);await assert.rejects(h.check());assert.equal(h.requests.length,1);
 }
});
test('compact state keeps every existing dispatch hold and binding/command fence',async()=>{
 const changes=[s=>s.terminal=true,s=>s.outcome='awaiting_user_review',s=>s.quiescent=false,s=>s.provider_budget_exhausted=true,
  s=>s.provider_usage_hold=true,s=>s.completion_proposal=true,
  ...pending.map(k=>s=>s[k]=['pending']),s=>s.current_binding.run_id='foreign',s=>s.current_binding.session_id='other',s=>s.current_binding.generation=2,
  s=>s.execution_control.command_id='later-resume'];
 for(const change of changes){
  const h=harness(p=>{const projection=contracts.projectAssignmentDispatchControlV1(p);change(projection.snapshot);return {assignment_dispatch_control_v1:projection};});
  await assert.rejects(h.check());assert.equal(h.requests.length,1);
 }
});
