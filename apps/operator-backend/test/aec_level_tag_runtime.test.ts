import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ToolResult } from "../src/contracts.js";
import { getActiveGoalForSession, setAgentGoal } from "../src/goals/service.js";
import { __testOnlyClearAecLevelTagRuntime, maybeContinueAecLevelTagRuntime, startAecLevelTagRuntime } from "../src/deterministic/aec_level_tag_runtime.js";

function task(prompt = "Tag all air terminals on Level 4."): AecSemanticTaskV1 {
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "tag",
    subject: { kind: "category", semantic_class: "air_terminal", terms: ["air terminals"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "create", requested: true },
    outputs: ["summary", "element_ids", "verification"],
    execution: { max_results: 500, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true },
    confidence: { value: 0.98, ambiguity: "none", reasons: ["exact level and category"] },
    evidence: { user_text: prompt }
  };
}

function req(session: string, results?: ToolResult[]): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `${session}-${results?.[0]?.action_id ?? "start"}`, user_text: results ? "" : task().evidence.user_text, tool_results: results };
}

function result(action_id: string, result_json: unknown, status: ToolResult["status"] = "done"): ToolResult {
  return { action_id, method: "POST", path: action_id.includes("inventory") ? "/revit/find-elements" : "/revit/tag-elements", status, result_json };
}

function body(action: { body?: unknown }): Record<string, any> { return action.body as Record<string, any>; }

function withWorkspace(run: (root: string) => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aec-level-tag-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { run(root); }
  finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function activateGoal(session: string): void {
  setAgentGoal(session, {
    title: "Tag exact level views",
    objective: task().evidence.user_text,
    success_criteria: ["Every exact target is tagged.", "Focused visual QA remains explicit."],
    current_phase: "scope_resolution",
    current_step: "Resolve exact views",
    work_items: [
      { id: "view.101.inspect", title: "Inspect L4 HVAC", status: "ready" },
      { id: "view.101.execute", title: "Execute L4 HVAC", status: "pending" },
      { id: "view.101.verify", title: "Verify L4 HVAC", status: "pending" },
      { id: "view.102.inspect", title: "Inspect L4 HVAC Enlarged", status: "ready" },
      { id: "view.102.execute", title: "Execute L4 HVAC Enlarged", status: "pending" },
      { id: "view.102.verify", title: "Verify L4 HVAC Enlarged", status: "pending" },
      { id: "verify.visual", title: "Perform focused visual QA and bounded repair", status: "pending" }
    ]
  });
}

test("level tag runtime inventories, dry-runs, retries collisions, and proves exact final coverage", () => withWorkspace(() => {
  __testOnlyClearAecLevelTagRuntime();
  const session = "level-tag-happy";
  activateGoal(session);
  const first = startAecLevelTagRuntime(req(session), task(), [{ id: 101, name: "L4 HVAC", levelName: "L4" }, { id: 102, name: "L4 HVAC Enlarged", levelName: "L4" }]);
  assert.deepEqual(first?.actions.map(action => [action.path, action.body]), [
    ["/revit/find-elements", { viewId: 101, categories: ["OST_DuctTerminal"], limit: 5000 }],
    ["/revit/find-elements", { viewId: 102, categories: ["OST_DuctTerminal"], limit: 5000 }]
  ]);

  const dryRun = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-inventory-101", { count: 2, truncated: false, elementIds: [11, 12] }),
    result("aec-level-tag-inventory-102", { count: 1, truncated: false, elementIds: [21] })
  ]));
  assert.deepEqual(dryRun?.actions.map(action => action.path), ["/revit/tag-elements", "/revit/tag-elements"]);
  assert.ok(dryRun?.actions.every(action => body(action).placementMode === "geometry_aware" && body(action).maxRepairAttempts === 180 && body(action).dryRun === true));

  const apply = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-dry_run-101", { targetCount: 2, plannedToTag: 2, skippedAlreadyTagged: 0, geometry: { plans: [{ candidateCount: 180 }, { candidateCount: 180 }] } }),
    result("aec-level-tag-dry_run-102", { targetCount: 1, plannedToTag: 0, skippedAlreadyTagged: 1, geometry: { plans: [] } })
  ]));
  assert.equal(apply?.actions.length, 1);
  assert.equal(body(apply!.actions[0]!).dryRun, false);
  assert.equal(apply?.actions[0]?.action_id, "aec-level-tag-apply-101-v1");

  const retry = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-apply-101-v1", { targetCount: 2, taggedCount: 1, skippedAlreadyTagged: 0, errorCount: 1, tagIds: [901], errors: [{ failureKind: "tag_unresolved_collision" }] })
  ]));
  assert.equal(retry?.actions[0]?.action_id, "aec-level-tag-apply-101-v2");
  assert.equal(body(retry!.actions[0]!).tagWidthPaperInches, 0.55);
  assert.equal(body(retry!.actions[0]!).clearancePaperInches, 0.03);

  const verify = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-apply-101-v2", { targetCount: 2, taggedCount: 1, skippedAlreadyTagged: 1, errorCount: 0, tagIds: [902], errors: [] })
  ]));
  assert.deepEqual(verify?.actions.map(action => action.action_id), ["aec-level-tag-verify-101", "aec-level-tag-verify-102"]);
  assert.ok(verify?.actions.every(action => body(action).dryRun === true));

  const done = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-verify-101", { targetCount: 2, plannedToTag: 0, skippedAlreadyTagged: 2, geometry: { plans: [] } }),
    result("aec-level-tag-verify-102", { targetCount: 1, plannedToTag: 0, skippedAlreadyTagged: 1, geometry: { plans: [] } })
  ]));
  assert.equal(done?.aec_query_receipt?.workflow_id, "tag.level_views");
  assert.equal(done?.aec_query_receipt?.status, "complete");
  assert.match(done?.assistant_message ?? "", /2\/2 tagged; L4 HVAC Enlarged: 1\/1 tagged/);
  const goal = getActiveGoalForSession(session);
  assert.equal(goal?.work_items.find(item => item.id === "view.101.execute")?.status, "complete");
  assert.equal(goal?.work_items.find(item => item.id === "view.101.verify")?.status, "ready");
  assert.equal(goal?.work_items.find(item => item.id === "verify.visual")?.status, "ready");
}));

test("level tag runtime fails closed on truncated inventories before any tag action", () => withWorkspace(() => {
  __testOnlyClearAecLevelTagRuntime();
  const session = "level-tag-truncated";
  activateGoal(session);
  startAecLevelTagRuntime(req(session), task(), [{ id: 101, name: "L4 HVAC", levelName: "L4" }]);
  const stopped = maybeContinueAecLevelTagRuntime(req(session, [result("aec-level-tag-inventory-101", { count: 5001, truncated: true, elementIds: [11] })]));
  assert.equal(stopped?.aec_query_receipt?.status, "failed");
  assert.deepEqual(stopped?.actions, []);
  assert.match(stopped?.assistant_message ?? "", /5000-element per-view budget/);
}));

test("level tag runtime rejects missing or duplicate continuation results", () => withWorkspace(() => {
  __testOnlyClearAecLevelTagRuntime();
  const session = "level-tag-duplicate";
  activateGoal(session);
  startAecLevelTagRuntime(req(session), task(), [{ id: 101, name: "L4 HVAC", levelName: "L4" }, { id: 102, name: "L4 HVAC Enlarged", levelName: "L4" }]);
  const stopped = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-inventory-101", { count: 1, truncated: false, elementIds: [11] }),
    result("aec-level-tag-inventory-101", { count: 1, truncated: false, elementIds: [11] })
  ]));
  assert.equal(stopped?.aec_query_receipt?.status, "failed");
  assert.match(stopped?.assistant_message ?? "", /not fully observed|duplicated/i);
}));

test("level tag runtime rejects apply counts without exact unique created ids", () => withWorkspace(() => {
  __testOnlyClearAecLevelTagRuntime();
  const session = "level-tag-created-id-mismatch";
  activateGoal(session);
  startAecLevelTagRuntime(req(session), task(), [{ id: 101, name: "L4 HVAC", levelName: "L4" }]);
  maybeContinueAecLevelTagRuntime(req(session, [result("aec-level-tag-inventory-101", { count: 1, truncated: false, elementIds: [11] })]));
  maybeContinueAecLevelTagRuntime(req(session, [result("aec-level-tag-dry_run-101", { targetCount: 1, plannedToTag: 1, skippedAlreadyTagged: 0, geometry: { plans: [{ candidateCount: 180 }] } })]));
  const stopped = maybeContinueAecLevelTagRuntime(req(session, [
    result("aec-level-tag-apply-101-v1", { targetCount: 1, taggedCount: 1, skippedAlreadyTagged: 0, errorCount: 0, tagIds: [], errors: [] })
  ]));
  assert.equal(stopped?.aec_query_receipt?.status, "failed");
  assert.deepEqual(stopped?.actions, []);
  assert.match(stopped?.assistant_message ?? "", /same number of unique created ids/);
}));
