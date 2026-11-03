import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {projectDraftingPasses,type WorkPlanLocationRecordV2} from '../domain/assignment-kernel/work_plan_location.js';

/** A small index of the actor's existing source-linked work, not another plan,
 * scheduler, completeness estimate, native observation or progress allowance.
 * Local corrections can be useful while whole-drawing coverage stands still. */
export function projectDraftingFrontier(snapshot:AssignmentSnapshotV2) {
 if(snapshot.spec.requested_effect!=='apply'||snapshot.spec.execution_policy?.ready_work_handoff!=='continue_ready_work_v1'
   ||!snapshot.current_binding?.document_fingerprint||!snapshot.work_plan?.items.length)return null;
 const valid=(r:WorkPlanLocationRecordV2)=>{
  const s=r.source,n=r.native,g=s?.region;
  const d=r.drafting;
  return !!d&&Array.isArray(d.element_ids)&&d.element_ids.every(id=>Number.isSafeInteger(id)&&id>0)
   &&['geometry','sizes_properties','connections','elevation','annotations','coverage'].includes(d.pass)
   &&['attempted','drafted','checked','blocked'].includes(d.stage)
   &&typeof d.remaining==='string'&&typeof d.next_action==='string'
   &&!!r.binding&&sameAssignmentBindingV2(r.binding,snapshot.current_binding)
   &&n?.document_fingerprint===snapshot.current_binding.document_fingerprint&&Number.isSafeInteger(n?.view_id)&&n!.view_id>0
   &&!!s&&typeof s.attachment_id==='string'&&Buffer.byteLength(s.attachment_id,'utf8')<=240
   &&/^[a-f0-9]{64}$/i.test(s.sha256)&&Number.isSafeInteger(s.page)&&s.page>0&&s.page<=s.page_count
   &&!!g&&[g.min_u,g.min_v,g.max_u,g.max_v].every(x=>Number.isFinite(x)&&x>=0&&x<=1)
   &&g.min_u<g.max_u&&g.min_v<g.max_v&&Number.isFinite(Date.parse(r.recorded_at));
 };
 const records=snapshot.work_plan.items.flatMap(item=>(item.location_history??[]).filter(valid).map(record=>({item,record})))
  .sort((a,b)=>a.record.recorded_at.localeCompare(b.record.recorded_at)||a.item.item_id.localeCompare(b.item.item_id));
 if(!records.length)return null;
 const latest=new Map<string,typeof records[number]>(),seenChecked=new Set<string>();
 let since=Date.parse(records[0]!.record.recorded_at);
 for(const row of records){
  latest.set(row.item.item_id,row);
  const r=row.record,d=r.drafting!,s=r.source!;
  // New images/reads/timestamps for the same checked subset do not buy another
  // coverage window. Intent verification and recheck currentness stay separate.
  const key=JSON.stringify([s.attachment_id,s.sha256,s.page,s.region,r.native!.view_id,d.pass,[...d.element_ids].sort((a,b)=>a-b)]);
  if(d.stage==='checked'&&!seenChecked.has(key)){seenChecked.add(key);since=Math.max(since,Date.parse(r.recorded_at));}
 }
 const calls=Object.values(snapshot.provider_calls).filter(c=>c.binding&&sameAssignmentBindingV2(c.binding,snapshot.current_binding)
  &&['admitted','dispatched','completed','failed'].includes(c.state)&&Number.isFinite(Date.parse(c.admitted_at))
  &&Date.parse(c.admitted_at)>since).length;
 const rows=[...latest.values()].sort((a,b)=>b.record.recorded_at.localeCompare(a.record.recorded_at)||a.item.item_id.localeCompare(b.item.item_id));
 const short=(v:string,max=112)=>{let result='',bytes=0;for(const c of typeof v==='string'?v:''){
  bytes+=Buffer.byteLength(c,'utf8');if(bytes>max)break;result+=c;}return result;};
 const project=(row:typeof rows[number])=>{
  const r=row.record,d=r.drafting!,s=r.source!;
  return {item_id:row.item.item_id,recorded_at:r.recorded_at,source:{attachment_id:s.attachment_id,sha256:s.sha256,page:s.page,region:s.region},
   view_id:r.native!.view_id,pass:d.pass,stage:d.stage,remaining:short(d.remaining),next_action:short(d.next_action),
   text_truncated:Buffer.byteLength(d.remaining,'utf8')>112||Buffer.byteLength(d.next_action,'utf8')>112,
   passes:projectDraftingPasses({location_history:row.item.location_history?.filter(valid)},snapshot)
    .map(p=>({pass:p.pass,stage:p.stage,needs_recheck:p.needs_recheck}))};
 };
 const focus=rows[0]!;
 // The alternate pointers are deliberately oldest first. Recent-only recovery
 // otherwise keeps surfacing the same refinement even with older work open.
 const others=rows.filter(r=>r.item.item_id!==focus.item.item_id).reverse().slice(0,2).map(project);
 const hold=snapshot.terminal||snapshot.outcome!=='active'?'task_not_active':snapshot.execution_control?.state==='paused'?'paused'
  :snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length||!snapshot.quiescent?'unsettled_model_effect'
  :snapshot.provider_usage_hold||snapshot.in_flight_provider_call_ids.length?'pending_usage'
  :snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length||snapshot.completion_proposal?'input_or_review_pending'
  :snapshot.provider_budget_exhausted||snapshot.progress_blocker?'resource_or_progress_hold':null;
 const result={schema:'operator.drafting-frontier.v1',advisory_only:true,complete:false,
  state:hold?'hold':calls>=12?'coverage_sweep_due':'working',hold_reason:hold,
  calls_since_new_checked_scope:calls,checked_scope_count:seenChecked.size,recorded_region_count:rows.length,
  recent_focus:project(focus),other_recorded_regions:others,
  omitted_region_count:Math.max(0,rows.length-1-others.length),
  notice:'Actor tracking only; checked covers linked subset/pass, not an entire crop. Unmarked source remains undiscovered. Retained records are not fresh pixels or native proof. No allowance, permission or completion changes.'};
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>3072&&result.other_recorded_regions.length){result.other_recorded_regions.pop();result.omitted_region_count++;}
 return result;
}

export const DRAFTING_COVERAGE_SWEEP_ADVICE='Your recent work has not added a new checked source-linked scope. Keep useful local work and its exact unresolved connection/label punch list; do not claim it complete. Compare whole-page context and readable source/model details, then choose another clear independent missing branch, recognizable device or annotation pass. Reuse admitted unchanged source/overview images; do not reread or recapture merely to answer this reminder. A coverage sweep identifies remaining work, not completed construction. A difficult local junction must not indefinitely block coverage elsewhere. Return to it with changed evidence or a concrete supported approach. This is coverage pacing advice, not a demand to abandon a nearly finished useful batch or permission to skip checks.';
