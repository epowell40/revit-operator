// Display canonical actor tracking without changing completion or admission.
// Historical backchecks are not proof of the current model state.
export function advisoryWorkPlanDisplay(snapshot) {
  if(snapshot.spec?.execution_policy?.mode!=='single_actor_review_v1')return null;
  if(!snapshot.work_plan?.items?.length)return snapshot.outcome==='awaiting_user_review' && snapshot.quiescent===true
    && !snapshot.unresolved_unknown_operation_ids?.length && snapshot.execution_control?.state!=='paused'
    ? {progress:{basis:'review_handoff',determinate:false,total:0,completed:0,ratio:null}} : null;
  const items=snapshot.work_plan.items.map(item=>{
    const deferral=item.deferrals?.at(-1),blocked=Boolean(deferral&&!deferral.resumed_at);
    const claims=(snapshot.work_plan_claims??[]).filter(c=>c.item_id===item.item_id);
    const reported=!blocked&&(deferral
      ?deferral.prior_claim_count!==undefined?claims.length>deferral.prior_claim_count:claims.some(c=>Date.parse(c.claimed_at)>Date.parse(deferral.resumed_at??deferral.deferred_at))
      :claims.length>0);
    const drafting=item.location_history?.at(-1)?.drafting;
    return {id:item.item_id,title:item.description,status:blocked?'blocked':reported?'reported_complete':item.operation_ids?.length?'in_progress':'pending',
      depends_on:item.depends_on??[],result_summary:drafting?`Last actor backcheck: ${drafting.pass} — ${drafting.stage}. Not independent verification.`:null,
      actor_checked:!blocked&&drafting?.stage==='checked'};
  });
  return {items,progress:{basis:'actor_work_plan',determinate:false,total:items.length,
    reported:items.filter(i=>i.status==='reported_complete').length,checked:items.filter(i=>i.actor_checked).length,completed:0,ratio:null}};
}
