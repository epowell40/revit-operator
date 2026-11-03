// Host adapter for an explicitly requested checklist command, not a second
// completion controller. The backend still retains native coverage, evaluates
// criteria and derives/settles the outcome. No native action or model call here.
const sameBinding=(a,b)=>['assignment_id','session_id','run_id','generation'].every(k=>a?.[k]!==undefined&&a[k]===b?.[k]);
const sceneKeys=['process_id','document_session_id','epoch','through_sequence','view_id'];
const no=(reason)=>({state:'not_submitted',reason,native_postcondition_verified:false,whole_task_verified:false});
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(v);
const deferred=i=>Boolean(i.deferrals?.at(-1)&&!i.deferrals.at(-1).resumed_at);
const readySnapshot=(s,binding)=>Boolean(s&&sameBinding(s.current_binding,binding)&&!s.terminal&&s.outcome==='active'&&s.quiescent===true
 &&Number.isSafeInteger(s.assignment_version)&&s.assignment_version>0&&s.spec?.work_plan_required===true
 &&s.execution_control?.state!=='paused'&&!s.provider_usage_hold&&!s.progress_blocker&&!s.provider_budget_exhausted&&!s.completion_proposal
 &&['in_flight_operation_ids','in_flight_provider_call_ids','unresolved_unknown_operation_ids','pending_input_variable_ids','pending_review_ids','execution_failure_ids'].every(k=>Array.isArray(s[k])&&!s[k].length));

// Stop the execution turn only after the existing backend command reports a
// terminal result. The normal canonical presenter still owns the final answer;
// a partial disposition must not become an optimistic full-success message.
export const reviewedInspectionHasTerminalResult=result=>Boolean(result?.state==='submitted'
 &&['complete','complete_with_issues','verified_noop'].includes(result.outcome));

// An independently deferred, unperformed design item must stay unfinished, but
// must not prevent inspecting the completed edits. This only permits an
// existing inspection command; the backend still validates evidence and derives
// the incomplete outcome. Never cross a deferred dependency or hide a partial
// item's effects, a deferred inspection, or active work.
const inspectionQueueReady=(items,itemId)=>{
 if(!Array.isArray(items))return false;
 const item=items.find(i=>i.item_id===itemId);
 if(item?.kind!=='inspection'||item.completed_at||deferred(item))return false;
 const dependencies=new Set(),visiting=new Set();
 const visit=id=>{
  if(visiting.has(id))return false;
  if(dependencies.has(id))return true;
  const node=items.find(i=>i.item_id===id);if(!node)return false;
  visiting.add(id);
  if(node.depends_on!==undefined&&(!Array.isArray(node.depends_on)||!node.depends_on.every(visit)))return false;
  visiting.delete(id);dependencies.add(id);return true;
 };
 if(!visit(itemId))return false;
 return items.every(i=>i.item_id===itemId||(i.completed_at&&!deferred(i))
  // The canonical declaration retains omitted kind as the default edit kind.
  // Match that contract exactly; null and unknown explicit kinds stay refused.
  ||((i.kind===undefined||i.kind==='edit')&&deferred(i)&&!dependencies.has(i.item_id)&&Array.isArray(i.operation_ids)&&i.operation_ids.length===0
   &&typeof i.deferrals.at(-1).reason==='string'&&i.deferrals.at(-1).reason.trim().length>0
   &&Number.isFinite(Date.parse(i.deferrals.at(-1).deferred_at))));
};

/** Read-only preparation for the explicit focus+final-review request. This
 * selects no new authority and completes nothing: the existing post-review
 * command still validates actual native coverage and current version. */
export async function prepareFocusedInspection({binding,itemId,focusElementIds,readSnapshot,request}){
 if(!validId(itemId)||!Array.isArray(focusElementIds)||!focusElementIds.length||focusElementIds.length>200
  ||focusElementIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(focusElementIds).size!==focusElementIds.length)return no('focus_request_invalid');
 try{
  const s=await readSnapshot();if(!readySnapshot(s,binding))return no('assignment_not_ready');
  const items=s.work_plan?.items;
  if(!inspectionQueueReady(items,itemId))return no('other_work_or_inspection_pending');
  const status=await request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({...binding,action:'status'})});
  const p=status?.work_plan?.next_native_inspection,ids=p?.existing_element_read_candidates;
  if(status?.ok!==true||status.verification_policy!=='strict'||p?.item_id!==itemId||p.validation_required!==true||p.coverage_only!==true
   ||!Array.isArray(ids)||!ids.length||ids.length>4||ids.some(id=>!validId(id)||s.operations?.[id]?.requested_effect!=='read'))return no('native_inspection_candidate_unavailable');
  const targets=p.required_target_ids;
  const elementTargets=Array.isArray(targets)?targets.filter(t=>typeof t==='string'&&/^element_id:[1-9][0-9]*$/.test(t)):[];
  if(!Array.isArray(targets)||targets.length>128||!elementTargets.length)return no('focus_excludes_inspection_targets');
  // Navigation frames this visual region, not every native dependency. A
  // multi-sheet inspection may also cover hidden parameters and other views.
  // Require a relevant target (neighbors may accompany it); the unchanged
  // post-review command still validates ALL dependency reads and file proof.
  if(!elementTargets.some(t=>focusElementIds.includes(Number(t.slice(11)))))return {...no('focus_excludes_inspection_targets'),
   required_focus_element_ids:elementTargets.map(t=>Number(t.slice(11))),
   guidance:'Include at least one native inspection target relevant to this visual region in focus_element_ids, plus needed neighbors. This list is the full native inspection scope, not a requirement to show every item together. For a schedule definition on a sheet, existing native navigation resolves only its unique actual placement. Do not substitute placed-instance IDs for inspection targets. All dependency readback remains required; navigation verifies nothing.'};
  return {state:'prepared',item_id:itemId,assignment_version:s.assignment_version,native_postcondition_verified:false,whole_task_verified:false};
 }catch{return no('inspection_preparation_unavailable');}
}

/** Only the owner host calls this with its actual in-memory review result AFTER
 * retaining that result. An arbitrary stored object/source label is not review
 * authority. This adapter is deliberately absent from the model tool surface. */
export async function closeReviewedInspection({binding,review,evidenceRef,currentScene,readSnapshot,request,now=Date.now()}) {
 const itemId=review?.request?.complete_inspection_item_id;
 if(!validId(itemId))return no('explicit_inspection_not_requested');
 if(review?.schema!=='operator.visual_work_review.v1'||review.authority!=='supporting_visual_assessment'
   ||review.ok!==true||review.state!=='matched'||review.native_postcondition_verified!==false||review.whole_task_verified!==false
   ||!sameBinding(review.owner,binding)||!validId(review.reviewer_response_id))return no('review_not_current_matched');
 const wanted=review.request.checks,actual=review.checks;
 if(!Array.isArray(wanted)||!wanted.length||wanted.length>8||!Array.isArray(actual)||wanted.length!==actual.length
   ||new Set(wanted.map(c=>c.id)).size!==wanted.length||new Set(actual.map(c=>c.id)).size!==actual.length
   ||wanted.some(c=>!validId(c.id)||!actual.some(a=>a.id===c.id&&a.status==='matched')))return no('review_checks_incomplete');
 const retainedAt=Date.parse(evidenceRef?.created_at_utc);
 if(evidenceRef?.schema!=='revit-operator.evidence-ref.v1'||!sameBinding(evidenceRef,binding)
   ||evidenceRef.source!=='operator_desktop.function.review_current_work'||!validId(evidenceRef.evidence_id)
   ||!/^sha256:[a-f0-9]{64}$/.test(evidenceRef.content_hash)||!Number.isSafeInteger(evidenceRef.byte_count)||evidenceRef.byte_count<1
   ||!Number.isFinite(retainedAt)||!Number.isFinite(now)||now-retainedAt>300000||retainedAt>now+5000)return no('review_retention_unavailable_or_stale');
 if(!sceneKeys.every(k=>review.location?.[k]!==undefined&&review.location[k]===currentScene?.[k])
   ||review.request.view_id!==review.location.view_id)return no('native_scene_changed');
 try {
  const s=await readSnapshot();
  if(!readySnapshot(s,binding))return no('assignment_not_ready');
  const items=s.work_plan?.items;
  if(!inspectionQueueReady(items,itemId))return no('other_work_or_inspection_pending');
  if(Object.values(s.operations??{}).some(o=>o.requested_effect==='apply'
    &&(!Number.isFinite(Date.parse(o.result?.completed_at))||Date.parse(o.result.completed_at)>retainedAt)))return no('intervening_or_unsettled_write');
  const status=await request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({...binding,action:'status'})});
  const p=status?.work_plan?.next_native_inspection;
  if(status?.ok!==true||status.verification_policy!=='strict'||p?.item_id!==itemId||p.validation_required!==true||p.coverage_only!==true)return no('native_inspection_candidate_unavailable');
  const ids=[...new Set([...(p.existing_element_read_candidates??[]),...(p.paired_artifact_read_candidates??[])])];
  if(!ids.length||ids.length>8||ids.some(id=>!validId(id)||!s.operations[id]||s.operations[id].requested_effect!=='read'))return no('native_inspection_candidate_unavailable');
  const result=await request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({...binding,action:'complete',
    item_id:itemId,operation_ids:ids,expected_assignment_version:s.assignment_version})});
  if(result?.ok!==true)return no('existing_command_refused');
  return {state:'submitted',item_id:itemId,operation_ids:ids,review_evidence_id:evidenceRef.evidence_id,
    outcome:result.outcome,native_postcondition_verified:false,whole_task_verified:false,
    guidance:'Existing native inspection command submitted. Canonical criteria/terminal result and delivery remain authoritative; this visual receipt is not native or whole-task proof.'};
 }catch{return no('existing_command_refused');}
}
