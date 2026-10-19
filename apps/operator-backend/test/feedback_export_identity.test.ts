import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueRunBundleForUpload } from "../src/feedback/upload_queue.js";
import { resolveRunBundleDir } from "../src/improvement/upload_payload.js";
import { buildDevHandoff } from "../src/feedback/dev_handoff.js";
import { appendFeedbackAndMaybePromote } from "../src/feedback/feedback_store.js";
import { persistence } from "../src/persistence/persistence_manager.js";
import { createGoal } from "../src/goals/service.js";
import { createAssignmentKernelV2 } from "../src/assignments/assignment_kernel_v2_store.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-binding-")); process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("queued principal identity survives explicit metadata and legacy folder names", () => {
  const root = workspace(), session = "ps1_scope_session_with_underscores";
  persistence.ensureSession(session);
  const queued = queueRunBundleForUpload({ session_id: session, created_at: "2026-10-19T10:00:00Z" }); assert(queued.ok);
  const resolved = resolveRunBundleDir(queued.queue_dir_full); assert(resolved.ok); assert.equal(resolved.session_id, session);
  // Compatibility with already queued V22 links that have no pointer.json.
  fs.unlinkSync(path.join(queued.queue_dir_full, "pointer.json"));
  const legacy = resolveRunBundleDir(queued.queue_dir_full); assert(legacy.ok); assert.equal(legacy.session_id, session);
  assert.equal(queueRunBundleForUpload({ session_id: "../outside", created_at: "now" }).ok, false);
  assert.throws(() => appendFeedbackAndMaybePromote({ session_id: session, assignment_id: "../../outside", rating: "failed" }));
  assert.equal(fs.existsSync(path.join(root, "feedback", "events.jsonl")), false);
});

test("Codex turn-ID records with completed status still retain their actual errors", () => {
  const root = workspace(), session = "session-codex";
  const dir = persistence.ensureSession(session).sessionDir;
  fs.writeFileSync(path.join(dir, "request_log.jsonl"), JSON.stringify({ kind: "user.turn", user_text: "Current request", ts: "2026-10-19T10:00:00Z" }));
  fs.writeFileSync(path.join(dir, "agent_log.jsonl"), JSON.stringify({ kind: "assistant.turn", message_id: "message-current", text: "Unable to finish" }));
  fs.writeFileSync(path.join(dir, "tool_outputs.jsonl"), [
    { ts: "2026-10-19T09:00:00Z", turn_id: "old", tool: "old-tool", status: "failed", error: "Earlier error" },
    { ts: "2026-10-19T10:00:10Z", turn_id: "current", tool: "schedule", status: "completed", error: "Filter rejected" }
  ].map(row => JSON.stringify(row)).join("\n"));
  const handoff = buildDevHandoff({ session_id: session, rating: "failed" });
  assert(handoff.issue_digest.some(issue => issue.tools.includes("schedule")));
  assert(!handoff.issue_digest.some(issue => issue.tools.includes("old-tool")));
  assert.equal(root, process.env.OPERATOR_WORKSPACE_ROOT);
});

test("task feedback requires the current session, run and generation before persisting", () => {
  const root = workspace(), session = "bound-session";
  const goal = createGoal({ title: "Test inventory", objective: "Read a bounded inventory", acceptance_criteria: ["Inventory returned"], related_session_id: session });
  const binding = { assignment_id: goal.id, run_id: "current-run", generation: 1, session_id: session, principal_id: "test-principal", document_fingerprint: "test-model" };
  createAssignmentKernelV2(goal.id, { schema: "revit-operator.assignment-spec/v2", binding, source_user_request: goal.objective, requested_effect: "read",
    criteria: [{ criterion_id: "inventory", requirement: "Inventory returned", required: true, semantic_fact_requirements: [], accepted_evaluator_authority_ids: ["test"], accepted_observation_authority_ids: ["native-host"] }], input_variables: [],
    work_units: [{ work_unit_id: "inventory", requested_effect: "read", execution_class: "analysis", dependency_ids: [], criterion_ids: ["inventory"], input_variable_ids: [], independently_useful: true, safe_to_retain: true, rollback_scope: "none" }], authorization_policy_id: "read", created_at: "2026-10-19T10:00:00Z" }, "test");
  assert.throws(() => appendFeedbackAndMaybePromote({ session_id: session, assignment_id: goal.id, run_id: "old-run", rating: "worked" }), /binding/);
  assert.throws(() => appendFeedbackAndMaybePromote({ session_id: "foreign-session", assignment_id: goal.id, rating: "worked" }), /binding/);
  appendFeedbackAndMaybePromote({ session_id: session, assignment_id: goal.id, run_id: "current-run", generation: 1, rating: "partial" });
  const event = JSON.parse(fs.readFileSync(path.join(root, "feedback", "events.jsonl"), "utf8").trim());
  assert.equal(event.run_id, "current-run"); assert.equal(event.assignment_id, goal.id); assert.equal(event.generation, 1);
});
