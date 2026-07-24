import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlanTraceExtractionReceipt } from "../src/existing_conditions/plan_trace_extraction.js";
import {
  validatePlanTraceSourceAccountingV1,
  type PlanTraceSourceAccountingInputV1
} from "../src/existing_conditions/plan_trace_source_accounting.js";
import {
  compileProvisionalPlanTraceDraftV1,
  provisionalPlanTraceEvidenceSha256,
  type ProvisionalPlanTraceDraftContext,
  type ProvisionalPlanTraceDraftInputV1
} from "../src/existing_conditions/provisional_plan_trace_draft.js";
import { buildAtomicMepDraftWorkflowRequest } from "../src/existing_conditions/mep_draft_plan.js";
import { solveExistingConditionsRegistration, type ExistingConditionsRegistrationInput } from "../src/existing_conditions/registration.js";

const SOURCE_PDF_HASH = "a".repeat(64);
const RENDER_HASH = "b".repeat(64);
const POLICY_HASH = "c".repeat(64);

function extraction(): PlanTraceExtractionReceipt {
  return {
    schema_version: 1,
    source_image_sha256: RENDER_HASH,
    width_px: 100,
    height_px: 80,
    extraction_policy: {
      monochrome_ink: { maximum_luminance: 110, maximum_chroma: 10 },
      minimum_chroma: 0,
      minimum_alpha: 240,
      scope_polygon: null,
      minimum_component_pixels: 4,
      simplify_tolerance_px: 1
    },
    extraction_policy_sha256: POLICY_HASH,
    matched_pixel_count: 30,
    retained_pixel_count: 30,
    components: [
      {
        component_id: "fragment-a",
        pixel_count: 15,
        skeleton_pixel_count: 10,
        bounds_px: { min: { x: 10, y: 20 }, max: { x: 30, y: 20 } },
        polylines: [{ points: [{ x: 10, y: 20 }, { x: 30, y: 20 }], length_px: 20, closed: false }]
      },
      {
        component_id: "fragment-b",
        pixel_count: 15,
        skeleton_pixel_count: 10,
        bounds_px: { min: { x: 50, y: 20 }, max: { x: 70, y: 20 } },
        polylines: [{ points: [{ x: 50, y: 20 }, { x: 70, y: 20 }], length_px: 20, closed: false }]
      }
    ],
    usage_constraints: []
  };
}

function accountingInput(includeUnresolved = false): PlanTraceSourceAccountingInputV1 {
  return {
    schema_version: 1,
    scope_id: "monochrome-route-scope",
    source_image_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    evidence_sets: [{ evidence_set_id: "monochrome-ink", extraction_policy_sha256: POLICY_HASH }],
    candidates: includeUnresolved
      ? [
          {
            candidate_id: "route-fragment-a",
            discipline: "plumbing",
            source_paths: [{ evidence_set_id: "monochrome-ink", component_id: "fragment-a", polyline_index: 0 }],
            geometry_role: "route_centerline",
            continuity: "observed_contiguous",
            disposition: { status: "promoted", normalized_kind: "route_trace" }
          },
          {
            candidate_id: "unresolved-fragment-b",
            discipline: "plumbing",
            source_paths: [{ evidence_set_id: "monochrome-ink", component_id: "fragment-b", polyline_index: 0 }],
            geometry_role: "unknown",
            continuity: "not_applicable",
            disposition: {
              status: "unresolved",
              reason: "mixed_symbol_and_route",
              note: "This mark may be a callout leader crossing a route."
            }
          }
        ]
      : [{
          candidate_id: "dashed-route",
          discipline: "plumbing",
          source_paths: [
            { evidence_set_id: "monochrome-ink", component_id: "fragment-a", polyline_index: 0 },
            { evidence_set_id: "monochrome-ink", component_id: "fragment-b", polyline_index: 0 }
          ],
          geometry_role: "route_centerline",
          continuity: "disconnected_dashes",
          disposition: { status: "promoted", normalized_kind: "route_trace" }
        }]
  };
}

function registrationInput(): ExistingConditionsRegistrationInput {
  return {
    source_evidence_sha256: SOURCE_PDF_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
      { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
      { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
    ]
  };
}

function context(): ProvisionalPlanTraceDraftContext {
  return {
    source_accounting: { evidence_sets: [{ evidence_set_id: "monochrome-ink", receipt: extraction() }] },
    registered_frame_receipt: {
      schema_version: 1,
      evidence_kind: "registered_render_to_model_frame",
      fixture_id: "monochrome-plan-trace-draft-v1",
      scope_id: "monochrome-route-scope",
      source_pdf_sha256: SOURCE_PDF_HASH,
      registered_render_sha256: RENDER_HASH,
      width_px: 100,
      height_px: 80,
      coordinate_space: "registered_render_pixels_top_left",
      model_bounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 80 } },
      registration_receipt_sha256: provisionalPlanTraceEvidenceSha256(
        solveExistingConditionsRegistration(registrationInput())
      ),
      access_scope: "agent_visible"
    },
    native_view_inventory: {
      schema_version: 1,
      evidence_kind: "native_view_inventory",
      fixture_id: "monochrome-plan-trace-draft-v1",
      scope_id: "monochrome-route-scope",
      access_scope: "agent_visible",
      views: [{
        reference_key: "plumbing-plan-view",
        element_id: 3962340,
        category: "OST_Views",
        role: "registered plumbing plan",
        view_type: "EngineeringPlan",
        level_name: "Level 03",
        level_elevation_ft: 12
      }]
    }
  };
}

function input(includeUnresolved = false): ProvisionalPlanTraceDraftInputV1 {
  const sourceAccounting = accountingInput(includeUnresolved);
  const compilationContext = context();
  const receipt = validatePlanTraceSourceAccountingV1(sourceAccounting, compilationContext.source_accounting);
  const frameHash = provisionalPlanTraceEvidenceSha256(compilationContext.registered_frame_receipt);
  const viewInventoryHash = provisionalPlanTraceEvidenceSha256(compilationContext.native_view_inventory);
  return {
    schema_version: 1,
    fixture_id: "monochrome-plan-trace-draft-v1",
    scope_id: sourceAccounting.scope_id,
    source_pdf_sha256: SOURCE_PDF_HASH,
    visible_evidence: [
      { role: "source pdf", sha256: SOURCE_PDF_HASH },
      { role: "registered source render", sha256: RENDER_HASH },
      { role: "registered render to model frame", sha256: frameHash },
      { role: "native model inventory", sha256: viewInventoryHash }
    ],
    registered_render: {
      evidence_role: "registered source render",
      sha256: RENDER_HASH,
      width_px: 100,
      height_px: 80,
      access_scope: "agent_visible"
    },
    frame_reference: {
      evidence_role: "registered render to model frame",
      evidence_sha256: frameHash
    },
    registration: registrationInput(),
    source_accounting: sourceAccounting,
    expected_source_contract_sha256: receipt.source_contract_sha256,
    expected_source_geometry_sha256: receipt.source_geometry_sha256,
    expected_draft_candidate_fingerprint_sha256: receipt.draft_candidate_fingerprint_sha256,
    level_name: "Level 03",
    level_elevation_ft: 12,
    view_reference: {
      reference_key: "plumbing-plan-view",
      element_id: 3962340,
      category: "OST_Views",
      role: "registered plumbing plan",
      evidence_role: "native model inventory",
      evidence_sha256: viewInventoryHash
    },
    view_type: "EngineeringPlan",
    explicit_unscored_user_direction: true,
    user_direction_reference: "User requested best-recoverable provisional drafting from black-and-white record documents.",
    maximum_created_elements: 20
  };
}

test("monochrome disconnected fragments compile as separate neutral plan traces without bridging the gap", () => {
  const plan = compileProvisionalPlanTraceDraftV1(input(), context());
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.provisional_observation_ids, ["dashed-route"]);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.path, "/revit/draw-detail-curves");
  assert.equal(plan.actions[0]?.expected_created_max, 2);
  assert.deepEqual(plan.actions[0]?.apply_body?.curves, [
    { kind: "line", a: { xyz: [10, 60, 12] }, b: { xyz: [30, 60, 12] } },
    { kind: "line", a: { xyz: [50, 60, 12] }, b: { xyz: [70, 60, 12] } }
  ]);
  assert.equal(plan.actions[0]?.provisional_plan_representation?.continuity, "disconnected_dashes");
  assert.equal(plan.actions[0]?.provisional_plan_representation?.modeled_route_created, false);
  assert.equal(plan.actions[0]?.provisional_plan_representation?.native_medium_classified, false);
  assert.match(plan.warnings.join(" "), /black and white/i);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
  assert.equal(workflow.maximumCreatedElements, 2);
});

test("resolved geometry proceeds while unresolved source geometry remains visible clarification work", () => {
  const plan = compileProvisionalPlanTraceDraftV1(input(true), context());
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.promoted_observation_ids, ["route-fragment-a"]);
  assert.deepEqual(plan.deferred_observation_ids, ["unresolved-fragment-b"]);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.ambiguities[0]?.id, "clarify:unresolved-fragment-b");
  assert.match(plan.ambiguities[0]?.description ?? "", /callout leader/i);
});

test("all-unresolved source geometry remains clarification-required and cannot emit a workflow", () => {
  const value = input(true);
  value.source_accounting.candidates[0] = {
    ...value.source_accounting.candidates[0]!,
    geometry_role: "unknown",
    continuity: "not_applicable",
    disposition: { status: "unresolved", reason: "unknown_role", note: "Route role is not visible." }
  };
  const receipt = validatePlanTraceSourceAccountingV1(value.source_accounting, context().source_accounting);
  value.expected_source_contract_sha256 = receipt.source_contract_sha256;
  value.expected_source_geometry_sha256 = receipt.source_geometry_sha256;
  value.expected_draft_candidate_fingerprint_sha256 = receipt.draft_candidate_fingerprint_sha256;
  const plan = compileProvisionalPlanTraceDraftV1(value, context());
  assert.equal(plan.status, "clarification_required");
  assert.equal(plan.actions.length, 0);
  assert.throws(() => buildAtomicMepDraftWorkflowRequest(plan), /not_ready/);
});

test("draft compilation rejects accounting, geometry, and candidate fingerprint drift", () => {
  for (const field of [
    "expected_source_contract_sha256",
    "expected_source_geometry_sha256",
    "expected_draft_candidate_fingerprint_sha256"
  ] as const) {
    const value = input();
    value[field] = "f".repeat(64);
    assert.throws(
      () => compileProvisionalPlanTraceDraftV1(value, context()),
      /fingerprint_mismatch/
    );
  }
});

test("draft compilation rejects hidden renders, unbound views or frames, frame drift, and missing explicit direction", () => {
  const hidden = input();
  hidden.registered_render.evidence_role = "withheld evaluator truth";
  hidden.visible_evidence[1]!.role = "withheld evaluator truth";
  assert.throws(() => compileProvisionalPlanTraceDraftV1(hidden, context()), /render_evidence_role_forbidden/);

  const wrongView = input();
  wrongView.view_reference.category = "OST_Walls";
  assert.throws(() => compileProvisionalPlanTraceDraftV1(wrongView, context()), /view_reference_category_mismatch/);

  const arbitraryView = input();
  arbitraryView.view_reference.element_id = 123456;
  assert.throws(() => compileProvisionalPlanTraceDraftV1(arbitraryView, context()), /view_reference_inventory_mismatch/);

  const alteredInventory = context();
  alteredInventory.native_view_inventory.views[0]!.element_id = 123456;
  assert.throws(
    () => compileProvisionalPlanTraceDraftV1(input(), alteredInventory),
    /native_view_inventory_hash_mismatch/
  );

  const alteredFrame = context();
  alteredFrame.registered_frame_receipt.model_bounds.max.x = 200;
  assert.throws(
    () => compileProvisionalPlanTraceDraftV1(input(), alteredFrame),
    /registered_frame_receipt_hash_mismatch/
  );

  const frameDrift = input();
  frameDrift.registered_render.width_px = 101;
  assert.throws(() => compileProvisionalPlanTraceDraftV1(frameDrift, context()), /accounting_frame_mismatch/);

  const noDirection = input();
  noDirection.explicit_unscored_user_direction = false as true;
  assert.throws(() => compileProvisionalPlanTraceDraftV1(noDirection, context()), /requires_explicit_unscored_user_direction/);

  const sourceBackedView = input();
  sourceBackedView.view_reference.evidence_role = "registered source render";
  sourceBackedView.view_reference.evidence_sha256 = RENDER_HASH;
  assert.throws(() => compileProvisionalPlanTraceDraftV1(sourceBackedView, context()), /view_reference_requires_native_evidence/);
});

test("creation budget and source registration remain fail-closed", () => {
  const budget = input();
  budget.maximum_created_elements = 1;
  assert.throws(() => compileProvisionalPlanTraceDraftV1(budget, context()), /creation_budget_exceeded:2\/1/);

  const wrongSource = input();
  wrongSource.registration.source_evidence_sha256 = "e".repeat(64);
  assert.throws(() => compileProvisionalPlanTraceDraftV1(wrongSource, context()), /registration_source_hash_mismatch/);

  const registrationDrift = input();
  for (const controlPoint of registrationDrift.registration.control_points) {
    controlPoint.model.x += 1;
  }
  assert.throws(
    () => compileProvisionalPlanTraceDraftV1(registrationDrift, context()),
    /registered_frame_registration_mismatch/
  );
});

test("CLI exposes only an explicitly authorized unscored provisional workflow", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-plan-trace-cli-"));
  const inputPath = path.join(directory, "input.json");
  const contextPath = path.join(directory, "context.json");
  const planPath = path.join(directory, "plan.json");
  const workflowPath = path.join(directory, "workflow.json");
  fs.writeFileSync(inputPath, `${JSON.stringify(input(), null, 2)}\n`, "utf8");
  fs.writeFileSync(contextPath, `${JSON.stringify(context(), null, 2)}\n`, "utf8");
  const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
  const args = [
    cli,
    "compile-provisional-plan-traces",
    "--input", inputPath,
    "--context", contextPath,
    "--out", planPath,
    "--workflow-out", workflowPath,
    "--max-created", "2"
  ];
  assert.throws(
    () => execFileSync(process.execPath, args, { stdio: "pipe" }),
    /Command failed/
  );
  execFileSync(process.execPath, [...args, "--allow-unscored-user-workflow"], { stdio: "pipe" });
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { status: string };
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8")) as {
    dryRun: boolean;
    maximumCreatedElements: number;
    benchmarkCredit: boolean;
    authorizationBasis: string;
    operations: Array<{
      path: string;
      provisional_plan_representation?: {
        representation_role: string;
        modeled_route_created: boolean;
        native_medium_classified: boolean;
      };
    }>;
  };
  assert.equal(plan.status, "partially_ready");
  assert.equal(workflow.dryRun, true);
  assert.equal(workflow.maximumCreatedElements, 2);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
  assert.equal(workflow.operations[0]?.path, "/revit/draw-detail-curves");
  assert.equal(workflow.operations[0]?.provisional_plan_representation?.representation_role, "view_specific_plan_route_trace");
  assert.equal(workflow.operations[0]?.provisional_plan_representation?.modeled_route_created, false);
  assert.equal(workflow.operations[0]?.provisional_plan_representation?.native_medium_classified, false);

  const destructiveOutArgs = [
    cli,
    "compile-provisional-plan-traces",
    "--input", inputPath,
    "--context", contextPath,
    "--out", inputPath
  ];
  const preservedInput = fs.readFileSync(inputPath, "utf8");
  assert.throws(
    () => execFileSync(process.execPath, destructiveOutArgs, { stdio: "pipe" }),
    /Command failed/
  );
  assert.equal(fs.readFileSync(inputPath, "utf8"), preservedInput);

  const invalidPlanPath = path.join(directory, "invalid-plan.json");
  const invalidWorkflowPath = path.join(directory, "invalid-workflow.json");
  assert.throws(
    () => execFileSync(process.execPath, [
      cli,
      "compile-provisional-plan-traces",
      "--input", inputPath,
      "--context", contextPath,
      "--out", invalidPlanPath,
      "--workflow-out", invalidWorkflowPath,
      "--max-created", "1",
      "--allow-unscored-user-workflow"
    ], { stdio: "pipe" }),
    /Command failed/
  );
  assert.equal(fs.existsSync(invalidPlanPath), false);
  assert.equal(fs.existsSync(invalidWorkflowPath), false);
});
