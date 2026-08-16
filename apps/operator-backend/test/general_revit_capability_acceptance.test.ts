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
  assert.match(runner, /async function waitForComputerIdle/);
  assert.match(runner, /computerStateHasMessage\(state, messageId\)/);
  assert.match(runner, /refusing to grade another runner's state/);
  assert.match(runner, /settleTimedOutComputerRun/);
  assert.match(runner, /the benchmark is stopping instead of contaminating later cases with live-context contention/);
  assert.match(runner, /--legacy-chat is retained only for transport diagnostics/);
  assert.doesNotMatch(runner, /const useComputer = process\.argv\.includes\("--ui"\)/);
});

test("benchmark wrapper orchestrates sample fixtures by default unless one is pinned", () => {
  const wrapperRoot = path.basename(repoRoot()).toLowerCase() === "apps" ? path.resolve(repoRoot(), "..") : repoRoot();
  const wrapper = fs.readFileSync(path.join(wrapperRoot, "scripts", "run_general_revit_benchmark.ps1"), "utf8");
  assert.match(wrapper, /if \(\$Fixture\) \{ \$runnerArgs \+= @\("--fixture", \$Fixture\) \} else \{ \$runnerArgs \+= "--orchestrate-fixtures" \}/);
  assert.match(wrapper, /--fixture-root/);
  assert.match(wrapper, /--case/);
});

test("benchmark groups cases by fixture and fails closed on an unpinned mixed-model run", () => {
  const runner = source("operator-backend/src/tools/general_revit_capability_acceptance.ts");
  assert.match(runner, /--orchestrate-fixtures/);
  assert.match(runner, /async function ensureFixtureActive/);
  assert.match(runner, /\/api\/benchmark\/revit-fixture\/open/);
  assert.match(runner, /opened_deterministically/);
  assert.match(runner, /Selected cases span multiple sample models/);
  assert.match(runner, /revit_open_model/);
  assert.match(runner, /discardExistingOpenDocument=true/);
  assert.match(runner, /continueOnUnresolvedReferences=true/);
  assert.match(runner, /ignore that warning and continue opening this disposable sample fixture/);
  assert.match(runner, /explicitly authorized to close it without saving and reopen it/);
  assert.match(runner, /await stopComputerRunBestEffort\(baseUrl\)/);
  assert.match(runner, /the abandoned Operator turn was stopped/);
  assert.match(runner, /targetVerifiedWhileAgentRunning/);
  assert.match(runner, /healthDocumentTitle\(after\) === fixture\.document_title/);
  assert.match(runner, /stale pre-open binding until the fixture timeout expires/);
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

test("Snowdon-safe probes use live fixture targets and recover from an unsuitable active view", () => {
  const schedule = corpus.cases.find((entry) => entry.case_id === "r13_schedule_airflow_sync");
  const namedScheduleFilter = corpus.cases.find((entry) => entry.case_id === "s06_filter_named_schedule");
  const neighborTagType = corpus.cases.find((entry) => entry.case_id === "c19_match_neighbor_tag_type");
  const accessoryType = corpus.cases.find((entry) => entry.case_id === "c22_accessory_type_match");
  const connectedMove = corpus.cases.find((entry) => entry.case_id === "c23_move_damper_upstream");
  const viewRange = corpus.cases.find((entry) => entry.case_id === "c31_fix_view_range_terse");
  assert.match(schedule?.probe_prompt || "", /Supply Air Pressure Drop/i);
  assert.doesNotMatch(schedule?.probe_prompt || "", /Supply Airflow/i);
  assert.match(namedScheduleFilter?.probe_prompt || "", /discover one existing named mechanical-equipment schedule/i);
  assert.match(namedScheduleFilter?.probe_prompt || "", /prefix present in its current Mark values/i);
  assert.doesNotMatch(namedScheduleFilter?.probe_prompt || "", /TEST MECHANICAL EQUIPMENT/i);
  assert.match(neighborTagType?.probe_prompt || "", /if they are already type-consistent/i);
  assert.match(neighborTagType?.probe_prompt || "", /structured no-op or compatibility receipt/i);
  assert.match(accessoryType?.probe_prompt || "", /two placed Air Terminal instances with different loaded type IDs/i);
  assert.match(accessoryType?.probe_prompt || "", /need not be from the same family/i);
  assert.match(accessoryType?.probe_prompt || "", /matching MEP system or service classification and connector flow direction/i);
  assert.match(accessoryType?.probe_prompt || "", /Supply-to-Return or Return-to-Supply is not a compatible match/i);
  assert.ok(accessoryType?.answer_assertions);
  assert.ok(accessoryType?.fixture_blocker_assertions);
  assert.doesNotMatch(accessoryType?.probe_prompt || "", /damper/i);
  assert.match(connectedMove?.probe_prompt || "", /Air Terminal or other connected HVAC family instance/i);
  assert.doesNotMatch(connectedMove?.probe_prompt || "", /damper/i);
  assert.match(viewRange?.probe_prompt || "", /active view is not a plan/i);
  assert.match(viewRange?.probe_prompt || "", /find one eligible non-template mechanical floor plan yourself/i);
  assert.equal(viewRange?.allow_verified_noop, true);
  assert.match(JSON.stringify(viewRange?.answer_assertions), /9948/);
  assert.match(JSON.stringify(viewRange?.answer_assertions), /underlay/i);
});

test("titleblock mutation coverage is paired with the live read-only regression wording", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "c36_titleblock_initials_all_mech");
  assert.ok(entry);
  assert.equal(entry.expected_effect, "apply");
  assert.equal(entry.probe_expected_effect, undefined);
  assert.equal(
    entry.probe_prompt,
    "Independently read back every mechanical sheet. Return each sheet number with its Drawn By and Checked By values, and count any mismatches from EP / QA. Do not change anything."
  );
});

test("fixture oracles accept truthful view-rename no-ops and verify the bounded HVAC PDF preflight", () => {
  const viewNames = corpus.cases.find((candidate) => candidate.case_id === "c02_clean_level2_view_names");
  const pdf = corpus.cases.find((candidate) => candidate.case_id === "dp02_combined_discipline_pdf");
  assert.ok(viewNames?.answer_assertions);
  assert.ok(pdf?.answer_assertions);
  const noRenameAnswer = "L2 views 9948 and 1371629: No rename required; both already follow the level name pattern.";
  for (const pattern of viewNames.answer_assertions.must_match) {
    assert.match(noRenameAnswer, new RegExp(pattern, "i"));
  }
  const pdfAnswer = "Combined: Yes\nColor: Color\nM200 M201 M202 M203 M204 M205 M206; planned page count: 7; TEST-MECHANICAL-ISSUE.pdf; verify content hash with SHA-256. No PDF was created.";
  for (const pattern of pdf.answer_assertions.must_match) {
    assert.match(pdfAnswer, new RegExp(pattern, "i"));
  }
});

test("the MEP peer oracle rejects the captured Supply-to-Return dry-run despite a successful native receipt", () => {
  const safeCase = generalRevitExecutionCase(
    corpus.cases.find((candidate) => candidate.case_id === "c22_accessory_type_match")!,
    false
  );
  const successfulPreview = {
    ok: true,
    effect_state: "read_only_dispatched" as const,
    actions: [{
      path: "/revit/change-element-type",
      request_effect: "preview",
      request_dispatched: true,
      status: "success",
      result: { ok: true, dryRun: true, preconditionMatched: true, elementId: 1394022 }
    }]
  };
  const wrong = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...successfulPreview,
    assistant_message: `The service classification differs—Supply versus Return—but Revit accepted the loaded peer type.
\`\`\`json
{"ok":true,"dryRun":true,"preconditionMatched":true}
\`\`\``
  });
  assert.equal(wrong.tier, "failed");
  assert.equal(wrong.completed, false);
  assert.equal(wrong.answer_assertion_passed, false);
  assert.ok(wrong.answer_assertion_failures.some((failure) => failure.startsWith("forbidden:")));

  const compatible = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...successfulPreview,
    assistant_message: `Matching system classification: Supply Air for both; matching connector flow direction: Out for both.
\`\`\`json
{"ok":true,"dryRun":true,"preconditionMatched":true}
\`\`\``
  });
  assert.equal(compatible.answer_assertion_passed, true);
  assert.equal(compatible.completed, true);
});

test("the MEP peer oracle accepts the captured Snowdon incompatibility blocker without awarding completion", () => {
  const safeCase = generalRevitExecutionCase(
    corpus.cases.find((candidate) => candidate.case_id === "c22_accessory_type_match")!,
    false
  );
  const inspected = {
    ok: true,
    effect_state: "read_only_dispatched" as const,
    actions: [
      { path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" },
      { path: "/revit/get-connectors", request_effect: "read", request_dispatched: true, status: "success" }
    ]
  };
  const truthful = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    assistant_message: `## Blocked — no compatible peer type

Live inspection found exactly 7 loaded Air Terminal types. No two different types preserve all required invariants.
The closest geometric matches are Supply Air and Return Air, which is a cross-service substitution.
No native type-change dry-run was executed, and nothing was applied or saved.`
  });
  assert.equal(truthful.tier, "accepted");
  assert.equal(truthful.completed, false);
  assert.equal(truthful.verified, false);
  assert.equal(truthful.answer_assertion_passed, false);
  assert.equal(truthful.fixture_blocker_assertion_passed, true);
  assert.equal(truthful.fixture_blocker_accepted, true);
  assert.match(truthful.summary, /sample lacks a semantically compatible target/i);

  const vague = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    assistant_message: "## Blocked\nI couldn't find a good type, so I stopped."
  });
  assert.equal(vague.tier, "failed");
  assert.equal(vague.fixture_blocker_accepted, false);
});

test("both backend agent prompts prefer sheet-aware parameter readback before generic parameter scans", () => {
  const codexPrompt = source("operator-backend/src/brains/codex_brain.ts");
  const openAiPrompt = source("operator-backend/src/brains/openai_brain.ts");
  for (const prompt of [codexPrompt, openAiPrompt]) {
    assert.match(prompt, /Sheet\/titleblock parameter reads and verification must be sheet-aware/);
    assert.match(prompt, /do not probe sheet or titleblock element IDs with generic/);
    assert.match(prompt, /Fall back only when the sheet-aware primitive returns no match/);
  }
});

test("both backend agent prompts reject API-valid cross-service MEP peer substitutions", () => {
  const codexPrompt = source("operator-backend/src/brains/codex_brain.ts");
  const openAiPrompt = source("operator-backend/src/brains/openai_brain.ts");
  for (const prompt of [codexPrompt, openAiPrompt]) {
    assert.match(prompt, /MEP peer-precedent rule/);
    assert.match(prompt, /API-accepted type swap is not by itself semantic compatibility/);
    assert.match(prompt, /system\/service classification, connector flow direction/);
    assert.match(prompt, /report the concrete blocker instead of previewing or applying a cross-service substitution/);
  }
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

test("a nested teammate preview receipt satisfies the preview effect through delegate_revit_task", () => {
  const safeCase = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "r02_add_tag")!, false);
  const result = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ok: true,
    effect_state: "read_only_dispatched",
    actions: [{ path: "", request_effect: "read", request_dispatched: true, status: "success" }],
    teammate_loop_receipt: {
      turn_kind: "inspection",
      stage: "report",
      preview_action_ids: ["mcp:1", "mcp:2"],
      apply_attempts: 0,
      verified: false,
      blocked_reason: null
    },
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] }
      }]
    }
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "structured_preview_receipt");
  assert.equal(result.apply_dispatched, false);
});

test("aggregate results never turn non-refusal into a completion claim", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "b01_equipment_rename")!, false);
  const accepted = evaluateGeneralRevitCapabilityAttempt(entry, { ok: true, assistant_message: "Which equipment should I change?" });
  const completed = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "509 total: Supply Grille - Double Deflection - Curve Face Rectangular Neck 266; Return Grille - Double Deflection - Curve Face Rectangular Neck 138; Air Terminal-Exhaust Cap-FB 37; Air Terminal-Supply Cap-FB 37; Supply Diffuser - Square - Hosted 28; Return Grille - Perforated - Rectangular Face Rectangular Neck 2; Supply Diffuser with Plenum - Linear Slot - Hosted 1.",
    effect_state: "read_only_dispatched",
    rounds: [{ actions: [{ path: entry.dispatch_any_of[0], request_effect: "preview" }] }]
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

test("backend-observed export artifact paths independently verify a visual read assignment", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "b12_visual_observe_verify")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Captured L2 and inspected 684 visible elements. No model changes were performed.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: {
          entries: [{
            summary: "Live tool revit_call_tool completed.",
            artifact_paths: ["C:/Users/Eli/AppData/Local/RevitOperator/Workspace/artifacts/captures/selection/Revit_9948_inventory.jpg"]
          }],
          artifact_paths: ["C:/Users/Eli/AppData/Local/RevitOperator/Workspace/artifacts/captures/selection/Revit_9948_inventory.jpg"]
        },
        verification: { state: "verified", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "read" }
      }]
    }
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "artifact_evidence");
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

  const equivalentWithoutHostedSuffix = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "29 diffuser-named units.\nSupply Diffuser – Square / 12x12 | 28\nSupply Diffuser with Plenum – Linear Slot / 48x4 | 1",
    assignment_projection
  });
  assert.equal(equivalentWithoutHostedSuffix.tier, "verified");
  assert.equal(equivalentWithoutHostedSuffix.answer_assertion_passed, true);

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

  const wrongBreakdown = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "29 diffusers.\nSupply Diffuser – Square | 27\nSupply Diffuser with Plenum – Linear Slot | 2",
    assignment_projection
  });
  assert.equal(wrongBreakdown.tier, "failed");
  assert.equal(wrongBreakdown.answer_assertion_passed, false);
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
  assert.equal(previewed.tier, "previewed");
  assert.equal(previewed.completed, true);
  assert.equal(previewed.verified, false);
  assert.equal(previewed.verification_basis, "durable_server_validation");
});

test("fixture-grounded zero-candidate preview completes only with durable verified-noop truth", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c34_sheet_numbers_dashes_to_dots")!, false);
  assert.equal(entry.expected_effect, "preview");
  assert.equal(entry.allow_verified_noop, true);
  const assistant_message = [
    "Sheets inspected: 17 of 17",
    "Dashed candidates: 0",
    "Model changes: None",
    "No renaming action is necessary."
  ].join("\n");
  const durableNoop = {
    assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_list_sheets completed." }] },
      verification: { state: "verified", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "preview", completion_mode: "verified_noop" }
    }]
  };
  const verified = evaluateGeneralRevitCapabilityAttempt(entry, { ok: true, assistant_message, assignment_projection: durableNoop });
  assert.equal(verified.tier, "verified");
  assert.equal(verified.completed, true);
  assert.equal(verified.answer_assertion_passed, true);
  assert.equal(verified.verification_basis, "fixture_semantic_oracle");

  const naturalLanguage = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "No mechanical sheet numbers contain a dash, so the preview table is empty. All **17** sheets are mechanical M-sheets. No sheets were renamed or modified.",
    assignment_projection: durableNoop
  });
  assert.equal(naturalLanguage.tier, "verified");
  assert.equal(naturalLanguage.answer_assertion_passed, true);

  const liveWording = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Reviewed all **17 project sheets**. No mechanical sheet number contains a dash, so there are no proposed renames.",
      "| Sheet Name | Old sheet number | Proposed dot number | Uniqueness status | Ordering status |",
      "| *No matching sheets* | — | — | Not applicable | Not applicable |",
      "No sheets were renamed or modified."
    ].join("\n"),
    assignment_projection: durableNoop
  });
  assert.equal(liveWording.tier, "verified");
  assert.equal(liveWording.answer_assertion_passed, true);

  const proseOnly = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message,
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/sheets", request_effect: "read", request_dispatched: true, status: "success" }]
  });
  assert.equal(proseOnly.tier, "failed");
  assert.equal(proseOnly.completed, false);

  const wrongCount = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Sheets inspected: 17 of 17\nDashed candidates: 2\nModel changes: None",
    assignment_projection: durableNoop
  });
  assert.equal(wrongCount.tier, "failed");
  assert.equal(wrongCount.answer_assertion_passed, false);
});

test("Snowdon view-range no-op accepts the grounded live Markdown receipt", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c31_fix_view_range_terse")!, false);
  const assistant_message = [
    "## Preview blocked — model unchanged",
    "- Chosen eligible plan: **L2** — ID `9948`, Mechanical, non-template.",
    "| Bottom | L2 (`9946`) | 0′ |",
    "| View Depth | L2 (`9946`) | 0′ |",
    "Underlay is already **None**.",
    "No defensible adjustment was identified: Bottom and View Depth already stop at L2.",
    '{ "status": "blocked_no_defensible_change", "proposedChange": null, "modelAltered": false }'
  ].join("\n");
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message,
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_native_api_ops completed." }] },
        verification: { state: "verified", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "preview", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(result.answer_assertion_passed, true);
  assert.equal(result.tier, "verified");
  assert.equal(result.verification_basis, "fixture_semantic_oracle");

  const exactLatestLiveReceipt = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "## View Range preview",
      "- **Chosen view:** `L2` — ID `9948`, non-template Mechanical Floor Plan.",
      "| Bottom | L2 | 0 ft |",
      "| View Depth | L2 | 0 ft |",
      "Underlay is disabled.",
      "**No change.** Bottom and View Depth already stop at L2, so the View Range does not extend to the floor below. Altering it would not be defensible without evidence that View Range is causing the visibility.",
      '{ "status": "no_op", "viewId": 9948, "proposedChanges": [], "dryRun": true, "applied": false, "modelModified": false }'
    ].join("\n"),
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_native_api_ops completed." }] },
        verification: { state: "verified", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "preview", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(exactLatestLiveReceipt.answer_assertion_passed, true);
  assert.equal(exactLatestLiveReceipt.tier, "verified");
});

test("Snowdon family evolution read-only plan requires fixture-grounded identity and dimensions", () => {
  const entry = loadGeneralRevitCapabilityCorpus().cases.find((candidate) => candidate.case_id === "b06_edit_loaded_family");
  assert.ok(entry);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Instance: Element 1365188",
      "Mark: HRU202",
      "Family: HeatRecoveryUnit",
      "Source type: Heat Recovery Unit (HRU), type ID 1365172",
      "Width: 3.333333 ft = 40 in",
      "Length: 4.035433 ft = 48.43 in",
      "No family was opened, edited, saved, loaded, reloaded, or swapped. No model changes resulted."
    ].join("\n"),
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "read" }
      }]
    }
  });
  assert.equal(result.answer_assertion_passed, true);
  assert.equal(result.tier, "verified");
  assert.equal(result.verification_basis, "fixture_semantic_oracle");
});

test("durable validation and successful-action wrappers do not impersonate model-state verification", () => {
  const entry = { ...corpus.cases.find((candidate) => candidate.case_id === "s03_schedule_filter")!, expected_effect: "apply" as const };
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    effect_state: "apply_dispatched",
    actions: [{ path: "/revit/configure-schedule", request_effect: "apply", request_dispatched: true, status: "success" }],
    verification_results: [{ path: "/revit/configure-schedule", status: "success", receipt: { status: "Success" } }],
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply" }
      }]
    }
  });
  assert.equal(result.tier, "completed");
  assert.equal(result.completed, true);
  assert.equal(result.verified, false);
  assert.equal(result.verification_basis, "durable_server_validation");
});

test("grounded verification checks remain eligible model-state evidence", () => {
  const entry = { ...corpus.cases.find((candidate) => candidate.case_id === "s03_schedule_filter")!, expected_effect: "apply" as const };
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    effect_state: "apply_dispatched",
    actions: [{ path: "/revit/configure-schedule", request_effect: "apply", request_dispatched: true, status: "success" }],
    verification_results: [{ name: "filter_count", ok: true, expected: 1, actual: 1 }]
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "model_state_readback");
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

test("a committed verified Dynamic Revit program is a valid general fallback for a typed mutation case", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "lh01_bulk_hru_to_eru_marks")!;
  const applyReceipt = JSON.stringify({
    schema: "dynamic-revit-apply-receipt/v1",
    outcome: "committed_verified",
    changed_element_ids: [1366896],
    operation_results: [{
      operation_id: "sha256:test",
      kind: "set_parameter",
      target: "element-1366896",
      parameter: "Mark",
      before: "HRU109A",
      after: "ERU109A"
    }]
  });
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Changed the complete bounded set and verified zero HRU marks remain.",
    effect_state: "apply_dispatched",
    actions: [{
      path: "/revit/dynamic-runtime",
      request_effect: "apply",
      request_dispatched: true,
      status: "success",
      receipt: { result: { evidence: { applyReceipt } } }
    }]
  });
  assert.equal(entry.dispatch_any_of.includes("/revit/dynamic-runtime"), false);
  assert.equal(result.expected_path_observed, true);
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "model_state_readback");
});

test("an ungrounded Dynamic Revit apply receipt cannot satisfy a typed mutation case", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "lh01_bulk_hru_to_eru_marks")!;
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Applied the requested rename.",
    effect_state: "apply_dispatched",
    actions: [{
      path: "/revit/dynamic-runtime",
      request_effect: "apply",
      request_dispatched: true,
      status: "success",
      receipt: { result: { evidence: { applyReceipt: JSON.stringify({
        schema: "dynamic-revit-apply-receipt/v1",
        outcome: "committed_verified"
      }) } } }
    }]
  });
  assert.equal(result.expected_path_observed, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);
  assert.equal(result.tier, "planned");
});

test("target-bound teammate verification requires an action-bound evidence digest", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "c03_level4_enlarged_plan_terse")!;
  const durable = {
    assignments: [{
      lifecycle: { phase: "complete" },
      execution: { requested_effect: "apply" },
      evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] }
    }]
  };
  const audited = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Created and read back the requested view.",
    teammate_loop_receipt: {
      turn_kind: "mutation", stage: "report", apply_action_id: "mcp:1",
      verification_action_ids: ["mcp:2"], apply_attempts: 1, verified: true,
      verification_mode: "target_bound_readback", verification_action_id: "mcp:2",
      verification_evidence_sha256: `sha256:${"a".repeat(64)}`, blocked_reason: null
    },
    assignment_projection: durable
  });
  assert.equal(audited.tier, "verified");
  assert.equal(audited.verification_basis, "target_bound_model_state");

  const unexplainedBoolean = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Created the requested view.",
    teammate_loop_receipt: {
      turn_kind: "mutation", stage: "report", apply_action_id: "mcp:1",
      verification_action_ids: ["mcp:2"], apply_attempts: 1, verified: true,
      blocked_reason: null
    },
    assignment_projection: durable
  });
  assert.equal(unexplainedBoolean.completed, true);
  assert.equal(unexplainedBoolean.verified, false);
  assert.notEqual(unexplainedBoolean.verification_basis, "target_bound_model_state");
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

test("a fixture-oracled no-op can verify an already-satisfied conditional mutation without inventing a write", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "c02_clean_level2_view_names")!;
  assert.equal(entry.allow_verified_noop, true);
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Pattern: each view name exactly matches its associated level name. L2 already conforms. Renames: none required.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.apply_dispatched, false);
  assert.equal(result.verification_basis, "fixture_semantic_oracle");
  assert.match(result.summary, /already satisfied/i);

  const liveTraceResult = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Inspected and verified all 10 HVAC floor-plan views. The established pattern is view name = associated level/area name, preserving identifiers such as Block 35. The Level 2 view already conforms: L2 -> L2 (view ID 9948). No renames were required. No elements or other views were changed.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [
          { summary: "Live tool revit_call_tool completed." },
          { summary: "Verified that the requested Revit state was already satisfied using 2 substantive live evidence calls; no write was necessary." }
        ] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(liveTraceResult.tier, "verified");
  assert.equal(liveTraceResult.completed, true);
  assert.equal(liveTraceResult.verified, true);
  assert.equal(liveTraceResult.apply_dispatched, false);
  assert.equal(liveTraceResult.verification_basis, "fixture_semantic_oracle");

  const blockQualifiedLiveTraceResult = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Inspected all 10 Mechanical/HVAC floor-plan views. The established pattern is view name = associated level/block name. The Level 2 view already conforms: 9948: L2 -> level L2. No views were renamed, and no model content was altered. Final readback verified the name remains L2.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [
          { summary: "Live tool revit_call_tool completed." },
          { summary: "Verified that the requested Revit state was already satisfied using 5 substantive live evidence calls; no write was necessary." }
        ] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(blockQualifiedLiveTraceResult.tier, "verified");
  assert.equal(blockQualifiedLiveTraceResult.completed, true);
  assert.equal(blockQualifiedLiveTraceResult.verified, true);
  assert.equal(blockQualifiedLiveTraceResult.apply_dispatched, false);
  assert.equal(blockQualifiedLiveTraceResult.verification_basis, "fixture_semantic_oracle");

  const ungrounded = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Pattern: each view name exactly matches its associated level name. L2 already conforms. Renames: none required.",
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/views", request_effect: "read", request_dispatched: true, status: "success" }]
  });
  assert.equal(ungrounded.tier, "failed");
  assert.equal(ungrounded.completed, false);

  const untypedCompletion = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Pattern: each view name exactly matches its associated level name. L2 already conforms. Renames: none required.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply" }
      }]
    }
  });
  assert.equal(untypedCompletion.tier, "failed");
  assert.equal(untypedCompletion.verified, false);
});

test("the Snowdon HRU schedule dry run is verified only when its fixture facts and independent checks are complete", () => {
  const entry = generalRevitExecutionCase(
    corpus.cases.find((candidate) => candidate.case_id === "lh02_hru_schedule_transform_verify")!,
    false
  );
  assert.ok(entry.answer_assertions);

  const assistantMessage = [
    "No model changes, schedule creation, configuration, placement, or saves were performed.",
    "Existing comparable schedule: Heat Recovery Unit Summary, ID 1488968.",
    "It contains 37 item rows and shows Grand total: 37.",
    "Family: HeatRecoveryUnit. Type: Heat Recovery Unit (HRU).",
    "Current baseline is ERU model count 0; the independent model count where Mark begins with ERU is 0.",
    "Proposed temporary QA schedule: clone it as TEMP - HRU to ERU QA, retain Mark, Family, and Type, and filter Mark begins with ERU.",
    "Sort/group: Sort by Mark; Ascending.",
    "Expected schedule rows after conversion: 37.",
    "Current duplicates: none; direct prefix substitution has no projected duplicates.",
    "Independent acceptance requires Model count = schedule row count, No blank Marks, and No duplicate Marks.",
    "Dry-run receipt: model changes: none."
  ].join("\n");
  const attempt = {
    ok: true,
    assistant_message: assistantMessage,
    effect_state: "read_only_dispatched" as const,
    actions: [{ path: "/revit/schedules", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [{ summary: "Live substantive schedule and model queries completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "read" }
      }]
    }
  };

  const verified = evaluateGeneralRevitCapabilityAttempt(entry, attempt);
  assert.equal(verified.tier, "verified");
  assert.equal(verified.verified, true);
  assert.equal(verified.verification_basis, "fixture_semantic_oracle");

  const liveSemanticResponse = [
    "Existing comparable schedule: **Heat Recovery Unit Summary** — ID `1488968`.",
    "Existing schedule contains **37 item rows**, with `Grand total: 37`.",
    "Family: `HeatRecoveryUnit`. Type: `Heat Recovery Unit (HRU)`.",
    "Independent whole-model query found: **37** marks beginning with `HRU`; **0** instances matching `ERU` across identity, Mark, Family, or Type. All 37 current HRU marks are unique.",
    "## Proposed temporary QA schedule",
    "Name: `TEMP – ERU Mark QA`. Fields: Mark, Family, Type. Preferred filter: Mark begins with `ERU`.",
    "Sort/group: Sort by `Mark`; Ascending.",
    "Independent acceptance requires Model count = schedule row count, No blank Mark values, and No duplicate Mark values.",
    "Current baseline is ERU model count 0 / proposed schedule rows 0. The expected post-change result is 37 ERU instances and 37 schedule rows.",
    "No schedules or model data were created, configured, modified, or saved."
  ].join("\n");
  const liveVerified = evaluateGeneralRevitCapabilityAttempt(entry, { ...attempt, assistant_message: liveSemanticResponse });
  assert.equal(liveVerified.tier, "verified");
  assert.equal(liveVerified.verified, true);

  const freshLiveTableResponse = [
    "Best reference: Heat Recovery Unit Summary — schedule ID 1488968.",
    "Schedule displays 37 HRU instances and Grand total: 37.",
    "| ERU—literal family/type/name/Mark/text | **0** | N/A |",
    "| HRU | **37** | **37** |",
    "| Blank HRU Marks | **0** | **0** |",
    "| Duplicate HRU Marks | **None** | **None observed** |",
    "All 37 HRUs are `HeatRecoveryUnit : Heat Recovery Unit (HRU)`.",
    "## Actionable QA schedule plan",
    "Fields: Mark, Family, Type. Filter: Mark begins with ERU. Sort: Mark ascending.",
    "Independently rerun the query and require model ERU count = schedule row count; no blank Marks; no duplicate Marks.",
    "No schedule or model content was created, configured, or saved.",
    "If all 37 HRUs are intended to become ERUs, the expected post-migration target is **37**."
  ].join("\n");
  const freshLiveTableVerified = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: freshLiveTableResponse
  });
  assert.equal(freshLiveTableVerified.tier, "verified");
  assert.equal(freshLiveTableVerified.verified, true);

  for (const adversarialResponse of [
    freshLiveTableResponse.replace("ERU—literal family/type/name/Mark/text | **0**", "ERU—literal family/type/name/Mark/text | **5**"),
    freshLiveTableResponse.replace("Blank HRU Marks | **0**", "Blank HRU Marks | **1**"),
    freshLiveTableResponse.replace("Duplicate HRU Marks | **None**", "Duplicate HRU Marks | present"),
    freshLiveTableResponse.replace("expected post-migration target is **37**", "expected post-migration target is **36**"),
    freshLiveTableResponse.replace("No schedule or model content was created, configured, or saved.", "model changes: applied")
  ]) {
    const adversarialEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: adversarialResponse
    });
    assert.equal(adversarialEvaluation.tier, "failed");
    assert.equal(adversarialEvaluation.verified, false);
  }

  const latestLiveIncompleteResponse = [
    "Relevant schedule: Heat Recovery Unit Summary — View ID 1488968.",
    "Existing fields: Mark, Family, Type. Family: HeatRecoveryUnit. Type: Heat Recovery Unit (HRU).",
    "Schedule total: 37 HRUs; Grand total: 37. Independent document-level Mechanical Equipment query: 37 HRU instances, confirming the schedule total.",
    "ERU searches: Mark containing ERU: 0; Type containing ERU: 0; Family containing ERU: 0.",
    "No duplicate HRU Marks were found in the 37 returned records.",
    "Actionable temporary ERU QA schedule plan: use Mark begins with ERU and Sort by Mark, ascending.",
    "No schedules or model elements were created, configured, placed, or modified."
  ].join("\n");
  const latestLiveIncomplete = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: latestLiveIncompleteResponse
  });
  assert.equal(latestLiveIncomplete.tier, "failed");
  assert.equal(latestLiveIncomplete.answer_assertion_passed, false);
  assert.equal(latestLiveIncomplete.answer_assertion_failures.length, 2);
  assert.match(latestLiveIncomplete.answer_assertion_failures.join("\n"), /Expected|blank Mark/i);

  const latestLiveComplete = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: `${latestLiveIncompleteResponse}\nExpected post-change result: 37 ERU instances and 37 schedule rows. No blank Mark values.`
  });
  assert.equal(latestLiveComplete.tier, "verified");
  assert.equal(latestLiveComplete.answer_assertion_passed, true);

  const wrongExpectedCount = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: assistantMessage.replace("Expected schedule rows after conversion: 37", "Expected schedule rows after conversion: 36")
  });
  assert.equal(wrongExpectedCount.tier, "failed");
  assert.equal(wrongExpectedCount.verified, false);
  assert.match(wrongExpectedCount.answer_assertion_failures.join("\n"), /Expected/);

  const wrongCurrentCount = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: assistantMessage.replace("Mark begins with ERU is 0", "Mark begins with ERU is 5")
  });
  assert.equal(wrongCurrentCount.tier, "failed");
  assert.equal(wrongCurrentCount.verified, false);
  assert.ok(wrongCurrentCount.answer_assertion_failures.length > 0);

  const incompleteChecks = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: assistantMessage.replace("Independent acceptance requires Model count = schedule row count, No blank Marks, and No duplicate Marks.", "Verify the schedule later.")
  });
  assert.equal(incompleteChecks.tier, "failed");
  assert.equal(incompleteChecks.verified, false);
  assert.match(incompleteChecks.answer_assertion_failures.join("\n"), /Model|blank Mark|duplicate Mark/i);

  const liveWrongCurrentCount = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: liveSemanticResponse.replace("**0** instances matching `ERU`", "**5** instances matching `ERU`")
  });
  assert.equal(liveWrongCurrentCount.tier, "failed");
  assert.equal(liveWrongCurrentCount.verified, false);

  const mutatedModel = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: liveSemanticResponse.replace("No schedules or model data were created, configured, modified, or saved.", "model changes: applied")
  });
  assert.equal(mutatedModel.tier, "failed");
  assert.equal(mutatedModel.verified, false);
});
