import assert from "node:assert/strict";
import test from "node:test";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import { projectAssignmentStatusForModel } from "../src/brains/assignment_status_projection.js";

test("compact task status prioritizes newly discovered unanswered questions over long resolved history", () => {
  const old = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`old-${i}`, {
    variable_id: `old_${i}`, clarification_id: `old-${i}`, question: `Resolved question ${i}`,
    requested_at: "2026-09-01T00:00:00Z", resolved_at: "2026-09-01T01:00:00Z"
  }]));
  const variable = { variable_id: "target_floor", required: true, sensitive: false, value_state: "needs_input" };
  const input = { ok: true, assignment_snapshot_v2: {
    schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA, current_binding: { assignment_id: "task" }, terminal: false,
    outcome: "awaiting_user_input", pending_input_variable_ids: ["target_floor"], spec: { input_variables: [] },
    discovered_inputs: { target_floor: { variable, dependent_work_unit_ids: ["work-primary"] } },
    clarifications: { ...old, current: { variable_id: "target_floor", clarification_id: "current", question: "Which floor?", requested_at: "2026-09-15T00:00:00Z" } }
  } };
  const before = structuredClone(input);
  const status = projectAssignmentStatusForModel(input)!.assignment_status;
  assert.deepEqual(status.pending_input_definitions, [variable]);
  assert.equal(status.clarifications[0].clarification_id, "current");
  assert.ok(status.omitted.clarifications.count > 0);
  assert.equal(status.authority, "presentation_only");
  assert.deepEqual(input, before);
});
