import { inspectionIsCurrentV2, workPlanItemDeferredV2 } from "../domain/assignment-kernel/work_plan.js";
import { projectWorkPlanLocationV2 } from '../domain/assignment-kernel/work_plan_location.js';
import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";
import type { AssignmentWorkPlanV2 } from "../domain/assignment-kernel/work_plan.js";

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
    scheduling_is_advisory: true,
    ready_items: boundedWorkPlanPage(ready.map(item=>item.item_id),0,1500),
    deferred_count: plan.items.filter(workPlanItemDeferredV2).length,
    scheduling_notice: "Work on ready independent items. Collect deferred questions for a consolidated handoff. Advisory claims are unverified: read back prerequisite results before dependent edits. This queue does not authorize native execution or clear unknown effects.",
    completed_count: plan.items.filter(item => current(item)).length, total_count: plan.items.length,
    scope: boundedWorkPlanPage(plan.items.map((item,index) => ({ item_id: item.item_id, review_ref:`R${index+1}`,
      ...(workPlanItemDeferredV2(item)?{question_ref:`Q${index+1}`} : {}), description: item.description,
      source_basis: item.source_basis, kind: item.kind ?? "edit", depends_on: item.depends_on ?? [], waiting_on: waiting(item),
      ...(item.location_history?.length ? {location_hint:projectWorkPlanLocationV2(item,snapshot)} : {}),
      deferred: workPlanItemDeferredV2(item), deferral: item.deferrals?.at(-1) ?? null, claimed_unverified: claimed(item.item_id),
      completed_at: current(item) ? item.completed_at : null, verified_operation_count: item.operation_ids.length })), start ?? Math.max(0, firstPending), 4000),
    assumptions: boundedWorkPlanPage(plan.assumptions, assumptionStart, 1000),
    pagination_tool: "operator_manage_work_plan action=status with start/assumptionStart; completed scope remains retained. action=locate with itemId/locationHint saves source page/crop and candidate model view for restart; revalidate before editing." };
}
