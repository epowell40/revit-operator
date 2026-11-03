import { inspectionIsCurrentV2, workPlanItemDeferredV2 } from "../domain/assignment-kernel/work_plan.js";
import { projectCompactWorkPlanLocationV2 } from '../domain/assignment-kernel/work_plan_location.js';
import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";
import type { AssignmentWorkPlanV2 } from "../domain/assignment-kernel/work_plan.js";
import { appliedOperationHasVerifiedPostconditionV2, verificationOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { verifiedNativeWorkTargetIdentitiesV2 } from '../domain/assignment-kernel/verified_work_targets.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';

/** Actionable pointers derived from verified dependencies, never inspection
 * proof. Keep the final semantic/preservation comparison and owner review. */
export function projectNextNativeInspectionV2(snapshot?: AssignmentSnapshotV2) {
  if (!snapshot || snapshot.terminal || snapshot.outcome !== 'active' || advisoryVerificationV2(snapshot)
      || snapshot.execution_control?.state === 'paused' || snapshot.unresolved_unknown_operation_ids.length
      || snapshot.in_flight_operation_ids.some(id => snapshot.operations[id]?.requested_effect === 'apply')) return null;
  const plan = snapshot.work_plan;
  if (!plan) return null;
  const item = plan.items.find(i => i.kind === 'inspection' && !workPlanItemDeferredV2(i)
    && !inspectionIsCurrentV2(snapshot,i) && i.depends_on?.length && i.depends_on.every(id => {
      const p = plan.items.find(p => p.item_id === id);
      return p?.kind !== 'inspection' && p?.completed_at && !workPlanItemDeferredV2(p)
        && p.operation_ids.length && p.operation_ids.every(oid => !snapshot.input_invalidated_operation_ids?.includes(oid)
          && appliedOperationHasVerifiedPostconditionV2(snapshot,oid));
    }));
  if (!item) return null;
  const edits = item.depends_on!.flatMap(id => plan.items.find(p => p.item_id === id)!.operation_ids);
  const targets = [...new Set(edits.flatMap(id => verifiedNativeWorkTargetIdentitiesV2(snapshot,id)))].sort();
  if (!targets.length || targets.length > 128 || Buffer.byteLength(JSON.stringify(targets),'utf8') > 4000) return null;
  const ids = targets.filter(t => /^element_id:[1-9][0-9]*$/.test(t)).map(t => Number(t.slice(11)));
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || targets.some(t => !t.startsWith('artifact_path:') && !/^element_id:[1-9][0-9]*$/.test(t))) return null;
  const times = Object.values(snapshot.operations).filter(o => o.persistent_effect === 'applied').map(o => Date.parse(o.result?.completed_at ?? ''));
  const latest = Math.max(Date.parse(item.declared_at),0,...times);
  if (!Number.isFinite(latest)) return null;
  const modelReadCandidates = Object.values(snapshot.operations).filter(op => {
    const r=op.result,body=op.input.body as Record<string,unknown>|undefined,requested=body?.elementIds??body?.ids;
    // The existing inspection consumer also accepts exact typed note reads.
    // Do not force another summary query after the actor already read the saved
    // notes. This is candidate metadata only: the consumer still validates the
    // native bytes, identity coverage, freshness and paired artifact evidence.
    const typedNotes=op.input.path === '/revit/find-text-notes' && Array.isArray(body?.elementIds)
      && body.elementId == null && body.ids == null && body.docId == null && body.familyDocumentId == null;
    return ids.length > 0 && (op.input.path === '/revit/get-element-summary' || typedNotes) && op.input.method === 'POST'
      && op.requested_effect === 'read' && op.persistent_effect === 'none' && op.settlement_state === 'settled'
      && r?.authority === 'native-host' && r.status === 'succeeded' && r.dispatch_state === 'dispatched'
      && sameAssignmentBindingV2(op.binding,snapshot.current_binding) && sameAssignmentBindingV2(r.binding,op.binding)
      && !snapshot.input_invalidated_operation_ids?.includes(op.operation_id) && Date.parse(op.opened_at) > latest
      && Array.isArray(requested) && requested.length <= 500 && new Set(requested).size === requested.length
      && requested.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) && ids.every(id => requested.includes(id));
  }).sort((a,b)=>b.opened_at.localeCompare(a.opened_at)).slice(0,4).map(op=>op.operation_id);
  const paired = edits.flatMap(id => snapshot.operations[id]!.verification_operation_ids).filter(id => {
    const op=snapshot.operations[id], r=op?.result;
    return op?.input.path === '/revit/inspect-exported-files' && op.requested_effect === 'read'
      && r?.authority === 'native-host' && r.status === 'succeeded' && op.persistent_effect === 'none'
      && op.settlement_state === 'settled' && Date.parse(op.opened_at) > latest
      && sameAssignmentBindingV2(op.binding,snapshot.current_binding) && sameAssignmentBindingV2(r.binding,op.binding)
      && !snapshot.input_invalidated_operation_ids?.includes(id) && verificationOperationHasVerifiedPostconditionV2(snapshot,id);
  });
  return {item_id:item.item_id, required_target_ids:targets,
    element_summary_read:ids.length ? {method:'POST',path:'/revit/get-element-summary',body:{elementIds:ids}} : null,
    existing_element_read_candidates:modelReadCandidates,
    paired_artifact_read_candidates:[...new Set(paired)].sort(), validation_required:true, coverage_only:true,
    notice:'Exact dependency targets and candidate read metadata, not inspection proof. Validate existing candidates through the normal checklist consumer first; if missing or incomplete use a supported fresh complete identity read after the latest edit (including SaveAs). Pair file reads for artifact targets. Keep requested preservation comparisons and final visual review; do not repeat edits, saves or unrelated discovery to obtain coverage.'};
}

export function boundedWorkPlanPage<T>(rows: readonly T[], start: number, byteBudget: number) {
  const items: T[] = [];
  for (const value of rows.slice(start, start + 8)) {
    if (Buffer.byteLength(JSON.stringify([...items, value]), "utf8") > byteBudget) break;
    items.push(value);
  }
  return { items, start, total: rows.length, next_start: start + items.length < rows.length ? start + items.length : null };
}

export function projectWorkPlan(plan: AssignmentWorkPlanV2 | undefined, start?: number, assumptionStart = 0, snapshot?: AssignmentSnapshotV2) {
  if (!plan) return null;
  const current = (item: AssignmentWorkPlanV2["items"][number]) => Boolean(item.completed_at && (item.kind !== "inspection" || !snapshot || inspectionIsCurrentV2(snapshot,item)));
  const firstPending = plan.items.findIndex(item => !current(item));
  const claimed = (id: string) => {
    if (!snapshot || !advisoryVerificationV2(snapshot)) return false;
    const item = plan.items.find(candidate => candidate.item_id === id);
    if (!item || workPlanItemDeferredV2(item)) return false;
    const claims = (snapshot.work_plan_claims ?? []).filter(claim => claim.item_id === id);
    const deferral = item.deferrals?.at(-1);
    if (!deferral) return claims.length > 0;
    // Journal order keeps old claims as history without hiding resumed corrections.
    if (deferral.prior_claim_count !== undefined) return claims.length > deferral.prior_claim_count;
    return claims.some(claim => Date.parse(claim.claimed_at) > Date.parse(deferral.resumed_at ?? deferral.deferred_at));
  };
  const waiting = (item: AssignmentWorkPlanV2["items"][number]) => (item.depends_on ?? []).filter(id=>{
    const dependency=plan.items.find(p=>p.item_id===id);
    return !dependency || workPlanItemDeferredV2(dependency) || !current(dependency) && !claimed(id);
  });
  const ready=plan.items.filter(item=>!current(item) && !claimed(item.item_id) && !workPlanItemDeferredV2(item) && waiting(item).length===0);
  return { schema: plan.schema, scope_is_assistant_interpretation: true,
    next_native_inspection: projectNextNativeInspectionV2(snapshot),
    scheduling_is_advisory: true,
    ready_items: boundedWorkPlanPage(ready.map(item=>item.item_id),0,1500),
    deferred_count: plan.items.filter(workPlanItemDeferredV2).length,
    scheduling_notice: "Work on ready independent items. Collect deferred questions for a consolidated handoff. Advisory claims are unverified: read back prerequisite results before dependent edits. This queue does not authorize native execution or clear unknown effects.",
    completed_count: plan.items.filter(item => current(item)).length, total_count: plan.items.length,
    scope: boundedWorkPlanPage(plan.items.map((item,index) => ({ item_id: item.item_id, review_ref:`R${index+1}`,
      ...(workPlanItemDeferredV2(item)?{question_ref:`Q${index+1}`} : {}), description: item.location_history?.at(-1)?.drafting?item.description.slice(0,160):item.description,
      source_basis: item.location_history?.at(-1)?.drafting?item.source_basis.slice(0,160):item.source_basis, kind: item.kind ?? "edit", depends_on: item.depends_on ?? [], waiting_on: waiting(item),
      ...(item.location_history?.length ? {location_hint:projectCompactWorkPlanLocationV2(item,snapshot)} : {}),
      deferred: workPlanItemDeferredV2(item), deferral: item.deferrals?.at(-1) ?? null, claimed_unverified: claimed(item.item_id),
      completed_at: current(item) ? item.completed_at : null, verified_operation_count: item.operation_ids.length })), start ?? Math.max(0, firstPending), 4000),
    assumptions: boundedWorkPlanPage(plan.assumptions, assumptionStart, 1000),
    pagination_tool: "operator_manage_work_plan action=status with start/assumptionStart; completed scope remains retained. action=locate with itemId/locationHint saves source page/crop and candidate model view for restart; revalidate before editing." };
}
