import type { AssignmentWorkPlanV2 } from "../domain/assignment-kernel/work_plan.js";

export function boundedWorkPlanPage<T>(rows: readonly T[], start: number, byteBudget: number) {
  const items: T[] = [];
  for (const value of rows.slice(start, start + 8)) {
    if (Buffer.byteLength(JSON.stringify([...items, value]), "utf8") > byteBudget) break;
    items.push(value);
  }
  return { items, start, total: rows.length, next_start: start + items.length < rows.length ? start + items.length : null };
}

export function projectWorkPlan(plan: AssignmentWorkPlanV2 | undefined, start?: number, assumptionStart = 0) {
  if (!plan) return null;
  const firstPending = plan.items.findIndex(item => !item.completed_at);
  return { schema: plan.schema, scope_is_assistant_interpretation: true,
    completed_count: plan.items.filter(item => item.completed_at).length, total_count: plan.items.length,
    scope: boundedWorkPlanPage(plan.items.map(item => ({ item_id: item.item_id, description: item.description,
      source_basis: item.source_basis, completed_at: item.completed_at ?? null, verified_operation_count: item.operation_ids.length })), start ?? Math.max(0, firstPending), 4000),
    assumptions: boundedWorkPlanPage(plan.assumptions, assumptionStart, 1000),
    pagination_tool: "operator_manage_work_plan action=status with start/assumptionStart; completed scope remains retained." };
}
