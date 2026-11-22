import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {projectDraftingPasses,type WorkPlanLocationRecordV2} from '../domain/assignment-kernel/work_plan_location.js';

export const DRAFTING_PASS_HANDOFF_ADVICE='A checked pass is not a completed area. Use the recorded remaining work and other open passes to choose the next useful discrepancy. Do not add a separate attempted entry merely to announce a pass switch or repeat an unchanged punch list. Keep the checked subset/pass intact and the parent open. Record a meaningful batch, a new discrepancy or blocker, or previously unrecorded remaining work before leaving the area; use locate with reuseLocation:true for unchanged framing. Use attempted for not-yet-drafted work and drafted only for work actually present. A blocked connection does not block independent annotations. Use the retained area and linked elements instead of rediscovering the whole sheet. Record only actual missing facts as blockers; successful execution alone never marks a pass checked.';

/** A small index of the actor's existing source-linked work, not another plan,
 * scheduler, completeness estimate, native observation or progress allowance.
 * Local corrections can be useful while whole-drawing coverage stands still. */
export function projectDraftingFrontier(snapshot:AssignmentSnapshotV2) {
 // Strict tasks have no advisory execution policy. This is a projection of
 // already-bound actor tracking, not permission to continue or a policy opt-in.
 // Preserve explicitly selected policies that do not request this handoff.
 if(snapshot.spec.requested_effect!=='apply'||(snapshot.spec.execution_policy!=null
   &&snapshot.spec.execution_policy.ready_work_handoff!=='continue_ready_work_v1')
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
 const latest=new Map<string,typeof records[number]>();
 const latestPass=new Map<string,typeof records[number]>();
 const checkedTargets=new Set<string>();
 let checkedScopes=0;
 let since=Date.parse(records[0]!.record.recorded_at);
 for(const row of records){
  latest.set(row.item.item_id,row);
  const r=row.record,d=r.drafting!,s=r.source!;
  latestPass.set(JSON.stringify([row.item.item_id,d.pass]),row);
  if(d.stage!=='checked')continue;
  // Moving the crop, splitting a subset or recoloring the same targets is
  // useful bookkeeping, but earns no new coverage window for this pass.
  const scope=[s.attachment_id,s.sha256,s.page,r.native!.view_id,d.pass];
  const keys=d.element_ids.length?d.element_ids.map(id=>JSON.stringify([...scope,id]))
   :[JSON.stringify([...scope,row.item.item_id])];
  if(keys.some(key=>!checkedTargets.has(key))){
   checkedScopes++;
   since=Math.max(since,Date.parse(r.recorded_at));
   keys.forEach(key=>checkedTargets.add(key));
  }
 }
 const calls=Object.values(snapshot.provider_calls).filter(c=>c.binding&&sameAssignmentBindingV2(c.binding,snapshot.current_binding)
  &&['admitted','dispatched','completed','failed'].includes(c.state)&&Number.isFinite(Date.parse(c.admitted_at))
  &&Date.parse(c.admitted_at)>since).length;
 const rows=[...latest.values()].sort((a,b)=>b.record.recorded_at.localeCompare(a.record.recorded_at)||a.item.item_id.localeCompare(b.item.item_id));
 const isOpen=(item:typeof rows[number]['item'])=>!item.completed_at&&!item.deferrals?.some(d=>!d.resumed_at);
 const short=(v:string,max=112)=>{let result='',bytes=0;for(const c of typeof v==='string'?v:''){
  bytes+=Buffer.byteLength(c,'utf8');if(bytes>max)break;result+=c;}return result;};
 const project=(row:typeof rows[number],maxText:number)=>{
  const r=row.record,d=r.drafting!,s=r.source!;
  const actionable=isOpen(row.item)&&(d.stage==='attempted'||d.stage==='drafted');
  return {item_id:row.item.item_id,recorded_at:r.recorded_at,source:{attachment_id:s.attachment_id,sha256:s.sha256,page:s.page,region:s.region},
   view_id:r.native!.view_id,pass:d.pass,stage:d.stage,remaining:short(d.remaining,maxText),
   ...(actionable?{next_action:short(d.next_action,maxText)}:{}),
   text_truncated:Buffer.byteLength(d.remaining,'utf8')>maxText||(actionable&&Buffer.byteLength(d.next_action,'utf8')>maxText)};
 };
 const focus=rows[0]!;
 const address=(r:WorkPlanLocationRecordV2)=>{
  const {attachment_id,sha256,page}=r.source!,region=r.source!.region!;
  return JSON.stringify([attachment_id,sha256,page,region.min_u,region.min_v,region.max_u,region.max_v,r.native!.view_id]);
 };
 const focusAddress=address(focus.record);
 const focusDrafting=focus.record.drafting!;
 // Retain other open passes in the same area. An earlier pass tied to obsolete
 // framing stays in history and must be reconciled before acting on it.
 const alternatives=[...latestPass.values()].filter(({item,record})=>isOpen(item)
  &&['attempted','drafted'].includes(record.drafting!.stage)
  &&address(record)===address(latest.get(item.item_id)!.record)
  &&(address(record)!==focusAddress||record.drafting!.pass!==focusDrafting.pass
   ||record.drafting!.element_ids.some(id=>!focusDrafting.element_ids.includes(id))))
  .sort((a,b)=>Number(address(a.record)===focusAddress)-Number(address(b.record)===focusAddress)
   ||a.record.recorded_at.localeCompare(b.record.recorded_at)||a.item.item_id.localeCompare(b.item.item_id));
 // A partial spatial journal must not hide the rest of the declared scope.
 // These are prose pointers only: no invented crop, element IDs or completion.
 const unlocated=snapshot.work_plan.items.filter(item=>!latest.has(item.item_id)&&isOpen(item));
 const declared=unlocated.slice(-3).map(item=>({item_id:item.item_id,
  description:short(item.description,112),source_basis:short(item.source_basis,112),
  text_truncated:Buffer.byteLength(item.description,'utf8')>112||Buffer.byteLength(item.source_basis,'utf8')>112,
  tracking_state:'unlocated' as const,projection_only:true}));
 const hold=snapshot.terminal||snapshot.outcome!=='active'?'task_not_active':snapshot.execution_control?.state==='paused'?'paused'
  :snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length||!snapshot.quiescent?'unsettled_model_effect'
  :snapshot.provider_usage_hold||snapshot.in_flight_provider_call_ids.length?'pending_usage'
  :snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length||snapshot.completion_proposal?'input_or_review_pending'
  :snapshot.provider_budget_exhausted||snapshot.progress_blocker?'resource_or_progress_hold':null;
 const result={schema:'operator.drafting-frontier.v1',advisory_only:true,complete:false,
  state:hold?'hold':calls>=12?'coverage_sweep_due':'working',hold_reason:hold,
  calls_since_new_checked_scope:calls,checked_scope_count:checkedScopes,recorded_region_count:rows.length,
  recent_focus:{...project(focus,112),passes:projectDraftingPasses({location_history:focus.item.location_history?.filter(valid)},snapshot)
   .map(p=>({pass:p.pass,stage:p.stage,needs_recheck:p.needs_recheck}))},
  other_recorded_regions:alternatives.slice(0,2).map(row=>project(row,80)),omitted_region_count:rows.length-1,
  declared_items_without_region_count:unlocated.length,declared_items_without_region:declared,
  omitted_declared_items_without_region_count:unlocated.length-declared.length,
  notice:'Actor tracking only; checked covers linked subset/pass, not an entire crop. Leave current checked work off your queue. Other recorded regions may include open passes in this crop. Unmarked source remains undiscovered. Unlocated declarations are not proof of missing model work; reconcile before editing.'};
 // Prefer an actionable source-linked pass over duplicate prose for a pointer
 // whose full scope is already available in the work plan.
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>3072&&result.other_recorded_regions.length){
  result.declared_items_without_region=declared.map(item=>({...item,
   description:short(item.description,40),source_basis:'',text_truncated:true}));
 }
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>3072&&result.other_recorded_regions.length&&result.declared_items_without_region.length>1){
  result.declared_items_without_region.shift();result.omitted_declared_items_without_region_count++;
 }
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>3072&&result.other_recorded_regions.length)result.other_recorded_regions.pop();
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>3072&&result.declared_items_without_region.length){result.declared_items_without_region.pop();result.omitted_declared_items_without_region_count++;}
 result.omitted_region_count=rows.length-new Set([focus.item.item_id,...result.other_recorded_regions.map(r=>r.item_id)]).size;
 return result;
}

export const DRAFTING_COVERAGE_SWEEP_ADVICE='Finish any nearly checked batch, then change area or pass. Compare whole-page context and readable source/model details. Prefer a coherent batch of missing physical routes, devices or annotations over repeated local refinement. Start with the other recorded regions if applicable. Reconcile unlocated declarations before editing; missing tracking is not missing model work. Reuse unchanged source images; do not reread or recapture merely to answer this reminder. Check the next batch together and retain the unresolved punch list. If a bounded sweep finds no independent work and no changed evidence or concrete approach for the stalled pass, preserve settled work when saving is authorized and report the checked partial, exact blocker, and what would unblock it. Required readback, review, admission and control checks still apply.';
