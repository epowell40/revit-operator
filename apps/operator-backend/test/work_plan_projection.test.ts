import { drawingWorkGuidance } from "../src/goals/drawing_work_guidance.js";
import test from "node:test";
import assert from "node:assert/strict";
import { projectWorkPlan, boundedWorkPlanPage } from "../src/assignments/work_plan_projection.js";
import type { AssignmentWorkPlanV2 } from "../src/domain/assignment-kernel/work_plan.js";
import { retainAdvisoryFollowupsV2, dispositionAdvisoryFollowupV2 } from "../src/domain/assignment-kernel/advisory_followups.js";
import { projectAdvisoryFollowupsV2, advisoryFollowupsHandoffV2 } from "../src/assignments/advisory_followups_projection.js";
import type { AssignmentSnapshotV2 } from "../src/domain/assignment-kernel/snapshot.js";

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

test("advisory exact-text provenance survives deferral, omission and reopening without changing its original identity", () => {
  const proposal = { claimed_completed: [], remaining_work: ["Inspect outlet.", "Inspect outlet.", " Inspect outlet."], uncertainties: ["Inspect outlet."] };
  const initial = retainAdvisoryFollowupsV2(undefined, proposal, 2);
  assert.equal(initial.length, 3, "only identical kind and exact text share identity");
  assert.deepEqual(initial.map(item => [item.source_version, item.source_field, item.source_index]), [[2, "remaining_work", 0], [2, "remaining_work", 2], [2, "uncertainties", 0]]);
  let items = dispositionAdvisoryFollowupV2(initial, { command_id: "defer", item_id: initial[0]!.item_id, expected_version: 2,
    disposition: "deferred", reason: "A clearer source is needed." }, 3);
  items = dispositionAdvisoryFollowupV2(items, { command_id: "resolve", item_id: initial[1]!.item_id, expected_version: 2,
    disposition: "resolved", reason: "The agent reports this item addressed." }, 4);
  assert.deepEqual(retainAdvisoryFollowupsV2(items, { claimed_completed: ["Partial result"], remaining_work: [], uncertainties: [] }, 5), items);
  const snapshot = { assignment_version: 5, advisory_followups: items } as AssignmentSnapshotV2;
  assert.equal(projectAdvisoryFollowupsV2(snapshot).unresolved_total, 2);
  assert.match(advisoryFollowupsHandoffV2(snapshot), /Deferred: Inspect outlet.*Reason: A clearer source/s);
  const repeated = retainAdvisoryFollowupsV2(items, proposal, 6);
  assert.deepEqual(repeated.map(item => item.item_id), initial.map(item => item.item_id));
  assert.deepEqual(repeated.map(item => item.state), ["deferred", "open", "open"]);
  assert.ok(repeated.every(item => item.verified === false && item.source_version === 2));
  assert.equal(initial[0]!.state, "open", "helpers cannot mutate accepted input arrays");
});

test("all maximum-sized advisory items remain retrievable through bounded visible pages", () => {
  const texts = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0") + "界".repeat(998));
  const items = retainAdvisoryFollowupsV2(undefined, { claimed_completed: [], remaining_work: texts, uncertainties: texts }, 2);
  const snapshot = { assignment_version: 2, advisory_followups: items } as AssignmentSnapshotV2;
  let start: number | null = 0;const seen: string[] = [];
  while (start !== null) {
    const page = projectAdvisoryFollowupsV2(snapshot, start);
    assert.ok(page.items.length > 0 && page.items.length <= 8);assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 16384);
    assert.equal(page.unresolved_total, 48);assert.equal(page.not_shown, 48 - page.items.length);
    assert.equal(page.assignment_version, 2);assert.ok(page.next_start === null || page.next_start > start);
    seen.push(...page.items.map(item => item.item_id));start = page.next_start;
  }
  assert.deepEqual(seen, items.map(item => item.item_id));
  assert.match(advisoryFollowupsHandoffV2(snapshot), /more unfinished items are saved/);
  assert.doesNotMatch(advisoryFollowupsHandoffV2(snapshot), /followupStart|followup:2/);
  assert.throws(() => projectAdvisoryFollowupsV2(snapshot, -1));
});

test("a legal report and reason with maximal JSON escaping cannot stall advisory pagination", () => {
  const version = Number.MAX_SAFE_INTEGER - 2;
  const retained = retainAdvisoryFollowupsV2(undefined, { claimed_completed: [], remaining_work: [],
    uncertainties: Array.from({ length: 24 }, (_, i) => "Parent " + i) }, version);
  const parent = retained[23]!;
  const replaced = dispositionAdvisoryFollowupV2(retained, { command_id: "replace-escaped", item_id: parent.item_id, expected_version: version,
    disposition: "superseded", reason: "Keep the unresolved clauses.", replacements: Array.from({ length: 8 }, (_, i) => ({
      kind: "uncertainties" as const, text: i === 7 ? "\u0000".repeat(1000) : "\u0000".repeat(999) + i })) }, version + 1);
  const child = replaced.at(-1)!;
  const items = dispositionAdvisoryFollowupV2(replaced, { command_id: "defer-escaped", item_id: child.item_id, expected_version: version + 1,
    disposition: "deferred", reason: "\u0000".repeat(1000) }, version + 2);
  // Maximum-length safe versions, original index, parent identity, replacement index and reason all count.
  const page = projectAdvisoryFollowupsV2({ assignment_version: version + 2, advisory_followups: items } as AssignmentSnapshotV2, 30);
  assert.equal(page.items.length, 1, "the first legal item must fit rather than return the same empty cursor forever");
  assert.equal(page.next_start, null);assert.deepEqual(page.items, [items.at(-1)!]);
  assert.equal(page.items[0]!.parent_item_id, parent.item_id);assert.equal(page.items[0]!.source_index, 7);
  assert.ok(Buffer.byteLength(JSON.stringify(page.items)) > 12000);
  assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 16384);
});
