import { drawingWorkGuidance } from "../src/goals/drawing_work_guidance.js";
import test from "node:test";
import assert from "node:assert/strict";
import { projectWorkPlan, boundedWorkPlanPage } from "../src/assignments/work_plan_projection.js";
import type { AssignmentWorkPlanV2 } from "../src/domain/assignment-kernel/work_plan.js";

test("large multilingual drawing scope remains fully pageable without overflowing the model context", () => {
  const plan: AssignmentWorkPlanV2 = { schema: "revit-operator.assignment-work-plan/v2",
    assumptions: Array.from({ length: 32 }, (_, i) => `${i}:` + "測".repeat(260)),
    items: Array.from({ length: 128 }, (_, i) => ({ item_id: `branch_${i}`, description: "測".repeat(266),
      source_basis: "図".repeat(266), declared_at: "2026-09-16T12:00:00.000Z", operation_ids: Array.from({ length: 128 }, (_, j) => `operation_${i}_${j}`),
      ...(i < 100 ? { completed_at: "2026-09-16T13:00:00.000Z" } : {}) })) };
  assert.equal(projectWorkPlan(plan)!.scope.start, 100);
  const observed: string[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const page: NonNullable<ReturnType<typeof projectWorkPlan>> = projectWorkPlan(plan, start)!;
    assert(Buffer.byteLength(JSON.stringify(page)) < 6000);
    assert(page.scope.items.length > 0);
    observed.push(...page.scope.items.map(item => item.item_id));
    assert(page.scope.next_start === null || page.scope.next_start > start);
    start = page.scope.next_start;
  }
  assert.deepEqual(observed, plan.items.map(item => item.item_id));
  const assumptions: string[] = [];
  start = 0;
  while (start !== null) {
    const page: NonNullable<ReturnType<typeof projectWorkPlan>>["assumptions"] = projectWorkPlan(plan, 0, start)!.assumptions;
    assert(page.items.length > 0);
    assumptions.push(...page.items);
    start = page.next_start;
  }
  assert.deepEqual(assumptions, plan.assumptions);
  assert.deepEqual(boundedWorkPlanPage([], 0, 1000), { items: [], start: 0, total: 0, next_start: null });
});

test("broad drawing guidance establishes source-detail and batch-verification strategy without burdening simple questions",()=>{
 const text=drawingWorkGuidance("Reconstruct all HVAC from the PDF",true);
 assert.match(text,/closer attachment crops/);assert.match(text,/Register source positions/);assert.match(text,/get-parameters.*get-connectors/);assert.match(text,/open ends/i);
 assert.equal(drawingWorkGuidance("Can you see the model?",false),"");assert.equal(drawingWorkGuidance("Audit every room name",true),"");
});
