import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AssignmentSnapshotV2 } from '../src/domain/assignment-kernel/snapshot.js';
import { compactWorkReviewV2, projectWorkReviewV2, renderWorkReviewHandoffV2, workReviewRowsV2 } from '../src/assignments/work_review_handoff.js';
import { finalCodexAssignmentMessageV2 } from '../src/brains/codex_assignment_progress.js';
import {projectAdvisoryFollowupsV2} from '../src/assignments/advisory_followups_projection.js';
import { generateWorkReturnFromKernelV2 } from '../src/work_returns/assignment_kernel_v2_generator.js';
import { verifyWorkReturnHash } from '../src/work_returns/generator.js';
import { renderTerminalResultV2 } from '../src/assignments/assignment_kernel_v2_terminal_result.js';
const binding={assignment_id:'review-test',session_id:'session',run_id:'run',generation:1,document_fingerprint:'document'};
function replace(s: AssignmentSnapshotV2, index: number, patch: Record<string,unknown>) {
  s.work_plan={...s.work_plan!,items:s.work_plan!.items.map((item,i)=>i===index?{...item,...patch}:item)};
}
function fixture(): AssignmentSnapshotV2 {
  return {current_binding:binding,assignment_version:20,operations:{},observations:{},work_plan:{schema:'revit-operator.assignment-work-plan/v2',assumptions:[],
    items:Array.from({length:35},(_,i)=>({item_id:`item_${i}`,description:`Move outlet ${i} | keep circuit; inspect final location`,source_basis:`Original sheet redline ${i}`,declared_at:'2026-10-12T01:00:00Z',operation_ids:[],
      location_history:[{status:'candidate',reason:'Source location',verified:false,binding,recorded_at:'2026-10-12T01:00:01Z',source:{attachment_id:'source',filename:'Original.pdf',sha256:'a'.repeat(64),page:i+1,page_count:35,sheet_label:'E101',region:{min_u:.1,min_v:.2,max_u:.3,max_v:.4}}}]}))},
    work_plan_claims:[],unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],execution_failure_ids:[],pending_input_variable_ids:[],
    outcome:'awaiting_user_review',quiescent:true,terminal:false,spec:{requested_effect:'apply'},
    completion_proposal:{claimed_completed:['An agent report; not a native certificate.'],remaining_work:['Older unresolved item; do not forget it.'],uncertainties:[],verified:false},
    advisory_followups:[{item_id:'followup:9',kind:'remaining_work',text:'Retained older unresolved report.',source_version:9,source_field:'remaining_work',source_index:0,last_mentioned_version:9,version:9,state:'open',verified:false}]
  } as unknown as AssignmentSnapshotV2;
}

test('blocked canonical returns and terminal text retain scoped questions without supplying inputs or certifying work',()=>{
 const s=fixture();s.terminal=true;s.outcome='blocked';s.terminal_reason='token_budget_exhausted';
 s.spec={...s.spec,criteria:[]};s.criteria={};s.clarifications={};s.execution_failures={};delete s.completion_proposal;
 replace(s,0,{deferrals:[{reason:'No approved design setpoint or load. What heating design governs the stairs?',deferred_at:'2026-10-21T01:00:00Z'}]});
 replace(s,1,{deferrals:[{reason:'Internal native verification unavailable; this is not an engineer input.',deferred_at:'2026-10-21T01:01:00Z'}]});
 const before=JSON.stringify(s),goal={id:s.current_binding.assignment_id,updated_at:'2026-10-21T01:02:00Z'} as any;
 const result=generateWorkReturnFromKernelV2(goal,s,null,null);
 assert.equal(result.status,'blocked');assert.equal(result.question,null);assert.equal(result.clarification_id,null);
 assert.deepEqual(result.completed,[]);assert(verifyWorkReturnHash(result));
 assert.match(result.deviations_or_open_items[0]!,/Q1.*page 1.*What heating design/s);
 assert.match(result.deviations_or_open_items[1]!,/Q2.*not an engineer input/s);
 const terminal=renderTerminalResultV2(s);assert.match(terminal,/did not complete: token budget exhausted/);
 assert.match(terminal,/Q1.*What heating design/s);assert.match(terminal,/Q2.*not an engineer input/s);
 assert.equal(JSON.stringify(s),before);assert.deepEqual(generateWorkReturnFromKernelV2(goal,JSON.parse(before),null,null),result);
 const altered={...result,deviations_or_open_items:[]};assert.equal(verifyWorkReturnHash(altered),false);
});
test('source checklist, stable questions and bounded summary survive restart without mutating canonical work',()=>{
  const s=fixture();replace(s,2,{deferrals:[{reason:'Which wall should receive this outlet? Preserve the circuit.',deferred_at:'2026-10-12T02:00:00Z'}]});
  replace(s,34,{deferrals:[{reason:'Architect coordination remains outside this assignment.',deferred_at:'2026-10-12T02:00:00Z'}]});
  const before=JSON.stringify(s), review=projectWorkReviewV2(s), handoff=finalCodexAssignmentMessageV2(s,'All complete.');
  assert.deepEqual(review.counts,{checked:0,reported_unverified:0,partial:0,deferred:2,not_completed:33,outcome_unknown:0,settling:0});
  const summary=handoff.split('## Details')[0]!;assert(summary.length<2500);assert.match(summary,/Q3.*E101 · page 3/);assert.match(summary,/Q35.*page 35/);
  assert.match(handoff,/Retained older unresolved report/);assert.match(handoff,/Older unresolved item; do not forget it/);
  assert.match(handoff,/R35/);assert.doesNotMatch(summary,/All complete|verified complete/);
  assert.equal(JSON.stringify(s),before);assert.equal(finalCodexAssignmentMessageV2(JSON.parse(before),'All complete.'),handoff);
  const pages:ReturnType<typeof workReviewRowsV2>=[];let start:number|null=0;while(start!==null){const page:ReturnType<typeof projectWorkReviewV2>['page']=projectWorkReviewV2(s,start).page;assert(page.items.length);pages.push(...page.items);start=page.next_start;}
  assert.equal(pages.length,35);assert.equal(new Set(pages.map(row=>row.item_id)).size,35);
  assert.equal(pages[2]!.location!.source!.sha256,'a'.repeat(64));assert.deepEqual(pages[2]!.location!.source!.region,{min_u:.1,min_v:.2,max_u:.3,max_v:.4});
  assert.throws(()=>projectWorkReviewV2(s,-1),/page_invalid/);
});
test('claims, changed deferrals, uncertain outcomes and incomplete receipts never become checked edits',()=>{
  const s=fixture();s.work_plan_claims=[{item_id:'item_0',operation_ids:['applied'],claimed_at:'2026-10-12T02:00:00Z',verified:false}];
  s.operations={applied:{operation_id:'applied',binding,target:{target_id:'id:42'},requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',verification_operation_ids:[]}} as any;
  assert.equal(workReviewRowsV2(s)[0]!.status,'reported_unverified');assert.equal(workReviewRowsV2(s)[0]!.applied_operation_count,1);
  replace(s,0,{deferrals:[{reason:'Need destination.',prior_claim_count:1,deferred_at:'2026-10-12T03:00:00Z',resumed_at:'2026-10-12T04:00:00Z'}]});
  assert.equal(workReviewRowsV2(s)[0]!.status,'partial','a pre-deferral claim is not current completion');
  replace(s,0,{operation_ids:['applied'],completed_at:'2026-10-12T05:00:00Z'});
  assert.equal(workReviewRowsV2(s)[0]!.status,'partial','completed_at without independent proof is insufficient');
  s.unresolved_unknown_operation_ids=['applied'];assert.equal(workReviewRowsV2(s)[0]!.status,'outcome_unknown');
  assert.doesNotMatch(finalCodexAssignmentMessageV2(s,'Everything complete'),/Review:|Sheet checklist|Ready for review/);
  s.unresolved_unknown_operation_ids=[];s.in_flight_operation_ids=['applied'];s.quiescent=false;
  assert.equal(workReviewRowsV2(s)[0]!.status,'settling');assert.match(finalCodexAssignmentMessageV2(s,''),/settling/);
});

test('legacy source labels stay hints; retained open reports stay visible without worker deferral',()=>{
  const s=fixture();replace(s,0,{location_history:undefined,source_basis:'PDF p4 E010 MAIN1 current rating'});
  const row=workReviewRowsV2(s)[0]!;assert.match(row.address,/E010 · page 4 \(saved note\)/);assert.equal(row.location,null);
  s.advisory_followups=[{item_id:'followup:42:remaining_work:0',kind:'remaining_work',text:'Source sheet E100: EV charging needs owner and architect coordination.',source_version:42,source_field:'remaining_work',source_index:0,last_mentioned_version:42,version:42,state:'open',verified:false}];
  const before=JSON.stringify(s),first=renderWorkReviewHandoffV2(s)!;
  assert.match(first.summary,/QF1.*E100.*EV charging/);assert.match(first.summary,/0 individual edits checked/);
  assert.equal(JSON.stringify(s),before);
  assert.equal(projectAdvisoryFollowupsV2(s).items[0]!.question_ref,'QF1','agent status exposes the same reply reference as the human handoff');
  s.advisory_followups=[...s.advisory_followups,{...s.advisory_followups[0]!,item_id:'followup:42:remaining_work:1',source_index:1,text:'Source sheet E101: choose the destination wall.'}];
  s.advisory_followups=[{...s.advisory_followups[0]!,state:'resolved'},s.advisory_followups[1]!];assert.doesNotMatch(renderWorkReviewHandoffV2(s)!.summary,/QF1/);
  assert.equal(projectAdvisoryFollowupsV2(s).items[0]!.question_ref,'QF2','closing earlier reports never renumbers pending replies');
  const compact=compactWorkReviewV2(s);assert.equal(Object.hasOwn(compact,'page'),false);assert.equal(compact.total,35);
  assert(Buffer.byteLength(JSON.stringify(compact))<1800);assert.doesNotMatch(JSON.stringify(compact),/Original\.pdf|source_basis|region/);
});
test('actual shared conversation renderer keeps all checklist details closed and source text inert',async()=>{
  const root=['../packages/operator-assistant-ui','../../packages/operator-assistant-ui'].map(p=>path.resolve(p)).find(p=>fs.existsSync(path.join(p,'conversation_ui.mjs')))!;
  const ui=await import(pathToFileURL(path.join(root,'conversation_ui.mjs')).href);
  const document:any={createTextNode:(text:string)=>({tag:'text',textContent:text}),createElement:(tag:string)=>({tag,children:[] as any[],ownerDocument:document,textContent:'',appendChild(n:any){this.children.push(n);},replaceChildren(){this.children=[];}})};
  const s=fixture();replace(s,0,{description:'<img onerror=run()> | \n ## Details'});
  const output=finalCodexAssignmentMessageV2(s,''), container=document.createElement('div');ui.renderAssistantBlocks(container,output);
  const flatten=(n:any):any[]=>[n,...(n.children??[]).flatMap(flatten)];const nodes=flatten(container);
  assert.equal(nodes.filter(n=>n.tag==='details').length,1);assert.equal(nodes.some(n=>n.tag==='img'),false);
  const details=nodes.find(n=>n.tag==='details');assert.equal(details.open,undefined);assert(flatten(details).some(n=>n.textContent?.includes('R35')));
  const visible=container.children.filter((n:any)=>n.tag!=='details');assert(flatten({children:visible}).filter(n=>n.tag==='tr').length===7);
  assert.equal(renderWorkReviewHandoffV2({...s,work_plan:undefined}),null);
});

test('explicit repeated question references group in summary while retaining all wording and stable aliases',()=>{
  const s=fixture();replace(s,2,{deferrals:[{reason:'Q3 — Architect/owner: Is EV charging or future EV-ready provision required?',deferred_at:'2026-10-12T02:00:00Z'}]});
  const base=s.advisory_followups![0]!;
  s.advisory_followups=[
    {...base,item_id:'repeat',text:'Q3 — Owner/architect decision remains open: confirm initial/future port count and charging power.'},
    {...base,item_id:'similar',text:'EV charging requires a separate electrical capacity check.'},
    {...base,item_id:'not_found',text:'Q99 — Confirm another design decision.'}
  ];
  const before=JSON.stringify(s), result=renderWorkReviewHandoffV2(s)!;
  assert.match(result.summary,/Q3 · E101 · page 3/);
  assert.doesNotMatch(result.summary,/QF1|Owner\/architect decision remains open/);
  assert.match(result.summary,/QF2.*separate electrical capacity check/);
  assert.match(result.summary,/QF3.*Q99/,'unknown reference must not disappear');
  assert.match(result.details,/QF1 \(also Q3\) · E101 · page 3.*initial\/future port count/);
  assert.equal(JSON.stringify(s),before,'presentation never resolves or deletes retained reports');
  assert.equal(projectAdvisoryFollowupsV2(s).items[0]!.question_ref,'QF1');
  replace(s,2,{deferrals:undefined});
  assert.match(renderWorkReviewHandoffV2(s)!.summary,/QF1.*Owner\/architect decision remains open/,'without parent the original report stays up front');
});

test('saved page-sheet hints and explicit technical followups do not masquerade as engineering questions',async()=>{
 const s=fixture(); s.work_plan={...s.work_plan!,items:s.work_plan!.items.slice(0,3)};
 replace(s,0,{location_history:[],source_basis:'Sample.pdf SHA256 '+ 'a'.repeat(64)+' p4 M100 garage question; p3 M002 supporting schedule.',deferrals:[{reason:'What approved garage exhaust design basis should govern?',deferred_at:'2026-10-21T01:00:00Z'}]});
 replace(s,1,{location_history:[],source_basis:'Same source p7 M103 detail crop: target vent.',deferrals:[{reason:'Technical handoff, not engineering question: native leader correction remains operator work.',deferred_at:'2026-10-21T01:00:00Z'}]});
 replace(s,2,{location_history:[],source_basis:'Source unresolved; equipment P01, operation123 and arbitrary model M999.',deferrals:[{reason:'Needs review; no explicit classification retained.',deferred_at:'2026-10-21T01:00:00Z'}]});
 s.terminal=true;s.outcome='blocked';s.terminal_reason='token_budget_exhausted';
 s.spec={...s.spec,criteria:[]};s.criteria={};s.clarifications={};s.execution_failures={};delete s.completion_proposal;s.advisory_followups=[];
 const before=JSON.stringify(s),rows=workReviewRowsV2(s),text=renderWorkReviewHandoffV2(s)!;
 assert.equal(rows[0]!.address,'M100 · page 4 (saved note)');
 assert.equal(rows[1]!.address,'M103 · page 7 (saved note)');
 assert.equal(rows[2]!.address,'Location not recorded','do not infer source location from equipment, arbitrary numbers or model labels');
 assert.equal(rows[0]!.question_ref,'Q1');assert.equal(rows[1]!.question_ref,'Q2','stable references do not change');
 assert.equal(rows[1]!.followup_kind,'operator_technical');assert.equal(rows[2]!.followup_kind,'open_item');
 assert.match(text.details,/Operator follow-up Q2.*native leader correction/s);
 assert.match(text.details,/Q1.*approved garage exhaust/);
 assert.doesNotMatch(text.summary,/Questions and open items|more questions in Details/);
 const result=generateWorkReturnFromKernelV2({id:binding.assignment_id,updated_at:'2026-10-21T01:02:00Z'} as any,s,null,null);
 assert.equal(result.status,'blocked');assert.equal(result.question,null);assert.equal(result.clarification_id,null);
 assert.deepEqual(result.completed,[]);assert(verifyWorkReturnHash(result));
 assert.match(result.deviations_or_open_items[1]!,/^Operator follow-up Q2 · M103 · page 7 \(saved note\)/);
 const root=['../packages/operator-assistant-ui','../../packages/operator-assistant-ui'].map(p=>path.resolve(p)).find(p=>fs.existsSync(path.join(p,'stopped_work_return.mjs')))!;
 const ui=await import(pathToFileURL(path.join(root,'stopped_work_return.mjs')).href);
 const shown=ui.stoppedWorkReturnMessage({kernel_version:2,work_return:result},{kernel_version:2,goal_id:binding.assignment_id,run_id:binding.run_id,generation:1});
 assert.match(shown,/Operator follow-up Q2 · M103 · page 7/);assert.match(shown,/only actual engineering decisions need your answer/);
 assert.equal(JSON.stringify(s),before,'presentation does not mutate decisions, status, deferrals, observations or scope');
});

test('technical-only handoff does not ask the engineer to repair internal tools',()=>{
 const s=fixture();delete s.completion_proposal;s.advisory_followups=[];
 s.work_plan={...s.work_plan!,items:s.work_plan!.items.slice(0,1)};
 replace(s,0,{deferrals:[{reason:'Technical handoff, not engineering question: retained verification is unresolved.',deferred_at:'2026-10-21T01:00:00Z'}]});
 const text=renderWorkReviewHandoffV2(s)!;
 assert.match(text.summary,/Operator follow-up Q1/);
 assert.doesNotMatch(text.summary,/Reply using the question reference/);
 assert.match(text.summary,/Internal tool follow-ups remain Operator work/);
 assert.equal(workReviewRowsV2(s)[0]!.status,'deferred');
});

test('technical-looking wording alone does not classify decisions or establish native source authority',()=>{
 const s=fixture();s.work_plan={...s.work_plan!,items:s.work_plan!.items.slice(0,2)};
 replace(s,0,{location_history:[],source_basis:'Unresolved equipment P4 M999; model view M202.',deferrals:[{reason:'Technical handoff: which electrical supply voltage should the engineer choose?',deferred_at:'2026-10-21T01:00:00Z'}]});
 replace(s,1,{source_basis:'Legacy p7 M103, but structured source stays primary.',deferrals:[{reason:'Technical blocker, not an engineering question: native readback unavailable.',deferred_at:'2026-10-21T01:00:00Z'}]});
 const rows=workReviewRowsV2(s);
 assert.equal(rows[0]!.address,'Location not recorded');assert.equal(rows[0]!.followup_kind,'open_item');
 assert.equal(rows[1]!.address,'E101 · page 2');assert.equal(rows[1]!.followup_kind,'operator_technical');
 assert.equal(rows[0]!.location,null,'legacy text does not invent a bound source or target');
 assert.equal(rows[1]!.location!.source!.attachment_id,'source');
});

test('an existing explicit primary PDF address is not replaced by an adjacent supporting reference',()=>{
 const s=fixture();s.work_plan={...s.work_plan!,items:s.work_plan!.items.slice(0,1)};
 replace(s,0,{location_history:[],source_basis:'PDF page 2; source sheet M101. Supporting detail p7 M103.',description:'Inspect the original marked subject.'});
 assert.equal(workReviewRowsV2(s)[0]!.address,'M101 · page 2 (saved note)');
});
