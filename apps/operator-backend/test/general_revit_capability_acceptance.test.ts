import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateGeneralRevitCapabilityAttempt,
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCapabilityReport
} from "../src/benchmark/general_revit_capability_acceptance.js";
import { loadEpic0441Campaign } from "../src/benchmark/epic0441_campaign.js";
import { backendRoot, repoRoot } from "../src/benchmark/files.js";

const corpus = loadGeneralRevitCapabilityCorpus();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

test("general Revit corpus covers the user basics and the retained redline operation families", () => {
  assert.equal(new Set(corpus.cases.map((entry) => entry.case_id)).size, corpus.cases.length);
  assert.ok(corpus.cases.length >= 40);
  for (const family of corpus.required_operation_families) {
    assert.ok(corpus.cases.some((entry) => entry.operation_family === family), `missing ${family}`);
  }
  for (const expectedCase of [
    "q01_air_device_inventory", "b01_equipment_rename", "b02_print_sheet", "b03_create_view", "b04_duplicate_view",
    "b05_duplicate_sheet", "b06_edit_loaded_family", "s01_create_schedule", "s02_add_schedule_field",
    "s03_schedule_filter", "s04_schedule_sort_group", "s05_schedule_value_edit", "v01_hide_show_category",
    "v02_category_graphics_override", "v03_create_apply_view_filter", "v04_create_view_template",
    "v05_apply_view_template", "r13_schedule_airflow_sync", "r14_tag_designation_sync",
    "r15_bulk_visible_status_rule", "r16_tag_layout_cleanup", "r17_add_connected_accessory",
    "r18_move_connected_accessory", "r19_delete_bounded_route_preflight", "x01_native_api_fallback"
  ]) {
    assert.ok(corpus.cases.some((entry) => entry.case_id === expectedCase), `missing ${expectedCase}`);
  }
  assert.match(corpus.purpose, /general-purpose Revit work/i);
});

test("every corpus capability has a public backend and bridge execution lane", () => {
  const allowlist = fs.readFileSync(path.join(backendRoot(), "src", "allowlist.ts"), "utf8");
  const bridgeSources = [
    source("revit-bridge-addin/RevitBridge/Operator/OperatorActionAllowlist.cs"),
    source("revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs"),
    source("revit-bridge-addin/RevitBridge/Server/RevitHttpServer.cs")
  ].join("\n");
  for (const entry of corpus.cases) {
    for (const capabilityPath of entry.capability_paths) {
      assert.ok(allowlist.includes(`"${capabilityPath}"`), `${entry.case_id}: backend does not expose ${capabilityPath}`);
      assert.ok(bridgeSources.includes(capabilityPath), `${entry.case_id}: bridge does not implement or publish ${capabilityPath}`);
    }
    assert.ok(entry.dispatch_any_of.some((candidate) => allowlist.includes(`"${candidate}"`)), `${entry.case_id}: no dispatch lane is exposed`);
  }
});

test("redline-derived cases retain traceability to the frozen EPIC-0441 campaign", () => {
  const campaignIds = new Set(loadEpic0441Campaign().tasks.map((entry) => entry.task_id));
  for (const entry of corpus.cases) {
    assert.ok(entry.epic0441_task_refs.length > 0, `${entry.case_id}: missing campaign traceability`);
    for (const taskId of entry.epic0441_task_refs) {
      assert.ok(campaignIds.has(taskId), `${entry.case_id}: unknown EPIC-0441 task ${taskId}`);
    }
  }
});

test("the original context-only response is classified as an in-scope capability refusal", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "s01_create_schedule")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "I can’t provide authoritative Air Terminal totals or a family/type breakdown because this certified read-only profile exposes only document/view context—not elements, schedules, or project-wide queries.",
    effect_state: "not_dispatched",
    rounds: []
  });
  assert.equal(result.tier, "refused");
  assert.equal(result.non_refusal, false);
  assert.equal(result.completed, false);
});

test("an exact-target clarification is accepted but is not mislabeled completion", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "b01_equipment_rename")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Nothing is selected. Please select the equipment instance or give me its exact Mark so I change the right one.",
    effect_state: "not_dispatched",
    rounds: []
  });
  assert.equal(result.tier, "accepted");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
});

test("planned, previewed, completed, and verified remain distinct truth tiers", () => {
  const previewCase = corpus.cases.find((candidate) => candidate.case_id === "s03_schedule_filter")!;
  const applyCase = { ...previewCase, expected_effect: "apply" as const };
  const rounds = [{ actions: [{ path: "/revit/configure-schedule", request_effect: "preview" }] }];
  assert.equal(evaluateGeneralRevitCapabilityAttempt(previewCase, { ok: true, effect_state: "not_dispatched", rounds }).tier, "planned");
  const previewed = evaluateGeneralRevitCapabilityAttempt(previewCase, { ok: true, effect_state: "read_only_dispatched", rounds });
  assert.equal(previewed.tier, "previewed");
  assert.equal(previewed.completed, true);
  const completed = evaluateGeneralRevitCapabilityAttempt(applyCase, { ok: true, effect_state: "apply_dispatched", rounds });
  assert.equal(completed.tier, "completed");
  assert.equal(completed.verified, false);
  const verified = evaluateGeneralRevitCapabilityAttempt(applyCase, {
    ok: true,
    effect_state: "apply_dispatched",
    rounds,
    verification_result: { readback: { schedule_filter_count: 1 }, result_hash: "a".repeat(64) }
  });
  assert.equal(verified.tier, "verified");
  assert.equal(verified.completed, true);
  assert.equal(verified.verified, true);
});

test("aggregate results never turn non-refusal into a completion claim", () => {
  const entry = corpus.cases[0];
  const accepted = evaluateGeneralRevitCapabilityAttempt(entry, { ok: true, assistant_message: "Which equipment should I change?" });
  const completed = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    effect_state: "read_only_dispatched",
    rounds: [{ actions: [{ path: entry.dispatch_any_of[0] }] }]
  });
  const summary = summarizeGeneralRevitCapabilityReport([accepted, completed]);
  assert.equal(summary.non_refusal_count, 2);
  assert.equal(summary.completed_count, 1);
  assert.equal(summary.verified_count, 0);
});

test("durable assignment evidence closes the flight-recorder loop for MCP-native Revit work", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "q01_air_device_inventory")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Found 509 air terminals across seven family/type groups.",
    effect_state: "not_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [
          { summary: "Live tool revit_search_tools completed." },
          { summary: "Live tool revit_call_tool completed." }
        ] },
        verification: { state: "verified", criteria: [{ status: "pass" }] }
      }]
    }
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.dispatched, true);
  assert.equal(result.completed, true);
  assert.deepEqual(result.observed_paths, ["mcp:revit_call_tool"]);
});

test("execution failures remain non-refusals while still failing completion", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "b06_edit_loaded_family")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, { ok: false, error: "The Revit call timed out.", effect_state: "not_dispatched" });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
});

test("a blocked mutation receipt overrides a contradictory completed assignment", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "b03_create_view")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "The view was created, but post-apply verification did not complete.",
    teammate_loop_receipt: {
      turn_kind: "mutation",
      stage: "blocked",
      apply_attempts: 1,
      verified: false,
      blocked_reason: "post_apply_verification_required"
    },
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }
      }]
    }
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.apply_dispatched, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
});

test("an assistant-reported incomplete mutation cannot be scored verified", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "v06_create_apply_named_view_template")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "The assignment is blocked this turn. The requested new assignment is not yet complete.",
    teammate_loop_receipt: {
      turn_kind: "mutation",
      stage: "report",
      apply_attempts: 1,
      verified: true,
      blocked_reason: null
    },
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }
      }]
    }
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
});
