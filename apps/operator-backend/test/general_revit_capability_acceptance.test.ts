import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateGeneralRevitCapabilityAttempt,
  generalRevitExecutionCase,
  generalRevitGroundingDemand,
  generalRevitPromptSpecificity,
  generalRevitResearchDemand,
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCorpusCoverage,
  summarizeGeneralRevitCapabilityReport
} from "../src/benchmark/general_revit_capability_acceptance.js";
import { loadEpic0441Campaign } from "../src/benchmark/epic0441_campaign.js";
import { generalRevitFixtureForCase, loadGeneralRevitSampleFixtures } from "../src/benchmark/general_revit_sample_fixtures.js";
import { backendRoot, repoRoot } from "../src/benchmark/files.js";

const corpus = loadGeneralRevitCapabilityCorpus();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

test("benchmark defaults to the product General Agent surface and labels legacy chat diagnostic-only", () => {
  const runner = source("operator-backend/src/tools/general_revit_capability_acceptance.ts");
  assert.match(runner, /const useComputer = executionSurface\(\) === "operator_computer_general_agent"/);
  assert.match(runner, /process\.argv\.includes\("--legacy-chat"\)/);
  assert.match(runner, /execution_surface: executionSurface\(\)/);
  assert.match(runner, /harness_health_ms:/);
  assert.match(runner, /computer_performance: computerPerformanceSummary\(attempt\)/);
  assert.match(runner, /fixturePreflight = await requestJson\(sidecar, "\/api\/revit\/health", \{\}, healthTimeoutMs\(\)\)/);
  assert.match(runner, /selected_answer_assertion_case_count:/);
  assert.match(runner, /summary_by_verification_basis:/);
  assert.match(runner, /verification_basis/);
  assert.match(runner, /--legacy-chat is retained only for transport diagnostics/);
  assert.doesNotMatch(runner, /const useComputer = process\.argv\.includes\("--ui"\)/);
});

test("benchmark groups cases by fixture and fails closed on an unpinned mixed-model run", () => {
  const runner = source("operator-backend/src/tools/general_revit_capability_acceptance.ts");
  assert.match(runner, /--orchestrate-fixtures/);
  assert.match(runner, /async function ensureFixtureActive/);
  assert.match(runner, /Selected cases span multiple sample models/);
  assert.match(runner, /revit_open_model/);
  assert.match(runner, /discardExistingOpenDocument=true/);
  assert.match(runner, /explicitly authorized to close it without saving and reopen it/);
  assert.match(runner, /fixture_transitions:/);
  assert.match(runner, /preferredFixture !== activeFixtureKey/);
  assert.match(runner, /Fixture transition .* failed:/);
});

test("general Revit corpus covers the user basics and the retained redline operation families", () => {
  assert.equal(new Set(corpus.cases.map((entry) => entry.case_id)).size, corpus.cases.length);
  assert.equal(corpus.cases.length, 100);
  for (const family of corpus.required_operation_families) {
    assert.ok(corpus.cases.some((entry) => entry.operation_family === family), `missing ${family}`);
  }
  for (const expectedCase of [
    "q01_air_device_inventory", "b01_equipment_rename", "b02_print_sheet", "b03_create_view", "b04_duplicate_view",
    "b05_duplicate_sheet", "b06_edit_loaded_family", "b08_create_and_rename_sheet", "b09_rename_view",
    "b10_change_view_scale_and_settings", "b11_create_enlarged_plan", "b12_visual_observe_verify",
    "s01_create_schedule", "s02_add_schedule_field",
    "s03_schedule_filter", "s04_schedule_sort_group", "s05_schedule_value_edit", "v01_hide_show_category",
    "v02_category_graphics_override", "v03_create_apply_view_filter", "v04_create_view_template",
    "v05_apply_view_template", "r13_schedule_airflow_sync", "r14_tag_designation_sync",
    "r15_bulk_visible_status_rule", "r16_tag_layout_cleanup", "r17_add_connected_accessory",
    "r18_move_connected_accessory", "r19_delete_bounded_route_preflight", "x01_native_api_fallback"
    , "lh01_bulk_hru_to_eru_marks", "lh02_hru_schedule_transform_verify", "lh03_sheet_view_area_migration",
    "lh04_titleblock_initials_discovery", "lh05_create_similar_receptacles", "lh06_visibility_range_template",
    "lh07_family_clearance_evolution", "dp01_individual_bw_pdf_set", "dp02_combined_discipline_pdf",
    "cx01_dynamic_hru_to_eru_program"
  ]) {
    assert.ok(corpus.cases.some((entry) => entry.case_id === expectedCase), `missing ${expectedCase}`);
  }
  assert.match(corpus.purpose, /general-purpose Revit work/i);
  assert.equal(corpus.cases.filter((entry) => entry.source === "long_horizon").length, 7);
  assert.equal(corpus.cases.filter((entry) => entry.source === "document_production").length, 2);
  assert.equal(corpus.cases.filter((entry) => entry.source === "code_execution").length, 1);
  assert.ok(corpus.cases.filter((entry) => entry.case_id.startsWith("c")).length >= 45);
  assert.ok(corpus.cases.filter((entry) => entry.prompt.split(/\s+/).length <= 16).length >= 15);
  assert.ok(corpus.cases.filter((entry) => entry.operation_family === "research_and_compliance").length >= 4);
  assert.ok(corpus.cases.filter((entry) => entry.operation_family === "schedule_configure").length >= 9);
  assert.ok(corpus.cases.filter((entry) => ["tag", "text_edit", "move", "type_change"].includes(entry.operation_family)).length >= 17);
});

test("corpus coverage truthfully maps the frozen top fifteen and prompt-specificity cohorts", () => {
  const coverage = summarizeGeneralRevitCorpusCoverage(corpus);
  assert.equal(coverage.case_count, 100);
  assert.equal(coverage.top_task_type_count, 15);
  assert.equal(coverage.covered_task_type_count, 15);
  assert.equal(coverage.top_task_type_comment_total, 5599);
  assert.equal(coverage.mapped_comment_total, 5599);
  assert.equal(coverage.directly_covered_comment_total, 5599);
  assert.equal(coverage.mapped_top_task_type_rate, 1);
  assert.ok(coverage.mapped_actionable_comment_rate > 0.8);
  assert.equal(Object.values(coverage.prompt_specificity).reduce((sum, count) => sum + count, 0), 100);
  assert.ok((coverage.prompt_specificity.terse || 0) >= 15);
  assert.ok((coverage.prompt_specificity.research_required || 0) >= 4);
  assert.equal(generalRevitPromptSpecificity(corpus.cases.find((entry) => entry.case_id === "c01_hru_eru_terse")!), "terse");
  assert.equal(generalRevitGroundingDemand(corpus.cases.find((entry) => entry.case_id === "c27_connect_diffuser_terse")!), "high");
  assert.equal(generalRevitResearchDemand(corpus.cases.find((entry) => entry.case_id === "c41_ashrae170_or_diffuser_review")!), "required");
});

test("sample fixture adapters bind discipline-specific tasks without changing the frozen prompts", () => {
  const fixtures = loadGeneralRevitSampleFixtures(corpus.cases);
  assert.equal(generalRevitFixtureForCase(fixtures, "q01_air_device_inventory"), "snowdon_hvac");
  assert.equal(generalRevitFixtureForCase(fixtures, "r09_pipe_size_transition"), "snowdon_plumbing");
  assert.equal(generalRevitFixtureForCase(fixtures, "c20_add_duplex_match_circuit"), "snowdon_electrical");
  assert.equal(fixtures.fixtures.snowdon_hvac.document_title, "Snowdon Towers Sample HVAC");
  assert.equal(fixtures.fixtures.snowdon_plumbing.sample_filename, "Snowdon Towers Sample Plumbing.rvt");
  assert.equal(fixtures.fixtures.snowdon_electrical.sample_filename, "Snowdon Towers Sample Electrical.rvt");
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

test("a certified read-only surface fallback remains a capability refusal", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "lh04_titleblock_initials_discovery")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "The certified read-only surface exposes only document/view context. It does not expose sheet contents, titleblock instances, parameters, or family text, so I cannot complete the requested audit.",
    effect_state: "not_dispatched"
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
  assert.equal(result.verification_basis, "none");
});

test("a durable blocked assignment remains an accepted clarification when essential spatial grounding is missing", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "r03_add_family_instance")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "I’m blocked by missing spatial context: the active view is the Cover Sheet, with no selection or test location. Please activate the target plan and select a nearby device—or provide a room number.",
    assignment_projection: { assignments: [{ lifecycle: { phase: "blocked" } }] }
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
  assert.equal(verified.verification_basis, "model_state_readback");
});

test("safe mode scores the safe probe contract without weakening production mutation truth", () => {
  const productionCase = corpus.cases.find((candidate) => candidate.case_id === "c03_level4_enlarged_plan_terse")!;
  assert.equal(productionCase.expected_effect, "apply");
  const safeCase = generalRevitExecutionCase(productionCase, false);
  assert.equal(safeCase.expected_effect, "preview");
  assert.equal(productionCase.expected_effect, "apply");
  assert.equal(generalRevitExecutionCase(productionCase, true), productionCase);
  const inspectionProbe = generalRevitExecutionCase({ ...productionCase, probe_expected_effect: "read" }, false);
  assert.equal(inspectionProbe.expected_effect, "read");

  const result = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ok: true,
    effect_state: "read_only_dispatched",
    actions: [{ path: safeCase.dispatch_any_of[0], request_effect: "preview", request_dispatched: true }]
  });
  assert.equal(result.tier, "previewed");
  assert.equal(result.completed, true);
  assert.equal(result.apply_dispatched, false);
});

test("aggregate results never turn non-refusal into a completion claim", () => {
  const entry = corpus.cases[0];
  const accepted = evaluateGeneralRevitCapabilityAttempt(entry, { ok: true, assistant_message: "Which equipment should I change?" });
  const completed = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "509 total: Supply Grille - Double Deflection - Curve Face Rectangular Neck 266; Return Grille - Double Deflection - Curve Face Rectangular Neck 138; Air Terminal-Exhaust Cap-FB 37; Air Terminal-Supply Cap-FB 37; Supply Diffuser - Square - Hosted 28; Return Grille - Perforated - Rectangular Face Rectangular Neck 2; Supply Diffuser with Plenum - Linear Slot - Hosted 1.",
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
    assistant_message: "509 total: Supply Grille - Double Deflection - Curve Face Rectangular Neck 266; Return Grille - Double Deflection - Curve Face Rectangular Neck 138; Air Terminal-Exhaust Cap-FB 37; Air Terminal-Supply Cap-FB 37; Supply Diffuser - Square - Hosted 28; Return Grille - Perforated - Rectangular Face Rectangular Neck 2; Supply Diffuser with Plenum - Linear Slot - Hosted 1.",
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
  assert.equal(result.verification_basis, "fixture_semantic_oracle");
});

test("fixture-grounded air-terminal inventory requires the exact seven-group reconciliation", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "q01_air_device_inventory")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "509 air terminals. The largest group has 267 and the rest are omitted.",
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" }]
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.answer_assertion_passed, false);
});

test("fixture-grounded answer assertions reject a tool-backed but semantically wrong diffuser count", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "q02_air_devices_terse")!;
  assert.ok(entry.answer_assertions);
  const assignment_projection = {
    assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
      verification: { state: "verified", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "read" }
    }]
  };
  const correct = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "29 diffusers: 28 Supply Diffuser – Square – Hosted and 1 Supply Diffuser with Plenum — Linear Slot — Hosted.",
    assignment_projection
  });
  assert.equal(correct.tier, "verified");
  assert.equal(correct.answer_assertion_passed, true);
  assert.equal(correct.verification_basis, "fixture_semantic_oracle");

  const wrong = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Diffuser count: 435, including supply and return grilles.",
    assignment_projection
  });
  assert.equal(wrong.tier, "failed");
  assert.equal(wrong.completed, false);
  assert.equal(wrong.verified, false);
  assert.equal(wrong.answer_assertion_passed, false);
  assert.match(wrong.summary, /fixture-grounded answer assertions failed/i);
});

test("durable read evidence cannot satisfy a preview contract without matching effect truth", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "s03_schedule_filter")!, false);
  const assignment = {
    lifecycle: { phase: "complete" },
    evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
    verification: { state: "verified", criteria: [{ status: "pass" }] },
    execution: { requested_effect: "read" }
  };
  const failed = evaluateGeneralRevitCapabilityAttempt(entry, { ok: true, assignment_projection: { assignments: [assignment] } });
  assert.equal(failed.tier, "failed");
  assert.equal(failed.completed, false);
  const previewed = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assignment_projection: { assignments: [{ ...assignment, execution: { requested_effect: "preview" } }] }
  });
  assert.equal(previewed.tier, "verified");
  assert.equal(previewed.completed, true);
});

test("execution failures remain non-refusals while still failing completion", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "b06_edit_loaded_family")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, { ok: false, error: "The Revit call timed out.", effect_state: "not_dispatched" });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
});

test("a failed substantive Revit tool is a truthful execution failure", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "cx01_dynamic_hru_to_eru_program")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "The sandbox worker failed during startup and no preview was produced.",
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/dynamic-runtime", request_effect: "preview", request_dispatched: false, status: "failed" }]
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
});

test("a later successful retry recovers the same substantive Revit lane without erasing failure history", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c01_hru_eru_terse")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Preview complete; rollback verified.",
    effect_state: "read_only_dispatched",
    actions: [
      { path: "/revit/dynamic-runtime", request_effect: "preview", request_dispatched: false, status: "failed" },
      { path: "/revit/dynamic-runtime", request_effect: "preview", request_dispatched: true, status: "success", receipt: { readback: { count: 37 } } },
      { path: "/revit/dynamic-runtime/preview", request_effect: "preview", request_dispatched: true, status: "success", receipt: { rollback_verified: true } }
    ]
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "rollback_verified_preview");
});

test("a failed tool attempt does not suppress a terminal capability refusal", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c01_hru_eru_terse")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "I can’t produce the requested preview. Element discovery is not exposed in this profile and the Revit connection is not live.",
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/dynamic-runtime", request_effect: "preview", request_dispatched: false, status: "failed" }]
  });
  assert.equal(result.tier, "refused");
  assert.equal(result.non_refusal, false);
  assert.equal(result.completed, false);
});

test("grounded evidence that proves a requested edit is blocked is not completion", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "s05_schedule_value_edit")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "## Blocked — nothing applied\nNo qualifying row exists in the current schedules to preview safely.",
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/update-schedule-cell", request_effect: "preview", request_dispatched: true, status: "success", receipt: { readback: { rows: 0 } } }]
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
});

test("generated-code preview, apply, and readback receipts score as verified UI execution", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "cx01_dynamic_hru_to_eru_program")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Changed 37 HRU marks to ERU and verified zero HRU marks remain.",
    effect_state: "apply_dispatched",
    actions: [
      { path: "/revit/dynamic-runtime/preview", request_effect: "preview", request_dispatched: true, status: "success" },
      { path: "/revit/dynamic-runtime/apply", request_effect: "apply", request_dispatched: true, status: "success" }
    ],
    receipts: [{ schema: "dynamic-revit-apply-receipt/v1", outcome: "committed_verified" }],
    verification_results: [{ readback: { remaining_hru: 0, eru: 37 } }]
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.apply_dispatched, true);
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "model_state_readback");
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

test("a read-only fallback cannot pass a mutation benchmark", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "dp01_individual_bw_pdf_set")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Identified three suitable sheets. No exports were performed.",
    effect_state: "not_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_list_sheets completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }
      }]
    }
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.non_refusal, true);
  assert.equal(result.apply_dispatched, false);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
  assert.match(result.summary, /did not dispatch a verified apply operation/i);
});
