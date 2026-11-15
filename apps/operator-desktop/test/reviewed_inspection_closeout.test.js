import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
import {closeReviewedInspection,reviewedInspectionHasTerminalResult,reviewStoppedAssignment} from '../reviewed_inspection_closeout.mjs';
import {nativeChangeObservationFromContext} from '../native_change_observations.mjs';
import {assertComputerDispatchSnapshot} from '../saved_computer_assignment.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('async function closeRetainedOwnerInspection('),end=source.indexOf('async function retainScreenshotEvidence(',start);
assert(start>0&&end>start);
const binding={assignment_id:'a',run_id:'r',generation:1,session_id:'s'};
const bindingStart=source.indexOf('function sidecarAssignmentBindingPayload('),bindingEnd=source.indexOf('function withSidecarAssignmentBinding(',bindingStart);
assert(bindingStart>0&&bindingEnd>bindingStart);
function fixture(){const at=new Date().toISOString(),scene={process_id:12,document_session_id:'doc',epoch:'epoch',through_sequence:0,view_id:41};
 const review={schema:'operator.visual_work_review.v1',authority:'supporting_visual_assessment',ok:true,state:'matched',native_postcondition_verified:false,whole_task_verified:false,
  owner:binding,location:scene,request:{view_id:41,complete_inspection_item_id:'inspect',checks:[{id:'clear',expected:'Clear'}]},checks:[{id:'clear',status:'matched'}],reviewer_response_id:'resp_review'};
 const snapshot={assignment_version:235,current_binding:binding,quiescent:true,terminal:false,outcome:'active',spec:{work_plan_required:true},
  in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],
  work_plan:{items:[{item_id:'inspect',kind:'inspection',operation_ids:[]}]},operations:{read:{requested_effect:'read',persistent_effect:'none'}}};
 const retained={evidence_ref:{schema:'revit-operator.evidence-ref.v1',...binding,evidence_id:'ev1_review',source:'operator_desktop.function.review_current_work',
  content_hash:'sha256:'+'a'.repeat(64),byte_count:500,created_at_utc:at}};
 const cached={context:{process_id:12,document:{sessionId:'doc',activeView:{id:41}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:12,documentSessionId:'doc',epoch:'epoch',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]}}};
 return {review,snapshot,retained,cached};}
function wrapper(validate=false,assignment={assignment_id:'a',session_id:'s',assignment_run_id:'r',assignment_generation:1}){return runInNewContext(source.slice(bindingStart,bindingEnd)+source.slice(start,end)+';closeRetainedOwnerInspection',{
 closeReviewedInspection,reviewStoppedAssignment,nativeChangeObservationFromContext,encodeURIComponent,
 computerState:{sidecarAssignment:assignment},
 sidecarAssignmentKernelPublicationFromResponse:p=>p,
 ...(validate?{validateSidecarAssignmentKernelPublication:(p,b)=>{assert.equal(p.snapshot.current_binding.run_id,b.run_id);return p;}}:{})});}
test('actual transport producer omits session and is not a full owner binding',()=>{
 const payload=runInNewContext(source.slice(bindingStart,bindingEnd)+';sidecarAssignmentBindingPayload({required:true})',{
  computerState:{sidecarAssignment:{...binding,assignment_run_id:'r',assignment_generation:1}}});
 assert.equal(payload.assignment_id,'a');assert.equal(payload.assignment_run_id,'r');assert.equal(payload.assignment_generation,1);
 assert.equal(Object.hasOwn(payload,'session_id'),false,'Keep existing transport schema unchanged');
});

for(const session of [undefined,'foreign'])test(`actual wrapper rejects missing/foreign owner session ${session}`,async()=>{
 const f=fixture();let calls=0;
 const result=await wrapper(true,{assignment_id:'a',session_id:session,assignment_run_id:'r',assignment_generation:1})(
  {host_visual_work_review:f.review},f.retained,{assertControl:async()=>{},readIdentity:async()=>f.cached,request:async()=>{calls++;}});
 assert.equal(result.state,'not_submitted');assert.equal(calls,0);
});

test('actual private wrapper fails closed without publication validation',async()=>{
 const f=fixture(),calls=[],out={};Object.defineProperty(out,'host_visual_work_review',{value:f.review});
 const result=await wrapper()(out,f.retained,{binding,assertControl:async()=>calls.push('control'),readIdentity:async()=>f.cached,request:async(route,o)=>{
  calls.push(route);if(o.method==='GET')return {snapshot:f.snapshot};
  const b=JSON.parse(o.body);return b.action==='status'?{ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'inspect',validation_required:true,coverage_only:true,existing_element_read_candidates:['read'],paired_artifact_read_candidates:[]}}}:{ok:true,outcome:'complete'};
 }});
 assert.equal(result.state,'not_submitted','Missing real publication validator fails closed rather than trusting a response-shaped object');
 assert.equal(calls.filter(x=>x==='/api/assignments/v2/work-plan').length,0);
});
test('actual private wrapper normalizes existing Sidecar binding aliases and submits one command without delegate',async()=>{
 const f=fixture(),writes=[];
 const result=await wrapper(true)({host_visual_work_review:f.review},f.retained,{assertControl:async()=>{},readIdentity:async()=>f.cached,request:async(route,o)=>{
  if(o.method==='GET')return {snapshot:f.snapshot};const b=JSON.parse(o.body);assert.equal(b.run_id,'r');assert.equal(b.generation,1);
  if(b.action==='status')return {ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'inspect',validation_required:true,coverage_only:true,existing_element_read_candidates:['read'],paired_artifact_read_candidates:[]}}};
  writes.push(b);return {ok:true,outcome:'complete'};
 }});
 assert.equal(result.state,'submitted');assert.equal(writes.length,1);assert.equal(writes[0].expected_assignment_version,235);
});
test('a JSON result without the internal host result cannot request closeout',async()=>{
 const f=fixture();let calls=0;assert.equal(await wrapper()({output:JSON.stringify(f.review)},f.retained,{assertControl:async()=>calls++}),null);assert.equal(calls,0);
});
test('Pause/control failure prevents identity, native and command requests',async()=>{
 const f=fixture();let calls=0;const result=await wrapper()({host_visual_work_review:f.review},f.retained,{binding,
  assertControl:async()=>{throw Error('Pause');},readIdentity:async()=>{calls++;return f.cached;},request:async()=>calls++});
 assert.equal(result.state,'not_submitted');assert.equal(calls,0);
});
test('actual loop journals review before closeout, then uses existing outer canonical presenter without another model turn',()=>{
 const journal=source.indexOf('await journalSidecarComputerToolReceipt(functionReceipt,',source.indexOf('const retainedFunctionOutput = await retainFunctionEvidence'));
 const close=source.indexOf('await closeRetainedOwnerInspection(functionOutput,retainedFunctionOutput)',journal);
 assert(journal>0&&close>journal);assert.match(source.slice(journal,close),/functionReceiptJournaled=true/);
 assert.match(source.slice(close-130,close),/functionReceiptJournaled/);
 assert.match(source.slice(close,source.indexOf('const savedWorkReport =',close)),/'Final review matched/);
 assert.match(source,/completionPresentation\.retained_result_message\|\|finalText/);
});

test('actual unavailable-review wrapper consumes canonical budget stop with no native read, completion command or second provider',async()=>{
 const f=fixture();f.review={...f.review,ok:false,state:'unavailable',request:{},reviewer_response_id:null};
 f.snapshot={...f.snapshot,terminal:true,outcome:'blocked',terminal_reason:'provider_call_budget_exhausted'};
 let reads=0;
 const result=await wrapper(true)({host_visual_work_review:f.review},f.retained,{binding,
  assertControl:async()=>assertComputerDispatchSnapshot(f.snapshot,binding,null),
  readIdentity:async()=>{throw Error('No extra native inspection');},request:async(route,opts)=>{
   reads++;assert.equal(route,'/api/assignments/v2/a');assert.equal(opts.method,'GET');return {snapshot:f.snapshot};}});
 assert.equal(result.state,'canonical_stopped');assert.equal(reads,1);
 const begin=source.indexOf('if(reviewedInspectionHasTerminalResult(retainedFunctionOutput.post_review_closeout))');
 const end=source.indexOf('const savedWorkReport =',begin);let retained=0;
 const output=await runInNewContext('(async function(){'+source.slice(begin,end)+';return "continue";})()',{
  reviewedInspectionHasTerminalResult,retainedFunctionOutput:{post_review_closeout:result},computerState:{},response:{id:'saved-response'},
  toolOutputs:[],nativeRequest:()=>{},retainComputerProviderContext:async()=>retained++});
 assert.match(output,/Review could not finish/);assert.equal(retained,1);assert.doesNotMatch(output,/matched|complete|success/);
});

for(const [name,change] of Object.entries({
 'active task':s=>{s.terminal=false;s.outcome='active';},
 'foreign generation':s=>{s.current_binding={...binding,generation:2};},
 'unknown effect':s=>{s.unresolved_unknown_operation_ids=['unknown'];},
 'native operation in flight':s=>{s.in_flight_operation_ids=['write'];},
 'provider in flight':s=>{s.in_flight_provider_call_ids=['provider'];},
 'not quiescent':s=>{s.quiescent=false;}
}))test(`unavailable review does not turn ${name} into a terminal report`,async()=>{
 const f=fixture();f.review={...f.review,ok:false,state:'unavailable',request:{},reviewer_response_id:null};
 f.snapshot={...f.snapshot,terminal:true,outcome:'blocked',terminal_reason:'provider_call_budget_exhausted'};change(f.snapshot);
 let nativeReads=0,writes=0;
 const result=await wrapper(true)({host_visual_work_review:f.review},f.retained,{binding,
  assertControl:async()=>assertComputerDispatchSnapshot(f.snapshot,binding,null),
  readIdentity:async()=>{nativeReads++;return f.cached;},request:async(_route,opts)=>{
   if(opts.method!=='GET')writes++;return {snapshot:f.snapshot};}});
 assert.equal(reviewedInspectionHasTerminalResult(result),false);assert.equal(nativeReads,0);assert.equal(writes,0);
});

test('matched inspection still uses the real Pause admission before any read or command',async()=>{
 const f=fixture();f.snapshot.execution_control={state:'paused',command_id:'pause'};let reads=0;
 const result=await wrapper(true)({host_visual_work_review:f.review},f.retained,{binding,
  assertControl:async()=>assertComputerDispatchSnapshot(f.snapshot,binding,null),
  readIdentity:async()=>{reads++;return f.cached;},request:async()=>{reads++;}});
 assert.equal(result.state,'not_submitted');assert.equal(reads,0);
});

test('terminal observation rejects an owner replacement during the canonical read',async()=>{
 const f=fixture(),assignment={assignment_id:'a',session_id:'s',assignment_run_id:'r',assignment_generation:1};
 f.review={...f.review,ok:false,state:'unavailable',request:{},reviewer_response_id:null};
 f.snapshot={...f.snapshot,terminal:true,outcome:'blocked',terminal_reason:'provider_call_budget_exhausted'};
 const state={sidecarAssignment:assignment};
 const invoke=runInNewContext(source.slice(bindingStart,bindingEnd)+source.slice(start,end)+';closeRetainedOwnerInspection',{
  closeReviewedInspection,reviewStoppedAssignment,encodeURIComponent,computerState:state,
  sidecarAssignmentKernelPublicationFromResponse:p=>p,validateSidecarAssignmentKernelPublication:p=>p});
 const result=await invoke({host_visual_work_review:f.review},f.retained,{
  assertControl:async()=>{throw Error('No new action');},readIdentity:async()=>{throw Error('No native read');},
  request:async()=>{state.sidecarAssignment={...assignment};return {snapshot:f.snapshot};}});
 assert.equal(reviewedInspectionHasTerminalResult(result),false);
});

test('actual loop returns to canonical presentation for partial completion without another owner round',async()=>{
 const start=source.indexOf('if(reviewedInspectionHasTerminalResult(retainedFunctionOutput.post_review_closeout))');
 const end=source.indexOf('const savedWorkReport =',start);assert(start>0&&end>start);
 for(const outcome of ['complete','complete_with_issues','verified_noop','active','blocked','failed']){
  const computerState={},result={state:'submitted',outcome,whole_task_verified:false};
  let contextRetained=0;
  const output=await runInNewContext('(async function(){'+source.slice(start,end)+';return "continue";})()',{
   reviewedInspectionHasTerminalResult,retainedFunctionOutput:{post_review_closeout:result},computerState,response:{id:'current-response'},
   toolOutputs:[],nativeRequest:()=>{},retainComputerProviderContext:async()=>{contextRetained++;}});
  const ended=['complete','complete_with_issues','verified_noop'].includes(outcome);
  assert.equal(output,ended?'Final review matched. Checking the canonical saved result.':'continue');
  assert.equal(computerState.lastResponseId,ended?'current-response':undefined);assert.equal(result.outcome,outcome);
  assert.equal(contextRetained,ended?1:0,'retain the real async continuation boundary only when returning');
 }
});
