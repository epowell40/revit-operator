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
import { localProcessIsAlive, localRevitProcessGuardTarget } from "../src/benchmark/local_revit_process_liveness.js";
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
  assert.match(runner, /flag\("--sidecar", "http:\/\/127\.0\.0\.1:3907"\)/);
  assert.match(runner, /harness_health_ms:/);
  assert.match(runner, /computer_performance: computerPerformanceSummary\(attempt\)/);
  assert.match(runner, /const readiness = await readExactFixtureHealth\(sidecar, expectedTitle\)/);
  assert.match(runner, /fixture_health_is_authoritative: Boolean\(requestedFixture \|\| orchestrateFixtures\)/);
  assert.match(runner, /initial_attempts: initialReadiness\.attempts/);
  assert.match(runner, /selected_answer_assertion_case_count:/);
  assert.match(runner, /summary_by_verification_basis:/);
  assert.match(runner, /verification_basis/);
  assert.match(runner, /async function waitForComputerIdle/);
  assert.match(runner, /computerStateHasMessage\(state, messageId\)/);
  assert.match(runner, /refusing to grade another runner's state/);
  assert.match(runner, /settleTimedOutComputerRun/);
  assert.match(runner, /the benchmark is stopping instead of contaminating later cases with live-context contention/);
  assert.match(runner, /localRevitProcessGuardTarget\(baseUrl, initialState\)/);
  assert.match(runner, /harness_context_loss_settlement:/);
  assert.match(runner, /stopped its own Operator turn instead of waiting for courier deadlines/);
  assert.match(runner, /--legacy-chat is retained only for transport diagnostics/);
  assert.doesNotMatch(runner, /const useComputer = process\.argv\.includes\("--ui"\)/);
});

test("local benchmark process guard is loopback-only and preserves the exact Revit binding", () => {
  const health = {
    context: {
      process_id: 18912,
      courier_executor_id: "DESKTOP-revit-courier-18912",
      document: { title: "Snowdon Towers Sample HVAC" }
    }
  };
  assert.deepEqual(localRevitProcessGuardTarget("http://127.0.0.1:3907", health), {
    processId: 18912,
    executorId: "DESKTOP-revit-courier-18912",
    documentTitle: "Snowdon Towers Sample HVAC"
  });
  assert.deepEqual(localRevitProcessGuardTarget("http://[::1]:3907", health), {
    processId: 18912,
    executorId: "DESKTOP-revit-courier-18912",
    documentTitle: "Snowdon Towers Sample HVAC"
  });
  assert.equal(localRevitProcessGuardTarget("https://operator.example", health), null);
  assert.equal(localRevitProcessGuardTarget("not a URL", health), null);
  assert.equal(localRevitProcessGuardTarget("http://localhost:3907", { context: { process_id: 0 } }), null);
});

test("local benchmark process liveness treats access denied as alive and missing PIDs as dead", () => {
  assert.equal(localProcessIsAlive(42, () => undefined), true);
  assert.equal(localProcessIsAlive(42, () => {
    const error = new Error("access denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  }), true);
  assert.equal(localProcessIsAlive(42, () => {
    const error = new Error("no such process") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }), false);
  assert.equal(localProcessIsAlive(0, () => undefined), false);
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
  assert.match(runner, /REVIT_CONTEXT_HOST_STARTING\|no fully opened model\|no active document/);
  assert.match(runner, /Revit Home is a valid fixture-transition starting point/);
  assert.match(runner, /cold_start: true/);
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
  const createSimilar = corpus.cases.find((entry) => entry.case_id === "lh05_create_similar_receptacles");
  const unit403 = corpus.cases.find((entry) => entry.case_id === "c20_add_duplex_match_circuit");
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
  assert.match(createSimilar?.probe_prompt || "", /same linked room wall/i);
  assert.match(createSimilar?.probe_prompt || "", /distinct safe host-local chainages/i);
  assert.match(unit403?.probe_prompt || "", /derive one safe bounded test location/i);
  assert.match(unit403?.probe_prompt || "", /same linked room wall/i);
  assert.doesNotMatch(unit403?.probe_prompt || "", /marked location/i);
});

test("titleblock mutation coverage is paired with the live read-only regression wording", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "c36_titleblock_initials_all_mech");
  assert.ok(entry);
  assert.equal(entry.expected_effect, "apply");
  assert.equal(entry.probe_expected_effect, "read");
  assert.ok(entry.answer_assertions);
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
  const noRenameAnswer = "Preview complete — nothing to rename. The established pattern is the level name. L2 views 9948 and 1371629 already match.";
  for (const pattern of viewNames.answer_assertions.must_match) {
    assert.match(noRenameAnswer, new RegExp(pattern, "i"));
  }
  const pdfAnswer = "Combined: Yes\nColor: Color\nM100 M101 M102 M103 M104 M105 M106; planned page count: 7; TEST-MECHANICAL-ISSUE.pdf; verify content hash with SHA-256. No export performed.";
  for (const pattern of pdf.answer_assertions.must_match) {
    assert.match(pdfAnswer, new RegExp(pattern, "i"));
  }

  const capturedPdf = evaluateGeneralRevitCapabilityAttempt(generalRevitExecutionCase(pdf, false), {
    ok: true,
    assistant_message: [
      "Order: **M100, M101, M102, M103, M104, M105, M106**",
      "Mode: **Combined, Color**",
      "Expected pages: **7 sheets → 7-page PDF**",
      "Output: `TEST-MECHANICAL-ISSUE.pdf`",
      "A content hash cannot be verified without generated file bytes.",
      "Dry-run/preflight only; no file created."
    ].join("\n"),
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/export-pdf", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection: { assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_export_pdf completed." }] },
      verification: { state: "passed", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "read" }
    }] }
  });
  assert.equal(capturedPdf.answer_assertion_passed, true);
  assert.equal(capturedPdf.tier, "verified");

  const capturedViewNoop = evaluateGeneralRevitCapabilityAttempt(viewNames, {
    ok: true,
    assistant_message: [
      "Preview complete — no changes needed",
      "The Level 2 HVAC views already match the pattern used on Levels 3–5:",
      "Ceiling Plan **L2** — ID `1371629`; Floor Plan **L2** — ID `9948`.",
      "The dry-run reported 0 renames, 2 unchanged, 0 errors. Nothing was applied."
    ].join("\n"),
    assignment_projection: { assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_native_api_ops completed." }] },
      verification: { state: "verified", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "apply", completion_mode: "verified_noop" }
    }] }
  });
  assert.equal(capturedViewNoop.answer_assertion_passed, true);
  assert.equal(capturedViewNoop.tier, "verified");
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

  const capturedLiveWording = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    assistant_message: `## Blocked — no compatible peer exists

Live audit found 7 loaded Air Terminal types, each represented by a placed instance.
No two different types preserve all required connector/service invariants.
The closest matches are Supply Air and Return Air, so that substitution was rejected.
No native type-change dry-run was admitted; nothing was applied or saved.`
  });
  assert.equal(capturedLiveWording.tier, "accepted");
  assert.equal(capturedLiveWording.fixture_blocker_accepted, true);

  const vague = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    assistant_message: "## Blocked\nI couldn't find a good type, so I stopped."
  });
  assert.equal(vague.tier, "failed");
  assert.equal(vague.fixture_blocker_accepted, false);

  const recoveredExploration = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    actions: [
      { path: "/revit/list-element-types", request_effect: "read", request_dispatched: true, status: "failed" },
      { path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" },
      { path: "/revit/get-connectors", request_effect: "read", request_dispatched: true, status: "success" }
    ],
    assistant_message: `## Blocked — no compatible different-type peer exists

Live inspection found exactly 7 loaded Air Terminal types.
Supply types and Return types differ in service, direction, shape, or dimensions, so no two different types preserve the required invariants.
Therefore, I did not run a cross-service type-change preview. No structured dry-run effect receipt was produced, and nothing was applied or saved.`
  });
  assert.equal(recoveredExploration.tier, "accepted");
  assert.equal(recoveredExploration.fixture_blocker_accepted, true);

  const failedMutationIsNotRecovered = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...inspected,
    actions: [
      { path: "/revit/change-element-type", request_effect: "preview", request_dispatched: true, status: "failed" },
      { path: "/revit/get-connectors", request_effect: "read", request_dispatched: true, status: "success" }
    ],
    assistant_message: `## Blocked — no compatible different-type peer exists

Live inspection found exactly 7 loaded Air Terminal types.
Supply types and Return types differ in service, direction, shape, or dimensions, so no two different types preserve the required invariants.
Therefore, I did not run a cross-service type-change preview. No structured dry-run effect receipt was produced, and nothing was applied or saved.`
  });
  assert.equal(failedMutationIsNotRecovered.fixture_blocker_assertion_passed, true);
  assert.equal(failedMutationIsNotRecovered.tier, "failed");
  assert.equal(failedMutationIsNotRecovered.fixture_blocker_accepted, false);
});

test("the accessory-add oracle accepts a live Snowdon zero-inventory blocker without inventing a precedent", () => {
  const safeCase = generalRevitExecutionCase(
    corpus.cases.find((candidate) => candidate.case_id === "r17_add_connected_accessory")!,
    false
  );
  const result = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ok: true,
    effect_state: "read_only_dispatched",
    actions: [
      { path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" }
    ],
    assistant_message: `## Blocked — no compatible nearby accessory precedent

Live project-wide inventory found Duct Accessories: 0 instances and Pipe Accessories: 0 instances.
No accessory was created, and no model changes were made.`
  });
  assert.equal(result.tier, "accepted");
  assert.equal(result.fixture_blocker_assertion_passed, true);
  assert.equal(result.fixture_blocker_accepted, true);
  assert.equal(result.completed, false);
  assert.equal(result.verified, false);

  const capturedLiveWording = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ok: true,
    effect_state: "read_only_dispatched",
    actions: [
      { path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" }
    ],
    assistant_message: `## Blocked before preview

The model contains zero Duct Accessories and zero Pipe Accessories; broader searches found no damper or valve precedent.
No preview was executed. Nothing was created.`
  });
  assert.equal(capturedLiveWording.tier, "accepted");
  assert.equal(capturedLiveWording.fixture_blocker_accepted, true);
});

test("the live runner reuses orchestrator-established fixture health between cases", () => {
  const runner = source("operator-backend/src/tools/general_revit_capability_acceptance.ts");
  assert.match(runner, /readExactFixtureHealth\(baseUrl, preferredDocumentTitle, true\)/);
  assert.match(runner, /preferCached \? "\/api\/revit\/health\?prefer_cached=1" : "\/api\/revit\/health"/);
});

test("both backend agent prompts preserve sheet identity while batching multi-sheet parameter reads", () => {
  const codexPrompt = source("operator-backend/src/brains/codex_brain.ts");
  const openAiPrompt = source("operator-backend/src/brains/openai_brain.ts");
  for (const prompt of [codexPrompt, openAiPrompt]) {
    assert.match(prompt, /Sheet\/titleblock parameter reads and verification must preserve sheet identity/);
    assert.match(prompt, /For two or more sheets/);
    assert.match(prompt, /one bounded [`/]?revit[_/-]get-parameters|one bounded [`/]?revit_get_parameters/);
    assert.match(prompt, /do not fan out one call per sheet or parameter/);
    assert.match(prompt, /only for bulk rows that are missing or ambiguous/);
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

test("a target clarification cannot inherit completion or verification from a successful preview receipt", () => {
  const productionCase = corpus.cases.find((candidate) => candidate.case_id === "b01_equipment_rename")!;
  const entry = { ...generalRevitExecutionCase(productionCase, false), answer_assertions: undefined };
  const previewPath = entry.dispatch_any_of[0];
  const result = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Nothing is selected. Please select the equipment instance or give me its exact Mark so I change the right one.",
    effect_state: "read_only_dispatched",
    actions: [{ path: previewPath, request_effect: "preview", request_dispatched: true, status: "success" }],
    teammate_loop_receipt: {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "inspection",
      context_state: "live",
      stage: "report",
      preview_action_ids: ["mcp:1"],
      preview_receipts: [{
        action_id: "mcp:1",
        path: previewPath,
        status: "success",
        evidence_sha256: `sha256:${"a".repeat(64)}`
      }],
      apply_attempts: 0,
      verified: false,
      blocked_reason: null
    }
  });
  assert.equal(result.tier, "accepted");
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
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "inspection",
      context_state: "live",
      stage: "report",
      preview_action_ids: ["mcp:1", "mcp:2"],
      preview_receipts: [
        { action_id: "mcp:1", path: safeCase.dispatch_any_of[0], status: "success", evidence_sha256: `sha256:${"a".repeat(64)}` },
        { action_id: "mcp:2", path: safeCase.dispatch_any_of[0], status: "success", evidence_sha256: `sha256:${"b".repeat(64)}` }
      ],
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

test("a certified teammate preview verifies a read-classified preflight without weakening apply truth", () => {
  const productionCase = corpus.cases.find((candidate) => candidate.case_id === "dp01_individual_bw_pdf_set")!;
  const safeCase = generalRevitExecutionCase(productionCase, false);
  assert.equal(safeCase.expected_effect, "read");
  const attempt = {
    ok: true,
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/sheets", request_effect: "read", request_dispatched: true, status: "success" }],
    teammate_loop_receipt: {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "inspection",
      context_state: "live",
      stage: "report",
      preview_action_ids: ["mcp:1"],
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/export-pdf",
        status: "success",
        evidence_sha256: `sha256:${"a".repeat(64)}`
      }],
      apply_attempts: 0,
      verified: false,
      blocked_reason: null
    }
  };
  const readResult = evaluateGeneralRevitCapabilityAttempt(safeCase, attempt);
  assert.equal(readResult.tier, "verified");
  assert.equal(readResult.verification_basis, "structured_preview_receipt");
  assert.equal(readResult.apply_dispatched, false);

  const applyResult = evaluateGeneralRevitCapabilityAttempt(productionCase, attempt);
  assert.notEqual(applyResult.tier, "verified");
  assert.equal(applyResult.completed, false);
  assert.equal(applyResult.apply_dispatched, false);

  const uncertifiedResult = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...attempt,
    teammate_loop_receipt: { ...attempt.teammate_loop_receipt, schema: "lookalike" }
  });
  assert.equal(uncertifiedResult.completed, true);
  assert.equal(uncertifiedResult.verified, false);
});

test("a certified successful teammate preview preserves its exact capability path", () => {
  const safeCase = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c33_match_view_graphics_across_level")!, false);
  const attempt = {
    ok: true,
    effect_state: "read_only_dispatched" as const,
    actions: [{ path: "/chat", request_effect: "preview", request_dispatched: true, status: "success" }],
    teammate_loop_receipt: {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "inspection",
      context_state: "live",
      stage: "report",
      preview_action_ids: ["mcp:1"],
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/views",
        status: "success",
        evidence_sha256: `sha256:${"a".repeat(64)}`
      }],
      apply_attempts: 0,
      verified: false,
      blocked_reason: null
    }
  };
  const result = evaluateGeneralRevitCapabilityAttempt(safeCase, attempt);
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.deepEqual(result.observed_paths, ["/chat", "/revit/views"]);

  for (const invalidPreviewReceipt of [
    { ...attempt.teammate_loop_receipt.preview_receipts[0], action_id: "mcp:forged" },
    { ...attempt.teammate_loop_receipt.preview_receipts[0], status: "failed" },
    { ...attempt.teammate_loop_receipt.preview_receipts[0], evidence_sha256: "sha256:not-a-digest" },
    { ...attempt.teammate_loop_receipt.preview_receipts[0], path: "/revit/sheets" }
  ]) {
    const invalid = evaluateGeneralRevitCapabilityAttempt(safeCase, {
      ...attempt,
      teammate_loop_receipt: { ...attempt.teammate_loop_receipt, preview_receipts: [invalidPreviewReceipt] }
    });
    assert.equal(invalid.completed, false);
    assert.notEqual(invalid.tier, "verified");
  }
});

test("a certified transaction-plan preview is the composable safe execution lane", () => {
  const safeCase = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c03_level4_enlarged_plan_terse")!, false);
  const attempt = {
    ok: true,
    effect_state: "read_only_dispatched" as const,
    actions: [{ path: "/chat", request_effect: "preview", request_dispatched: true, status: "success" }],
    teammate_loop_receipt: {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "mutation",
      context_state: "live",
      stage: "discover",
      preview_action_ids: ["mcp:1"],
      preview_receipts: [{
        action_id: "mcp:1",
        path: "/revit/transaction-plan",
        status: "success",
        evidence_sha256: `sha256:${"c".repeat(64)}`
      }],
      apply_attempts: 0,
      verified: false,
      blocked_reason: null
    }
  };
  const result = evaluateGeneralRevitCapabilityAttempt(safeCase, attempt);
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification_basis, "structured_preview_receipt");
  assert.equal(result.apply_dispatched, false);
  assert.deepEqual(result.observed_paths, ["/chat", "/revit/transaction-plan"]);

  const missingNativeReceipt = evaluateGeneralRevitCapabilityAttempt(safeCase, {
    ...attempt,
    teammate_loop_receipt: { ...attempt.teammate_loop_receipt, preview_receipts: [] }
  });
  assert.equal(missingNativeReceipt.completed, false);
  assert.notEqual(missingNativeReceipt.tier, "verified");
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

test("fixture-grounded duplicate impact requires the strongest plausible pair and complete system evidence", () => {
  const entry = corpus.cases.find((candidate) => candidate.case_id === "c24_delete_duplicate_device")!;
  assert.ok(entry.answer_assertions);
  assert.match(entry.probe_prompt, /strongest plausible duplicate-device candidate/);
  assert.match(entry.probe_prompt, /complete connected system/);
  assert.match(entry.probe_prompt, /whether the model evidence proves a genuine duplicate/);
  const assignment_projection = {
    assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
      verification: { state: "verified", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "read" }
    }]
  };
  const teammate_loop_receipt = {
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: "inspection",
    context_state: "live",
    stage: "report",
    preview_action_ids: ["mcp:duplicate-preview"],
    preview_receipts: [{
      action_id: "mcp:duplicate-preview",
      path: "/revit/delete",
      status: "success",
      evidence_sha256: `sha256:${"d".repeat(64)}`
    }],
    apply_attempts: 0,
    verified: false,
    blocked_reason: null
  };
  const correct = evaluateGeneralRevitCapabilityAttempt(generalRevitExecutionCase(entry, false), {
    ok: true,
    assistant_message: [
      "Strongest plausible duplicate candidate: Air terminals 1460066 and 1460067, identical 16×4 supply grilles in Room 306, only 8 in apart. The repeated opposite-facing pattern means the model evidence does not prove a genuine duplicate.",
      "Both connect directly to duct 1460049 on Mechanical Supply Air 34. The network contains 54 elements.",
      "Rollback-only deletion preview for 1460066 impacts only that terminal; no dependents. The other 53 system elements would remain connected.",
      "Nothing was changed or deleted."
    ].join("\n"),
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/delete", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection,
    teammate_loop_receipt
  });
  assert.equal(correct.tier, "verified");
  assert.equal(correct.answer_assertion_passed, true);
  assert.equal(correct.verification_basis, "fixture_semantic_oracle");

  const wrongPair = evaluateGeneralRevitCapabilityAttempt(generalRevitExecutionCase(entry, false), {
    ok: true,
    assistant_message: [
      "I inspected the project and chose air terminals 1441077 and 1441092 on L3.",
      "They are an intentional back-to-back assembly, so no genuinely duplicated device was proven.",
      "A rollback deletion preview completed and nothing was changed."
    ].join("\n"),
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/delete", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection,
    teammate_loop_receipt
  });
  assert.equal(wrongPair.tier, "failed");
  assert.equal(wrongPair.answer_assertion_passed, false);
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

  const equivalentNaturalTypeOrder = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "509 air terminals total. If counting only types literally named Diffuser, the subtotal is 29.\n| Supply Diffuser – Square – 12x12 | 28 |\n| Linear Slot Supply Diffuser – 48x4, 2-slot | 1 |",
    assignment_projection
  });
  assert.equal(equivalentNaturalTypeOrder.tier, "verified");
  assert.equal(equivalentNaturalTypeOrder.answer_assertion_passed, true);

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

  const exactReplayWording = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Live model contains **17 mechanical sheets**, and **none have dashes in their sheet numbers**. Dash-containing targets: 0. No sheets were renamed.",
    assignment_projection: durableNoop
  });
  assert.equal(exactReplayWording.tier, "verified");
  assert.equal(exactReplayWording.answer_assertion_passed, true);

  const capturedLiveWording = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Mechanical sheets: **17**",
      "Sheet numbers containing dashes: **0**",
      "Proposed mappings: none. Ordering and uniqueness remain unchanged.",
      "No sheets were renamed."
    ].join("\n"),
    assignment_projection: durableNoop
  });
  assert.equal(capturedLiveWording.tier, "verified");
  assert.equal(capturedLiveWording.answer_assertion_passed, true);

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

  const capturedLiveReceipt = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Previewed mechanical plan **L2** (view **9948**); nothing was applied.",
      "Bottom: **L2 + 0′**; View Depth: **L2 + 0′**; Underlay: **None**.",
      "The rolled-back preview confirmed the smallest defensible setting is already present, so this is a verified no-op."
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
  assert.equal(capturedLiveReceipt.answer_assertion_passed, true);
  assert.equal(capturedLiveReceipt.tier, "verified");
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

  const exactReplay = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Element 1365188, Mark HRU202",
      "Family: HeatRecoveryUnit",
      "Source type: Heat Recovery Unit (HRU), 1365172",
      "Width: 3.333333 ft; Length: 4.035433 ft",
      "Nothing was edited, saved, reloaded, or swapped."
    ].join("\n"),
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" }, evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }, execution: { requested_effect: "read" }
      }]
    }
  });
  assert.equal(exactReplay.answer_assertion_passed, true);
  assert.equal(exactReplay.tier, "verified");

  const capturedMetricReceipt = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: [
      "Instance: **HRU202** — ID `1365188`",
      "Family: **HeatRecoveryUnit** — ID `1537998`",
      "Source type: **Heat Recovery Unit (HRU)** — ID `1365172`",
      "Width: 40 in; Length: 1230 mm",
      "Nothing was edited, saved, reloaded, or swapped."
    ].join("\n"),
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" }, evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }, execution: { requested_effect: "read" }
      }]
    }
  });
  assert.equal(capturedMetricReceipt.answer_assertion_passed, true);
  assert.equal(capturedMetricReceipt.tier, "verified");

  const wrongMetricReceipt = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Instance HRU202 ID 1365188; Family HeatRecoveryUnit; Source type Heat Recovery Unit (HRU) ID 1365172; Width 40 in; Length 1200 mm; nothing was edited, saved, reloaded, or swapped.",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" }, evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
        verification: { state: "passed", criteria: [{ status: "pass" }] }, execution: { requested_effect: "read" }
      }]
    }
  });
  assert.equal(wrongMetricReceipt.answer_assertion_passed, false);
});

test("Snowdon schedule-cell and titleblock readback oracles accept the captured live receipts", () => {
  const schedule = corpus.cases.find((candidate) => candidate.case_id === "s05_schedule_value_edit")!;
  const scheduleAnswer = [
    "Schedule: Heat Recovery Unit Summary (ID 1488968)",
    "Exact row: HRU202; Mechanical Equipment element 1365188",
    "Supply Air Pressure Drop old 0.08 in-wg; proposed 0.10 in-wg",
    "The dry-run reported 1 effective change without committing; no changes applied."
  ].join("\n");
  for (const pattern of schedule.answer_assertions!.must_match) assert.match(scheduleAnswer, new RegExp(pattern, "i"));

  const titleblocks = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c36_titleblock_initials_all_mech")!, false);
  assert.equal(titleblocks.expected_effect, "read");
  const titleblockAnswer = [
    "Mechanical sheet readback",
    "M000 | Author | Checker",
    "M206 | Author | Checker",
    "Expected: Drawn By = EP, Checked By = QA",
    "Mechanical sheets checked: 17",
    "Sheets with one or more mismatches: 17",
    "Individual field mismatches: 34",
    "No model changes were made."
  ].join("\n");
  const titleblockAttempt = {
    ok: true,
    assistant_message: titleblockAnswer,
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/sheets", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection: { assignments: [{
      lifecycle: { phase: "complete" },
      evidence: { entries: [{ summary: "Live tool revit_list_sheets completed." }] },
      verification: { state: "verified", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "read" }
    }] }
  } as const;
  const result = evaluateGeneralRevitCapabilityAttempt(titleblocks, titleblockAttempt);
  assert.equal(result.answer_assertion_passed, true);
  assert.equal(result.tier, "verified");

  const naturalTitleblockAnswer = [
    "## Mechanical sheet audit",
    "| Sheet | Drawn By | Checked By |",
    "| M000 | Author | Checker |",
    "| M206 | Author | Checker |",
    "Against EP / QA: 17 of 17 sheets mismatch; 34 field mismatches total.",
    "No changes were made."
  ].join("\n");
  const naturalTitleblockResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: naturalTitleblockAnswer
  });
  assert.equal(naturalTitleblockResult.answer_assertion_passed, true);
  assert.equal(naturalTitleblockResult.tier, "verified");

  const latestTitleblockAnswer = [
    "## Mechanical sheet audit",
    "| Sheet | Drawn By | Checked By |",
    "| M000 | Author | Checker |",
    "| M206 | Author | Checker |",
    "Results: 17 mechanical sheets checked; 17 sheets mismatch EP / QA.",
    "That is **34 individual field mismatches**. No changes were made."
  ].join("\n");
  const latestTitleblockResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: latestTitleblockAnswer
  });
  assert.equal(latestTitleblockResult.answer_assertion_passed, true);
  assert.equal(latestTitleblockResult.tier, "verified");

  const structuredTitleblockRows = [
    ["M000", "Author", "Checker"], ["M001", "APF", "ADSK"], ["M002", "Author", "Checker"],
    ["M100", "Author", "Checker"], ["M101", "Author", "Checker"], ["M102", "Author", "Checker"],
    ["M103", "Author", "Checker"], ["M104", "Author", "Checker"], ["M105", "Author", "Checker"],
    ["M106", "Author", "Checker"], ["M200", "Author", "Checker"], ["M201", "Author", "Checker"],
    ["M202", "Author", "Checker"], ["M203", "Author", "Checker"], ["M204", "Author", "Checker"],
    ["M205", "Author", "Checker"], ["M206", "Author", "Checker"]
  ];
  const structuredTitleblockAnswer = [
    "## Mechanical sheet audit",
    "| Sheet | Drawn By | Checked By |",
    "|---|---|---|",
    ...structuredTitleblockRows.map((row) => `| ${row.join(" | ")} |`),
    "Results: 17 mechanical sheets audited. All **17** mismatch the expected **Drawn By = EP / Checked By = QA**. No changes made."
  ].join("\n");
  const structuredTitleblockResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: structuredTitleblockAnswer
  });
  assert.equal(structuredTitleblockResult.answer_assertion_passed, true);
  assert.equal(structuredTitleblockResult.tier, "verified");

  const componentCountTitleblockAnswer = structuredTitleblockAnswer.replace(
    "All **17** mismatch the expected **Drawn By = EP / Checked By = QA**.",
    "**17 sheets mismatch** the required **EP / QA** combination. That is 17 Drawn By mismatches and 17 Checked By mismatches."
  );
  const componentCountTitleblockResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: componentCountTitleblockAnswer
  });
  assert.equal(componentCountTitleblockResult.answer_assertion_passed, true);
  assert.equal(componentCountTitleblockResult.tier, "verified");

  const differingLabelTitleblockAnswer = [
    "## Mechanical Sheet Audit",
    "| Sheet | Drawn By | Checked By |",
    "|---|---|---|",
    ...structuredTitleblockRows.map((row) => `| ${row.join(" | ")} |`),
    "**Live audit results**",
    "- Mechanical sheets checked: **17**",
    "- Sheets differing from **EP / QA**: **17**",
    "- Drawn By mismatches: **17**",
    "- Checked By mismatches: **17**",
    "- Total field mismatches: **34**",
    "No model changes were made."
  ].join("\n");
  const differingLabelTitleblockResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: differingLabelTitleblockAnswer
  });
  assert.equal(differingLabelTitleblockResult.answer_assertion_passed, true);
  assert.equal(differingLabelTitleblockResult.tier, "verified");

  for (const incorrectDifferingLabel of [
    differingLabelTitleblockAnswer.replace("from **EP / QA**: **17**", "from **EP / QA**: **16**"),
    differingLabelTitleblockAnswer.replace("from **EP / QA**", "from **XX / YY**"),
    differingLabelTitleblockAnswer.replace("Total field mismatches: **34**", "Total field mismatches: **33**")
  ]) {
    const incorrectDifferingLabelResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
      ...titleblockAttempt,
      assistant_message: incorrectDifferingLabel
    });
    assert.equal(incorrectDifferingLabelResult.answer_assertion_passed, false);
    assert.equal(incorrectDifferingLabelResult.tier, "failed");
  }

  for (const incorrectComponentCount of [
    componentCountTitleblockAnswer.replace("17 Drawn By mismatches", "16 Drawn By mismatches"),
    componentCountTitleblockAnswer.replace("17 Checked By mismatches", "16 Checked By mismatches"),
    componentCountTitleblockAnswer.replace("required **EP / QA** combination", "required **XX / YY** combination")
  ]) {
    const incorrectComponentCountResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
      ...titleblockAttempt,
      assistant_message: incorrectComponentCount
    });
    assert.equal(incorrectComponentCountResult.answer_assertion_passed, false);
    assert.equal(incorrectComponentCountResult.tier, "failed");
  }

  const partiallyCorrectStructuredTitleblock = structuredTitleblockAnswer.replace(
    "| M206 | Author | Checker |",
    "| M206 | Author | QA |"
  );
  const partiallyCorrectStructuredResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
    ...titleblockAttempt,
    assistant_message: partiallyCorrectStructuredTitleblock
  });
  assert.equal(partiallyCorrectStructuredResult.answer_assertion_passed, false);
  assert.equal(partiallyCorrectStructuredResult.tier, "failed");

  for (const adversarialAnswer of [
    naturalTitleblockAnswer.replace("17 of 17 sheets mismatch", "16 of 17 sheets mismatch"),
    naturalTitleblockAnswer.replace("34 field mismatches", "33 field mismatches"),
    naturalTitleblockAnswer.replace("Against EP / QA", "Against XX / YY")
  ]) {
    const adversarialResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
      ...titleblockAttempt,
      assistant_message: adversarialAnswer
    });
    assert.equal(adversarialResult.tier, "failed");
    assert.equal(adversarialResult.answer_assertion_passed, false);
  }

  for (const adversarialAnswer of [
    latestTitleblockAnswer.replace("17 mechanical sheets checked", "16 mechanical sheets checked"),
    latestTitleblockAnswer.replace("17 sheets mismatch", "16 sheets mismatch"),
    latestTitleblockAnswer.replace("34 individual field mismatches", "33 individual field mismatches"),
    latestTitleblockAnswer.replace("mismatch EP / QA", "mismatch XX / YY")
  ]) {
    const adversarialResult = evaluateGeneralRevitCapabilityAttempt(titleblocks, {
      ...titleblockAttempt,
      assistant_message: adversarialAnswer
    });
    assert.equal(adversarialResult.tier, "failed");
    assert.equal(adversarialResult.answer_assertion_passed, false);
  }
});

test("captured cohort wording keeps fixture facts while remaining presentation-neutral", () => {
  const completeProjection = (requested_effect: "read" | "preview", completion_mode?: string) => ({
    assignments: [{
      lifecycle: { phase: "complete" },
      plan: { steps: [] },
      evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
      verification: { state: "passed", criteria: [{ status: "pass" }] },
      execution: { requested_effect, completion_mode }
    }]
  });

  const schedule = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "s05_schedule_value_edit")!, false),
    {
      ok: true,
      assistant_message: [
        "Schedule: Heat Recovery Unit Summary (1488968)",
        "Row HRU202, Mechanical Equipment element 1365188",
        "Supply Air Pressure Drop: 0.08 in-wg to 0.10 in-wg",
        "Native dry-run: 1 requested/effective change; nothing was applied."
      ].join("\n"),
      assignment_projection: completeProjection("preview")
    }
  );
  assert.equal(schedule.tier, "verified");

  const pdf = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "dp02_combined_discipline_pdf")!, false),
    {
      ok: true,
      assistant_message: [
        "Order: M100, M101, M102, M103, M104, M105, M106",
        "One combined Color PDF",
        "Seven-page check: 7 sheets selected; intended 7 pages",
        "Output: artifacts/prints/TEST-MECHANICAL-ISSUE.pdf",
        "Content hash cannot be computed because no files were exported."
      ].join("\n"),
      assignment_projection: completeProjection("read")
    }
  );
  assert.equal(pdf.tier, "verified");

  const noopProjection = completeProjection("preview", "verified_noop");
  const names = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c02_clean_level2_view_names")!, false),
    {
      ok: true,
      assistant_message: "The Level 2 HVAC views already match the adjacent-level pattern: view name = level name. Floor Plan L2 → no rename; Ceiling Plan L2 → no rename. Verified no-op.",
      assignment_projection: noopProjection
    }
  );
  assert.equal(names.tier, "verified");

  const range = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c31_fix_view_range_terse")!, false),
    {
      ok: true,
      assistant_message: "Selected L2 (view 9948). Bottom: L2 + 0. View Depth: L2 + 0. Underlay: None. The smallest defensible correction is a verified no-op; nothing was applied.",
      assignment_projection: noopProjection
    }
  );
  assert.equal(range.tier, "verified");

  const sheets = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c34_sheet_numbers_dashes_to_dots")!, false),
    {
      ok: true,
      assistant_message: "17 mechanical M-series sheets inventoried. 0 sheet numbers contain dashes. Dry-run: 0 candidates, applied: false. No sheets were renamed.",
      assignment_projection: noopProjection
    }
  );
  assert.equal(sheets.tier, "verified");

  const naturalInventoryOrder = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c34_sheet_numbers_dashes_to_dots")!, false),
    {
      ok: true,
      assistant_message: "Mechanical sheets inventoried: **17**\nSheet numbers containing dashes: **0**\nDry-run result: NoOp, modelModified: false\nNo sheets were renamed.",
      assignment_projection: noopProjection
    }
  );
  assert.equal(naturalInventoryOrder.tier, "verified");

  const wrongSchedule = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "s05_schedule_value_edit")!, false),
    {
      ok: true,
      assistant_message: "Heat Recovery Unit Summary 1488968; HRU202; element 1365188; Supply Air Pressure Drop 0.08 in-wg to 0.10 in-wg; 2 requested/effective changes; dry-run.",
      assignment_projection: completeProjection("preview")
    }
  );
  assert.equal(wrongSchedule.tier, "failed");

  const wrongPdf = evaluateGeneralRevitCapabilityAttempt(
    generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "dp02_combined_discipline_pdf")!, false),
    {
      ok: true,
      assistant_message: "M100 M101 M102 M103 M104 M105 M106; combined color; Seven-page check: 7 sheets selected; intended 8 pages; TEST-MECHANICAL-ISSUE.pdf; content hash; no files were exported.",
      assignment_projection: completeProjection("read")
    }
  );
  assert.equal(wrongPdf.tier, "failed");
});

test("a session-bound completed assignment recovers an outer benchmark timeout without hiding other failures", () => {
  const entry = generalRevitExecutionCase(corpus.cases.find((candidate) => candidate.case_id === "c36_titleblock_initials_all_mech")!, false);
  const resultSummary = [
    "| Sheet | Drawn By | Checked By |",
    "| M000 | Author | Checker |",
    "| M206 | Author | Checker |",
    "Against expected EP / QA:",
    "Mechanical sheets audited: 17",
    "Sheets with one or more mismatches: 17",
    "Total field mismatches: 34",
    "No changes were made."
  ].join("\n");
  const assignment_projection = {
    assignments: [{
      lifecycle: { phase: "complete" },
      plan: { steps: [{ result_summary: resultSummary }] },
      evidence: { entries: [{ summary: "Live tool revit_call_tool completed." }] },
      verification: { state: "passed", criteria: [{ status: "pass" }] },
      execution: { requested_effect: "read" }
    }]
  };
  const recovered = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: false,
    error: "Computer run exceeded 300000ms.",
    assistant_message: "",
    effect_state: "not_dispatched",
    assignment_projection
  });
  assert.equal(recovered.tier, "verified");
  assert.equal(recovered.answer_assertion_passed, true);
  assert.equal(recovered.verification_basis, "fixture_semantic_oracle");

  const currentLiveAttempt = {
    ok: true,
    assistant_message: [
      "## Mechanical sheet audit",
      "| Sheet | Drawn By | Checked By |",
      "| M000 | Author | Checker |",
      "| M001 | APF | ADSK |",
      "| M206 | Author | Checker |",
      "Result: 17 of 17 sheets mismatch the expected EP / QA values—34 individual field mismatches. No changes made."
    ].join("\n"),
    effect_state: "read_only_dispatched",
    actions: [{ path: "/revit/sheets", request_effect: "read", request_dispatched: true, status: "success" }],
    assignment_projection
  } as const;
  const currentLiveWording = evaluateGeneralRevitCapabilityAttempt(entry, currentLiveAttempt);
  assert.equal(currentLiveWording.tier, "verified");
  assert.equal(currentLiveWording.answer_assertion_passed, true);

  const incorrectCurrentLiveWording = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...currentLiveAttempt,
    assistant_message: currentLiveAttempt.assistant_message.replace("34 individual", "32 individual")
  });
  assert.equal(incorrectCurrentLiveWording.tier, "failed");
  assert.equal(incorrectCurrentLiveWording.answer_assertion_passed, false);

  const unrelatedFailure = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: false,
    error: "The Revit call timed out.",
    assistant_message: "",
    effect_state: "not_dispatched",
    assignment_projection
  });
  assert.equal(unrelatedFailure.tier, "failed");
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

  const naturalConventionWording = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "Preview complete — no changes needed. The other HVAC levels use the level name alone for both views. Level 2 already matches: Ceiling Plan L2 -> L2 and Floor Plan L2 -> L2. Dry-run result: 0 renames, 2 unchanged, 0 errors.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [
          { summary: "Live tool revit_call_tool completed." },
          { summary: "Verified that the requested Revit state was already satisfied using substantive live evidence; no write was necessary." }
        ] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(naturalConventionWording.tier, "verified");
  assert.equal(naturalConventionWording.verification_basis, "fixture_semantic_oracle");

  const wrongConvention = evaluateGeneralRevitCapabilityAttempt(entry, {
    ok: true,
    assistant_message: "The other HVAC levels use an HVAC suffix. L2 already matches and no renames are required.",
    effect_state: "read_only_dispatched",
    assignment_projection: {
      assignments: [{
        lifecycle: { phase: "complete" },
        evidence: { entries: [
          { summary: "Live tool revit_call_tool completed." },
          { summary: "Verified that the requested Revit state was already satisfied using substantive live evidence; no write was necessary." }
        ] },
        verification: { state: "passed", criteria: [{ status: "pass" }] },
        execution: { requested_effect: "apply", completion_mode: "verified_noop" }
      }]
    }
  });
  assert.equal(wrongConvention.tier, "failed");
  assert.equal(wrongConvention.verified, false);

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
    "Expected schedule rows after conversion: 37. Expected ERU count after conversion: 37.",
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
    "If all 37 HRUs are intended to become ERUs, the expected post-migration target is **37** and the expected schedule row count is **37**."
  ].join("\n");
  const freshLiveTableVerified = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: freshLiveTableResponse
  });
  assert.equal(freshLiveTableVerified.tier, "verified");
  assert.equal(freshLiveTableVerified.verified, true);

  const capturedLiveResponse = [
    "Existing source: **Heat Recovery Unit Summary** — schedule ID **1488968**",
    "Schedule total: **37 HRUs**; independent model query: **37 matching Mechanical Equipment instances**",
    "Current marks: **37 HRU**, **0 ERU**, **0 blank**, **0 duplicates**",
    "Model count and schedule total reconcile exactly: **37 = 37**",
    "## Temporary QA schedule plan",
    "Fields: Mark, Family, Type. Filter: Mark begins with `ERU`. Sort: Mark ascending.",
    "Acceptance: schedule row count = independent ERU model count; no blank Marks; no duplicate Marks.",
    "Family and Type values currently remain **HeatRecoveryUnit / Heat Recovery Unit (HRU)**.",
    "The expected state is **0 HRU and 37 ERU**, with the QA schedule showing **37 rows**.",
    "No schedule was created or configured."
  ].join("\n");
  const capturedLiveVerified = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: capturedLiveResponse
  });
  assert.equal(capturedLiveVerified.tier, "verified");
  assert.equal(capturedLiveVerified.answer_assertion_passed, true);

  const naturalLiveResponse = [
    "Source: Heat Recovery Unit Summary (schedule ID 1488968).",
    "Existing fields include Mark, Family, Type. Schedule reports 37 HRU records.",
    "Independent model query confirms 37 HRU and 0 ERU mechanical-equipment instances.",
    "All 37 Marks are populated and unique; no current HRU-to-ERU Mark collisions detected.",
    "Complete QA schedule plan: retain only Mark, Family, Type; filter Mark begins with ERU; Sort Mark ascending.",
    "After migration require ERU Mark count: 37 and Temporary schedule rows: 37, then reconcile returned element IDs against the schedule rows.",
    "No schedule was created or configured."
  ].join("\n");
  const naturalLiveVerified = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: naturalLiveResponse
  });
  assert.equal(naturalLiveVerified.tier, "verified");
  assert.equal(naturalLiveVerified.answer_assertion_passed, true);

  for (const adversarialNaturalResponse of [
    naturalLiveResponse.replace("Schedule reports 37 HRU records", "Schedule reports 36 HRU records"),
    naturalLiveResponse.replace("37 HRU and 0 ERU", "37 HRU and 5 ERU"),
    naturalLiveResponse.replace("All 37 Marks are populated and unique", "One Mark is blank and duplicates remain"),
    naturalLiveResponse.replace("ERU Mark count: 37 and Temporary schedule rows: 37", "ERU Mark count: 36 and Temporary schedule rows: 36")
  ]) {
    const adversarialNaturalEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: adversarialNaturalResponse
    });
    assert.equal(adversarialNaturalEvaluation.tier, "failed");
    assert.equal(adversarialNaturalEvaluation.verified, false);
  }

  const latestCompleteNaturalResponse = [
    "Existing precedent: Heat Recovery Unit Summary (schedule ID 1488968).",
    "It already contains Mark, Family, Type plus Space Number, Space Name, and Level.",
    "Existing schedule Grand total: 37, matching independent model count.",
    "Independent project-wide Mechanical Equipment inventory:",
    "- 37 instances",
    "- 37 HRU-prefixed Marks",
    "- 0 ERU-prefixed Marks",
    "- 0 blank Marks",
    "- No duplicate Marks observed in the complete 37-item inventory",
    "Complete temporary QA schedule plan:",
    "1. Create a regular Mechanical Equipment schedule.",
    "2. Add only Mark, Family, Type.",
    "3. Mark begins with ERU.",
    "4. Sort by Mark ascending and itemize every instance.",
    "5. After converting all 37: HRU count 0, ERU count 37, QA schedule rows 37.",
    "No schedule was created or configured."
  ].join("\n");
  const latestCompleteNatural = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: latestCompleteNaturalResponse
  });
  assert.equal(latestCompleteNatural.tier, "verified");
  assert.equal(latestCompleteNatural.answer_assertion_passed, true);

  const latestRecoveredLiveResponse = [
    "Source: Heat Recovery Unit Summary (schedule ID 1488968).",
    "Existing fields: Space Number, Space Name, Mark, Family, Type, Level.",
    "Schedule total: 37 HRUs.",
    "Independent model query: 37 HRU mechanical-equipment instances and 0 ERU instances.",
    "Mark audit: 0 blanks, 0 missing values, 0 duplicate groups.",
    "Projected prefix migration: HRU 37 → ERU 37, with no expected collisions.",
    "Noncommitting implementation plan:",
    "Create a temporary Mechanical Equipment schedule using only Mark, Family, Type.",
    "Filter Mark begins with ERU. Sort Mark ascending, itemized.",
    "After migration require Temporary schedule rows: 37; Independent model ERU count: 37; Remaining HRU count: 0.",
    "Blank Marks: 0. Duplicate ERU Marks: 0. Schedule/model count difference: 0.",
    "Delete the temporary QA schedule only after reconciliation is accepted.",
    "No schedule was created or configured."
  ].join("\n");
  const latestRecoveredLive = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: latestRecoveredLiveResponse
  });
  assert.equal(latestRecoveredLive.tier, "verified");
  assert.equal(latestRecoveredLive.answer_assertion_passed, true);

  const currentLiveResponse = [
    "## Live findings",
    "Existing source schedule: Heat Recovery Unit Summary (ID 1488968).",
    "It contains Mark, Family, Type plus Space Number, Space Name, and Level.",
    "Schedule total: 37 HRUs.",
    "Independent model query: 37 mechanical-equipment Marks beginning HRU.",
    "Current ERU count: 0.",
    "Mark audit: 0 blanks, 0 duplicate groups across all 37 mechanical-equipment instances.",
    "All listed units use family HeatRecoveryUnit and type Heat Recovery Unit (HRU).",
    "## Complete noncommitting plan",
    "Visible fields: Mark, Family, Type.",
    "Replace filters with: Mark begins_with ERU.",
    "Replace sorting/grouping with: Mark, ascending.",
    "Expected post-migration ERU count: 37.",
    "Post-migration QA: schedule must contain exactly 37 ERU rows; independent model query must also return 37.",
    "No schedule was created, duplicated, or configured."
  ].join("\n");
  const currentLive = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: currentLiveResponse
  });
  assert.equal(currentLive.tier, "verified");
  assert.equal(currentLive.answer_assertion_passed, true);

  const structuredFreshReplay = [
    "## Live findings",
    "Best source: **Heat Recovery Unit Summary** — schedule ID **1488968**.",
    "Existing fields include **Mark, Family, Type**.",
    "Schedule reports **37 HRUs**.",
    "Independent model query confirms:",
    "- **HRU-prefixed mechanical equipment:** 37",
    "- **ERU-prefixed mechanical equipment:** 0",
    "Mark audit: **0 blanks, 0 duplicate groups** across all 37 units.",
    "Existing rows use family **HeatRecoveryUnit** and type **Heat Recovery Unit (HRU)**.",
    "## Complete QA schedule plan",
    "Retain only Mark, Family, Type.",
    "Replace inherited filters and apply: **Mark begins with `ERU`**.",
    "Replace inherited sorting/grouping: **Mark ascending**.",
    "After the HRU→ERU migration, verify: ERU schedule rows = **37**; independent model ERU count = **37**; HRU-prefix count = **0**; blank Marks = **0**; duplicate ERU Marks = **0**.",
    "Presently safe—37 unique HRU Marks and no existing ERU Marks imply **37 expected targets and no known collisions**.",
    "**No schedule was created or configured.**"
  ].join("\n");
  const structuredFreshEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: structuredFreshReplay
  });
  assert.equal(structuredFreshEvaluation.tier, "verified");
  assert.equal(structuredFreshEvaluation.answer_assertion_passed, true);

  const countedRelationReplay = [
    "## Live findings",
    "Existing source: **Heat Recovery Unit Summary** (schedule ID **1488968**).",
    "It contains **37 HRUs** and already supports **Mark, Family, Type**.",
    "Independent model query: **37 HRU**, **0 ERU**.",
    "Mark audit: **0 blanks, 0 duplicate groups**.",
    "Schedule total and independent model count both equal **37**.",
    "## Complete no-write plan",
    "Create a temporary Mechanical Equipment schedule with Mark, Family, Type.",
    "Filter: Mark begins with ERU. Sort: Mark, ascending. Itemize every instance.",
    "Schedule row count must equal an independent project-wide Mechanical Equipment query using the same ERU prefix rule.",
    "Current HRU source count: 37. Current ERU target count: 0.",
    "Expected ERU count after a complete prefix-only HRU→ERU migration: **37**. Expected schedule rows: **37**.",
    "Blank Mark count must be 0. Duplicate ERU Mark groups must be 0.",
    "**No schedule was created or configured.**"
  ].join("\n");
  const countedRelationEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: countedRelationReplay
  });
  assert.equal(countedRelationEvaluation.tier, "verified");
  assert.equal(countedRelationEvaluation.answer_assertion_passed, true);

  for (const [incorrectIndex, incorrectCountedRelation] of [
    countedRelationReplay.replace("contains **37 HRUs**", "contains **36 HRUs**"),
    countedRelationReplay.replace("**37 HRU**, **0 ERU**", "**37 HRU**, **5 ERU**"),
    countedRelationReplay.replace("both equal **37**", "both equal **36**"),
    countedRelationReplay.replace("migration: **37**", "migration: **36**"),
    countedRelationReplay.replace("0 blanks", "2 blanks"),
    countedRelationReplay.replace("0 duplicate groups", "1 duplicate groups")
  ].entries()) {
    const incorrectCountedRelationEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: incorrectCountedRelation
    });
    assert.equal(incorrectCountedRelationEvaluation.tier, "failed", `incorrect counted relation ${incorrectIndex}`);
    assert.equal(incorrectCountedRelationEvaluation.answer_assertion_passed, false, `incorrect counted relation ${incorrectIndex}`);
  }

  const currentBaselineReplay = [
    "## Live findings",
    "Closest source: **Heat Recovery Unit Summary** (schedule ID `1488968`).",
    "It already contains **Mark, Family, and Type**, plus Space Number, Space Name, and Level.",
    "Schedule total: **37 HRUs**.",
    "Independent host-model query: **37 Mechanical Equipment**, all family `HeatRecoveryUnit`, type `Heat Recovery Unit (HRU)`.",
    "Current QA baseline:",
    "- HRU: **37**",
    "- ERU: **0**",
    "- Blank Marks: **0**",
    "- Duplicate Marks: **0**",
    "## Temporary HRU-to-ERU QA schedule plan",
    "Visible fields: Mark, Family, Type.",
    "Filter: Mark begins with ERU. Sort: Mark, ascending. Itemize every instance.",
    "After future HRU→ERU changes, confirm schedule ERU rows = model ERU count and HRU_after + ERU_after = 37.",
    "No schedule was created, cloned, or configured."
  ].join("\n");
  const incompleteCurrentBaseline = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: currentBaselineReplay
  });
  assert.equal(incompleteCurrentBaseline.answer_assertion_passed, false);
  assert.equal(incompleteCurrentBaseline.tier, "failed");
  assert.equal(incompleteCurrentBaseline.answer_assertion_failures.length, 2);
  assert.ok(incompleteCurrentBaseline.answer_assertion_failures.every((failure) => /Expected/i.test(failure)));

  const explicitCurrentBaseline = currentBaselineReplay.replace(
    "After future HRU→ERU changes, confirm schedule ERU rows = model ERU count and HRU_after + ERU_after = 37.",
    "After future HRU→ERU changes, the expected ERU count is **37** and the expected schedule row count is **37**; confirm schedule ERU rows = model ERU count and HRU_after + ERU_after = 37."
  );
  const explicitCurrentBaselineEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: explicitCurrentBaseline
  });
  assert.equal(explicitCurrentBaselineEvaluation.answer_assertion_passed, true);
  assert.equal(explicitCurrentBaselineEvaluation.tier, "verified");

  const markdownValidationReplay = [
    "## Live findings",
    "- Existing source: **Heat Recovery Unit Summary** (schedule ID **1488968**).",
    "- It already contains **Mark, Family, Type**.",
    "- Schedule total: **37 equipment rows**.",
    "- Independent Mechanical Equipment query:",
    "  - `HRU*`: **37**",
    "  - `ERU*`: **0**",
    "- Mark audit: **37 populated, 0 blank, 0 duplicate groups**.",
    "- All 37 are family `HeatRecoveryUnit`, type `Heat Recovery Unit (HRU)`.",
    "## Complete QA schedule plan",
    "1. **Clone** schedule **1488968** in dry-run first.",
    "2. Configure only the clone with visible fields **Mark, Family, Type** and itemize every instance.",
    "3. Filter: **Mark begins with `ERU`**.",
    "4. Sort:",
    "   - **Mark ascending**",
    "5. Validate after the HRU→ERU migration:",
    "   - Schedule rows: **37**",
    "   - Independent model `ERU*` count: **37**",
    "   - Independent model `HRU*` count: **0**",
    "   - Blank Marks: **0**",
    "   - Duplicate Mark groups: **0**",
    "   - Schedule/model reconciliation: **37 = 37**",
    "No schedule was created or configured."
  ].join("\n");
  const markdownValidationEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: markdownValidationReplay
  });
  assert.equal(markdownValidationEvaluation.answer_assertion_passed, true);
  assert.equal(markdownValidationEvaluation.tier, "verified");

  for (const [incorrectMarkdownIndex, incorrectMarkdownReplay] of [
    markdownValidationReplay.replace("Schedule total: **37 equipment rows**", "Schedule total: **36 equipment rows**"),
    markdownValidationReplay.replace("`ERU*`: **0**", "`ERU*`: **5**"),
    markdownValidationReplay.replace("Schedule rows: **37**", "Schedule rows: **36**"),
    markdownValidationReplay.replace("model `ERU*` count: **37**", "model `ERU*` count: **36**"),
    markdownValidationReplay.replace("Blank Marks: **0**", "Blank Marks: **2**")
  ].entries()) {
    const incorrectMarkdownEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: incorrectMarkdownReplay
    });
    assert.equal(incorrectMarkdownEvaluation.answer_assertion_passed, false, `incorrect Markdown replay ${incorrectMarkdownIndex}`);
    assert.equal(incorrectMarkdownEvaluation.tier, "failed", `incorrect Markdown replay ${incorrectMarkdownIndex}`);
  }

  for (const incorrectStructuredReplay of [
    structuredFreshReplay.replace("37 HRUs", "36 HRUs"),
    structuredFreshReplay.replace("ERU-prefixed mechanical equipment:** 0", "ERU-prefixed mechanical equipment:** 5"),
    structuredFreshReplay.replace("ERU schedule rows = **37**", "ERU schedule rows = **36**"),
    structuredFreshReplay.replace("0 blanks", "2 blanks"),
    structuredFreshReplay.replace("0 duplicate groups", "1 duplicate groups")
  ]) {
    const incorrectStructuredEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: incorrectStructuredReplay
    });
    assert.equal(incorrectStructuredEvaluation.tier, "failed");
    assert.equal(incorrectStructuredEvaluation.answer_assertion_passed, false);
  }

  for (const incorrectCurrentResponse of [
    currentLiveResponse.replace("Current ERU count: 0", "Current ERU count: 4"),
    currentLiveResponse.replace("Schedule total: 37 HRUs", "Schedule total: 36 HRUs"),
    currentLiveResponse.replace("Expected post-migration ERU count: 37", "Expected post-migration ERU count: 36"),
    currentLiveResponse.replace("0 blanks", "2 blanks"),
    currentLiveResponse.replace("0 duplicate groups", "1 duplicate groups")
  ]) {
    const incorrectCurrent = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: incorrectCurrentResponse
    });
    assert.equal(incorrectCurrent.tier, "failed");
    assert.equal(incorrectCurrent.answer_assertion_passed, false);
  }

  for (const adversarialRecoveredResponse of [
    latestRecoveredLiveResponse.replace("37 HRU mechanical-equipment instances and 0 ERU", "37 HRU mechanical-equipment instances and 5 ERU"),
    latestRecoveredLiveResponse.replace("0 blanks", "1 blanks"),
    latestRecoveredLiveResponse.replace("0 duplicate groups", "2 duplicate groups"),
    latestRecoveredLiveResponse.replace("Temporary schedule rows: 37", "Temporary schedule rows: 36"),
    latestRecoveredLiveResponse.replace("Schedule/model count difference: 0", "Schedule/model count difference: 1")
  ]) {
    const adversarialEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: adversarialRecoveredResponse
    });
    assert.equal(adversarialEvaluation.tier, "failed");
    assert.equal(adversarialEvaluation.verified, false);
  }

  for (const adversarialNaturalResponse of [
    latestCompleteNaturalResponse.replace("Grand total: 37", "Grand total: 36"),
    latestCompleteNaturalResponse.replace("0 ERU-prefixed Marks", "5 ERU-prefixed Marks"),
    latestCompleteNaturalResponse.replace("0 blank Marks", "1 blank Marks"),
    latestCompleteNaturalResponse.replace("No duplicate Marks observed", "Duplicate Marks observed"),
    latestCompleteNaturalResponse.replace("QA schedule rows 37", "QA schedule rows 36")
  ]) {
    const adversarialEvaluation = evaluateGeneralRevitCapabilityAttempt(entry, {
      ...attempt,
      assistant_message: adversarialNaturalResponse
    });
    assert.equal(adversarialEvaluation.tier, "failed");
    assert.equal(adversarialEvaluation.verified, false);
  }

  const capturedWrongExpectedCount = evaluateGeneralRevitCapabilityAttempt(entry, {
    ...attempt,
    assistant_message: capturedLiveResponse.replace("QA schedule showing **37 rows**", "QA schedule showing **36 rows**")
  });
  assert.equal(capturedWrongExpectedCount.tier, "failed");
  assert.equal(capturedWrongExpectedCount.answer_assertion_passed, false);

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
  assert.equal(latestLiveIncomplete.answer_assertion_failures.length, 3);
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
