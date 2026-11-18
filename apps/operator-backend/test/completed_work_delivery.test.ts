import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {fileURLToPath} from 'node:url';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {verifiedChangePresentationV2} from '../src/assignments/verified_change_presentation_v2.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';
import {savedCopyHandoffV2,savedProjectBeforeInterruptionV2} from '../src/assignments/saved_copy_handoff_v2.js';
import {finalCodexAssignmentMessageV2} from '../src/brains/codex_assignment_progress.js';
import {generateWorkReturnFromKernelV2} from '../src/work_returns/assignment_kernel_v2_generator.js';
import {workReturnTerminalPresentationV2} from '../src/work_returns/terminal_presentation.js';
import {verifyWorkReturnHash} from '../src/work_returns/generator.js';
const here=path.dirname(fileURLToPath(import.meta.url)),file=[path.join(here,'fixtures/completed-work-delivery-516.json'),path.join(here,'../../test/fixtures/completed-work-delivery-516.json')].find(fs.existsSync)!;
function fixture(id:string,run:(s:any)=>void){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'operator-work-delivery-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=dir;
 try{const f=JSON.parse(fs.readFileSync(file,'utf8'))[id],s=f.snapshot;for(const [oid,payload]of Object.entries(f.payloads)){const o=s.observations[oid],stored=storeEvidence({scope:{...s.current_binding,attempt_id:o.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload});o.raw_payload_ref='evidence:'+stored.ref.evidence_id;}run(s);}
 finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('operator-work-delivery-'));fs.rmSync(dir,{recursive:true,force:true});}}
for(const [id,summary]of [['schedule-original','Verified in Revit: 1 schedule.'],['mixed-original','Verified in Revit: 1 element with updated parameters.']]){
 test(`${id} native result and saved path survive bound Work Return projection without certifying task completion`,()=>fixture(id,s=>{
  Object.assign(s,{terminal:true,outcome:'blocked',terminal_reason:'inspection_pending'});
  const goal={id:s.current_binding.assignment_id,updated_at:s.finished_at} as any,workReturn=generateWorkReturnFromKernelV2(goal,s,null,null),before=JSON.stringify(s),returnBefore=JSON.stringify(workReturn);
  assert(verifyWorkReturnHash(workReturn));const presentation=workReturnTerminalPresentationV2(s,workReturn);assert(presentation);
  assert.equal(presentation.work_return_id,workReturn.work_return_id);assert.equal(presentation.work_return_hash,workReturn.work_return_hash);assert.deepEqual(presentation.binding,s.current_binding);
  assert(presentation.terminal_result_v2.result_summary.includes(summary));assert.match(presentation.terminal_result_v2.result_summary,/Saved file:.*Result\.rvt/);
  assert.match(presentation.terminal_result_v2.result_summary,/content verification is pending/);assert.equal(presentation.terminal_result_v2.outcome,'blocked');
  for(const state of ['active','unknown','inflight','provider','foreign-return','hash','status'] as const){const copy=structuredClone(s),wr=structuredClone(workReturn);
   if(state==='active'){copy.terminal=false;copy.outcome='active';}if(state==='unknown')copy.unresolved_unknown_operation_ids=['uncertain'];if(state==='inflight')copy.in_flight_operation_ids=['pending'];if(state==='provider')copy.in_flight_provider_call_ids=['pending'];
   if(state==='foreign-return')wr.run_id='foreign';if(state==='hash')wr.work_return_hash='sha256:'+'f'.repeat(64);if(state==='status')wr.status='complete';
   assert.equal(workReturnTerminalPresentationV2(copy,wr),null,state+' must not expose a terminal projection');
  }
  assert.equal(JSON.stringify(s),before);assert.equal(JSON.stringify(workReturn),returnBefore);assert.deepEqual(workReturnTerminalPresentationV2(JSON.parse(before),JSON.parse(returnBefore)),presentation);
 }));
 for(const proposal of [false,true])test(`${id} input handoff keeps native verified changes and saved path beside unanswered question (proposal ${proposal})`,()=>fixture(id,s=>{
  Object.assign(s,{terminal:false,outcome:'awaiting_user_input',completion_proposal:proposal?s.completion_proposal??{}:null,
   provider_usage_hold:null,progress_blocker:null,provider_budget_exhausted:false,execution_failure_ids:[],
   pending_input_variable_ids:['engineering'],clarifications:{
    old:{question:'Already answered?',resolved_at:'2026-01-01T00:00:00Z'},
    engineering:{clarification_id:'engineering',variable_id:'engineering',question:'What is the approved cafe HVAC design basis?',requested_at:'2026-10-25T15:35:00Z'}
   }});
  const before=JSON.stringify(s),saved=savedCopyHandoffV2(s);assert(saved,'Actual native-bound saved receipt remains eligible');
  const save=Object.values(s.operations).find((o:any)=>o.request_identity?.path==='/revit/save-as'&&o.persistent_effect==='applied') as any;
  const filePath=save.result.native_artifact_receipt.save_document.after.path;
  const message=finalCodexAssignmentMessageV2(s,'Everything is complete.');
  assert(message.includes(summary),'Awaiting input must not drop independently verified supported changes');
  assert(message.includes(filePath),'Known saved file must remain usable, not basename only');
  assert.match(message,/What is the approved cafe HVAC design basis\?/);assert.match(message,/content verification is pending/);
  assert.doesNotMatch(message,/Already answered|Everything is complete|HVAC design completed/);assert.equal(JSON.stringify(s),before);
  for(const state of ['unknown','paused','usage-hold','inflight'] as const){const blocked=structuredClone(s);
   if(state==='unknown')blocked.unresolved_unknown_operation_ids=['uncertain'];
   if(state==='paused')blocked.execution_control={...blocked.execution_control,state:'paused'};
   if(state==='usage-hold')blocked.provider_usage_hold={hold_id:'test',reason:'unsettled usage'};
   if(state==='inflight'){blocked.quiescent=false;blocked.in_flight_operation_ids=['pending'];}
   const guarded=finalCodexAssignmentMessageV2(blocked,'Everything is complete.');assert(!guarded.includes(filePath),state+' must preserve existing guard precedence');
  }
 }));
 test(`${id} incomplete saved-file handoff renders a usable path without claiming model completion`,()=>fixture(id,s=>{
  Object.assign(s,{terminal:true,outcome:'blocked',terminal_reason:'work_remains'});
  const save=Object.values(s.operations).find((o:any)=>o.request_identity?.path==='/revit/save-as'&&o.persistent_effect==='applied') as any;
  assert(savedCopyHandoffV2(s)?.text.includes(save.result.native_artifact_receipt.save_document.after.path));
  assert.match(deriveTerminalResultV2(s).result_summary,/requested work did not complete/);
 }));
 test(`actual516 ${id} keeps verified edit summary beside verified model link`,()=>fixture(id,s=>{
  const before=JSON.stringify(s),completedSummary=id==='schedule-original'?summary+'\nName column width: 3.375 inches.':summary;
  assert.equal(verifiedChangePresentationV2(s),completedSummary);const message=deriveTerminalResultV2(s).result_summary;
  assert(message.includes(summary));assert.match(message,/Verified file:.*Result\.rvt/);assert.doesNotMatch(message,/six schedules|all model|readable|HVAC design completed/);assert.equal(JSON.stringify(s),before);
 }));
 for(const variant of ['foreign','unverified','hash','stale','unknown','target','route'])test(`${id} summary refuses ${variant}`,()=>fixture(id,s=>{
  const a=Object.values(s.operations).find((o:any)=>o.request_identity.path=== (id==='schedule-original'?'/revit/configure-schedule':'/revit/set-parameter')) as any;
  const r=s.operations[a.verification_operation_ids[0]],o=s.observations[r.observation_ids[0]];
  if(variant==='foreign')r.result.binding={...s.current_binding,generation:999};
  if(variant==='unverified')o.facts=o.facts.filter((f:any)=>f.fact_id!=='verification.postcondition_satisfied');
  if(variant==='hash')o.raw_payload_hash='0'.repeat(64);
  if(variant==='stale')r.result.completed_at='2020-01-01T00:00:00Z';
  if(variant==='unknown')s.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'unknown',opened_at:'2099-01-01T00:00:00Z'};
  if(variant==='target')r.target={...r.target,target_id:'id:42',semantic_scope:{}};
  if(variant==='route')r.request_identity.path='/revit/unrecognized';
  assert.equal(verifiedChangePresentationV2(s),null);
 }));
}

test('a project save remains available as a historical checkpoint during a separate family open failure',()=>fixture('schedule-original',snapshot=>{
 const save=Object.values(snapshot.operations).find((operation:any)=>operation.input.path==='/revit/save-as') as any;
 const checkpoint=save.result.native_artifact_receipt.save_document.after.path;
 const operationId='separate-family-open';
 const body={filePath:'C:\\Project\\Door.rfa',audit:false,detach:false,discardExistingOpenDocument:false};
 const request={...save.request_identity,path:'/revit/open-model'};
 snapshot.operations[operationId]={...save,operation_id:operationId,request_identity:request,
  admitted_assignment_version:save.settled_assignment_version+1,settled_assignment_version:save.settled_assignment_version+3,
  input:{method:'POST',path:'/revit/open-model',body},observation_ids:[],persistent_effect:'unknown',
  result:{...save.result,operation_id:operationId,request_identity:request,persistent_effect:'unknown',status:'failed_after_dispatch'}};
 Object.assign(snapshot,{terminal:false,outcome:'active',unresolved_unknown_operation_ids:[operationId],
  in_flight_operation_ids:[],in_flight_provider_call_ids:[],pending_review_ids:[],execution_control:undefined});
 const before=JSON.stringify(snapshot);
 assert.equal(savedCopyHandoffV2(snapshot),null);
 assert.equal(savedProjectBeforeInterruptionV2(snapshot)?.file,checkpoint);
 for(const mode of ['same-project','discard','unrecognized-option','concurrent','foreign','stale-save','paused','pending-usage','another-unknown'] as const){
  const copy=structuredClone(snapshot),operation=copy.operations[operationId];
  if(mode==='same-project')operation.input.body.filePath=checkpoint;
  if(mode==='discard')operation.input.body.discardExistingOpenDocument=true;
  if(mode==='unrecognized-option')operation.input.body.futureOption=false;
  if(mode==='concurrent')operation.admitted_assignment_version=save.settled_assignment_version;
  if(mode==='foreign')operation.result.binding={...copy.current_binding,run_id:'other-run'};
  if(mode==='stale-save')copy.input_invalidated_operation_ids=[save.operation_id];
  if(mode==='paused')copy.execution_control={state:'paused'};
  if(mode==='pending-usage')copy.in_flight_provider_call_ids=['pending'];
  if(mode==='another-unknown')copy.unresolved_unknown_operation_ids.push('unproven');
  assert.equal(savedProjectBeforeInterruptionV2(copy),null,mode);
 }
 assert.equal(JSON.stringify(snapshot),before);
}));
