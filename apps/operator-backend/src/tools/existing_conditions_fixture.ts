import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  normalizeExistingConditionsSnapshot,
  mergeExistingConditionsVisibleElementPayloads,
  mergeExistingConditionsSameViewVisibleElementPayloads,
  selectExistingConditionsImageScope,
  validateExistingConditionsImageScopeAgainstVisibleInventory,
  scoreExistingConditionsReconstruction,
  DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY,
  type ExistingConditionsCandidate,
  type ExistingConditionsGroundTruth,
  type ExistingConditionsImageScopeReceipt,
  type ExistingConditionsSnapshot,
  type ExistingConditionsScoringPolicy
} from "../benchmark/existing_conditions_reconstruction.js";
import {
  advanceExistingConditionsController,
  createExistingConditionsControllerState,
  getExistingConditionsControllerNextAction,
  type ExistingConditionsControllerEvent,
  type ExistingConditionsControllerState
} from "../existing_conditions/controller.js";
import { createExistingConditionsEvaluatorChangeReceipt } from "../existing_conditions/evaluator_diff.js";
import {
  createExistingConditionsEvaluatorVisualReceipt,
  validateExistingConditionsEvaluatorVisualReceipt,
  type ExistingConditionsEvaluatorVisualReceipt
} from "../existing_conditions/evaluator_visual.js";
import { assertExistingConditionsContract } from "../existing_conditions/contract_validation.js";
import {
  scoreEngineeringInvariantBenchmark,
  type EngineeringAcceptanceBasis,
  type EngineeringBenchmarkTaskContract,
  type EngineeringCheckResult,
  type EngineeringStandardsContext,
  type EvaluatorOwnedAccessProvenance,
  type EvaluatorOwnedChangeReceipt
} from "../existing_conditions/engineering_invariants.js";
import {
  createEngineeringCaseEvidenceProvenance,
  evaluateEngineeringInvariantCase,
  type EngineeringCaseDefinition,
  type EngineeringCaseEvidenceProvenance,
  type EngineeringCaseNativeEvidence
} from "../existing_conditions/engineering_case_runner.js";
import {
  assertExpectedCircuitLoadingModelSha256,
  assertExpectedDwellingWallCoverageModelSha256,
  assertExpectedGfciModelSha256,
  assertExpectedPlumbingFixtureServicesModelSha256,
  collectCircuitLoadingNativeEvidence,
  collectDwellingWallCoverageNativeEvidence,
  collectGfciNativeEvidence,
  collectPlumbingFixtureServicesNativeEvidence,
  plumbingFixtureAuditDiscoveryTokens,
  selectCircuitLoadingScopedElementIds,
  selectGfciScopedElementIds,
  type CircuitLoadingNativeAdapterConfig,
  type DwellingWallCoverageNativeAdapterConfig,
  type GfciNativeAdapterConfig,
  type PlumbingFixtureServicesNativeAdapterConfig,
  type NativeParameterReadback
} from "../existing_conditions/engineering_native_adapters.js";
import {
  buildAtomicMepDraftWorkflowRequest,
  compileMepDraftPlan,
  type AtomicMepDraftWorkflowRequest,
  type MepDraftPackage
} from "../existing_conditions/mep_draft_plan.js";
import {
  compileRegisteredMepObservations,
  type RegisteredMepObservationPackage
} from "../existing_conditions/registered_mep_observations.js";
import {
  promoteScoreGatedMepWorkflow,
  scoreMepPreApplyGeometry
} from "../existing_conditions/mep_pre_apply_geometry_gate.js";
import {
  solveExistingConditionsRegistration,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "../existing_conditions/registration.js";
import {
  assessExistingConditionsRegistrationAmbiguity,
  type ExistingConditionsRegistrationAmbiguityInputV1
} from "../existing_conditions/registration_ambiguity.js";
import {
  compileArchitecturalShellPlan,
  type ArchitecturalShellPackage
} from "../existing_conditions/architectural_shell_plan.js";
import {
  compileArchitecturalPlanGeometryPreview,
  promoteArchitecturalPlanGeometryPreview,
  type CompiledArchitecturalPlanGeometryPreview,
  type ArchitecturalPlanGeometryPreviewPackage,
  type ArchitecturalPlanGeometryResolution
} from "../existing_conditions/architectural_plan_geometry_preview.js";
import { scoreArchitecturalPlanGeometryPreview } from "../existing_conditions/architectural_plan_geometry_score.js";
import {
  promoteArchitecturalPlanGeometryWithCatalog,
  type ArchitecturalPrecedentCatalog,
  type ArchitecturalPrecedentSignal
} from "../existing_conditions/architectural_precedent_catalog.js";
import {
  buildArchitecturalSourceDelta,
  type ArchitecturalSourceDeltaInput,
  type ArchitecturalSourceDeltaReceipt
} from "../existing_conditions/architectural_source_delta.js";
import {
  compareCalibratedExistingConditionsCrops,
  type CalibratedCropComparisonInput
} from "../existing_conditions/calibrated_crop_comparator.js";
import { auditArchitecturalRedactionVisibility } from "../existing_conditions/architectural_redaction_visibility_gate.js";
import {
  buildExistingConditionsDeleteRequest,
  verifyExistingConditionsDeletedElementReadback
} from "../existing_conditions/redaction_delete_request.js";
import {
  auditLinkedBackgroundModelHealth,
  DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY
} from "../existing_conditions/linked_background_model_gate.js";
import {
  buildArchitecturalMeasurementOverlay,
  compileArchitecturalPixelMeasurementPreview,
  type ArchitecturalMeasurementOverlayReceipt,
  type ArchitecturalPixelMeasurementPackage
} from "../existing_conditions/architectural_pixel_measurement.js";
import {
  buildArchitecturalWallLineCandidates,
  type ArchitecturalWallLineCandidateReceipt
} from "../existing_conditions/architectural_wall_line_candidates.js";
import {
  validateArchitecturalOpeningClassification,
  type ArchitecturalOpeningClassificationReceipt
} from "../existing_conditions/architectural_opening_classification.js";
import { scoreArchitecturalOpeningClassification } from "../existing_conditions/architectural_opening_classification_score.js";
import {
  buildArchitecturalDoorSpanObservationReceipt,
  type ArchitecturalDoorSpanObservationPackage
} from "../existing_conditions/architectural_door_span_observation.js";
import {
  resolveArchitecturalOpeningHosts,
  type ArchitecturalOpeningHostResolutionReceipt
} from "../existing_conditions/architectural_opening_host_resolution.js";
import { scoreArchitecturalOpeningHostResolution } from "../existing_conditions/architectural_opening_host_resolution_score.js";
import {
  extractPlanTraces,
  renderPlanTraceExtractionPreview,
  type PlanTraceExtractionInput,
  type PlanTraceExtractionReceipt
} from "../existing_conditions/plan_trace_extraction.js";
import {
  compilePlanTraceSeedSpinesV1,
  type PlanTraceSeedSpineInputV1
} from "../existing_conditions/plan_trace_seed_spine.js";
import {
  resolvePlanTraceContinuationAnchorV1,
  type PlanTraceContinuationAnchorRepairInputV1
} from "../existing_conditions/plan_trace_continuation_anchor_repair.js";
import {
  normalizePlanTraceSeedSpinesV1,
  type PlanTraceSpineNormalizationInputV1
} from "../existing_conditions/plan_trace_spine_normalization.js";
import {
  validateBoundedMepRegionCoverage,
  type BoundedMepRegionCoverageContext,
  type BoundedMepRegionCoverageV1,
  type BoundedMepRegionCoverageV2
} from "../existing_conditions/mep_region_coverage.js";
import {
  detectRepeatedMepSymbols,
  type MepRepeatedSymbolDetectionInputV1
} from "../existing_conditions/mep_repeated_symbol_detection.js";
import {
  detectSheetChromaticComponentsV1,
  renderSheetChromaticComponentOverlayV1,
  type SheetChromaticComponentDetectionInputV1
} from "../existing_conditions/sheet_chromatic_component_detection.js";
import {
  renderSheetRouteChromaticCoverageOverlayV1,
  validateSheetRouteChromaticCoverageV1,
  type SheetRouteChromaticCoverageInputV1
} from "../existing_conditions/sheet_route_chromatic_coverage.js";
import {
  compileSheetOverlapRoutesV1,
  type SheetOverlapRouteCompilationInputV1
} from "../existing_conditions/sheet_overlap_route_compiler.js";
import {
  evaluateSourceNativePairHealthV1,
  type SourceNativePairHealthInputV1
} from "../existing_conditions/source_native_pair_health.js";
import {
  evaluateSealedCandidateNativeRouteGradeV1,
  type SealedCandidateNativeRouteGradeInputV1
} from "../existing_conditions/sealed_candidate_native_route_grade.js";
import {
  compileProvisionalPlanTraceDraftV1,
  type ProvisionalPlanTraceDraftContext,
  type ProvisionalPlanTraceDraftInputV1
} from "../existing_conditions/provisional_plan_trace_draft.js";
import {
  compileSheetTopologyV1,
  type SheetTopologyCompilationContextV1,
  type SheetTopologyCompilationInputV1
} from "../existing_conditions/sheet_topology_compiler.js";
import {
  buildSheetTopologyCalibrationProfileV1,
  type SheetTopologyCalibrationBuildInputV1
} from "../existing_conditions/sheet_topology_calibration.js";
import {
  compileSheetPixelInterpretationV1,
  type SheetPixelInterpretationContextV1,
  type SheetPixelInterpretationInputV1
} from "../existing_conditions/sheet_pixel_interpretation.js";
import { validateSheetPixelEvidenceV1 } from "../existing_conditions/sheet_pixel_evidence.js";
import {
  extractSheetVectorTextV1,
  type SheetVectorTextExtractionInputV1
} from "../existing_conditions/sheet_vector_text.js";
import {
  planRegisteredRouteConnectorSnapV1,
  type RegisteredRouteSnapCandidateV1,
  type RegisteredRouteSnapContextV1
} from "../existing_conditions/registered_route_connector_snap.js";
import {
  discoverRegisteredRouteFrontierV1,
  type RegisteredRouteFrontierCandidateV1,
  type RegisteredRouteFrontierPolicyV1
} from "../existing_conditions/registered_route_frontier_discovery.js";
import {
  analyzeExistingConditionsSheetWithGeminiV1,
  type GeminiExistingConditionsSheetRequestV1
} from "../vision/gemini_existing_conditions_sheet.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return value;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function sheetPixelInterpretation(value: unknown): SheetPixelInterpretationInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sheet_pixel_interpretation_input_must_be_object");
  const wrapper = value as { interpretation?: unknown };
  return (wrapper.interpretation ?? value) as SheetPixelInterpretationInputV1;
}

function readJsonWithSha256(filePath: string): { value: unknown; sha256: string } {
  const bytes = fs.readFileSync(path.resolve(filePath));
  return {
    value: JSON.parse(bytes.toString("utf8")),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex")
  };
}

function parseIds(value: string): number[] {
  const ids = value.split(",").map((entry) => Number(entry.trim())).filter((entry) => Number.isInteger(entry) && entry > 0);
  if (ids.length === 0) throw new Error("--ids must contain at least one positive integer.");
  return [...new Set(ids)];
}

function parseCsv(value: string, label: string): string[] {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${label} must contain at least one value.`);
  return [...new Set(values)];
}

function parseNumbers(value: string, count: number, label: string): number[] {
  const values = value.split(",").map((entry) => Number(entry.trim()));
  if (values.length !== count || values.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${label} must contain exactly ${count} comma-separated numbers.`);
  }
  return values;
}

function optionalDiscipline(): "mechanical" | "plumbing" | "electrical" | "architectural" | "mixed" | undefined {
  const value = argument("--discipline").toLowerCase();
  if (!value) return undefined;
  if (!["mechanical", "plumbing", "electrical", "architectural", "mixed"].includes(value)) {
    throw new Error("--discipline must be mechanical, plumbing, electrical, architectural, or mixed.");
  }
  return value as "mechanical" | "plumbing" | "electrical" | "architectural" | "mixed";
}

const EXISTING_CONDITIONS_SCORING_POLICY_KEYS = Object.keys(DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY) as Array<keyof ExistingConditionsScoringPolicy>;
const NON_NEGATIVE_SCORING_POLICY_KEYS = new Set<keyof ExistingConditionsScoringPolicy>([
  "location_tolerance_ft",
  "endpoint_tolerance_ft",
  "rotation_tolerance_degrees",
  "size_tolerance_ft",
  "elevation_tolerance_ft"
]);
const UNIT_INTERVAL_SCORING_POLICY_KEYS = new Set<keyof ExistingConditionsScoringPolicy>([
  "project_context_elevation_geometry_weight",
  "unobserved_elevation_geometry_weight",
  "minimum_pair_score",
  "minimum_precision",
  "minimum_recall",
  "minimum_connectivity_score",
  "minimum_architectural_topology_score",
  "minimum_system_score",
  "minimum_spatial_score",
  "minimum_hosting_score",
  "minimum_electrical_circuit_score"
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function existingConditionsScoringPolicyFingerprint(policy: ExistingConditionsScoringPolicy): string {
  return crypto.createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}

function parseExistingConditionsScoringPolicy(): ExistingConditionsScoringPolicy {
  const policyFlagIndex = process.argv.indexOf("--policy");
  if (policyFlagIndex < 0) return { ...DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY };
  const raw = String(process.argv[policyFlagIndex + 1] ?? "").trim();
  if (!raw) throw new Error("--policy must be a JSON object.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("--policy must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--policy must be a JSON object.");
  }

  const overrides = parsed as Record<string, unknown>;
  const allowedKeys = new Set<string>(EXISTING_CONDITIONS_SCORING_POLICY_KEYS);
  for (const key of Object.keys(overrides)) {
    if (!allowedKeys.has(key)) throw new Error(`--policy contains unknown key: ${key}`);
    const value = overrides[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`--policy.${key} must be a finite number.`);
    }
    const typedKey = key as keyof ExistingConditionsScoringPolicy;
    if (NON_NEGATIVE_SCORING_POLICY_KEYS.has(typedKey) && value < 0) {
      throw new Error(`--policy.${key} must be greater than or equal to 0.`);
    }
    if (key === "rotation_tolerance_degrees" && value > 180) {
      throw new Error("--policy.rotation_tolerance_degrees must be between 0 and 180.");
    }
    if (UNIT_INTERVAL_SCORING_POLICY_KEYS.has(typedKey) && (value < 0 || value > 1)) {
      throw new Error(`--policy.${key} must be between 0 and 1.`);
    }
    if (key === "passing_score" && (value < 0 || value > 100)) {
      throw new Error("--policy.passing_score must be between 0 and 100.");
    }
  }

  return {
    ...DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY,
    ...overrides
  } as ExistingConditionsScoringPolicy;
}

function writeJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`${resolved}\n`);
}

function writeFreshJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const handle = fs.openSync(resolved, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  process.stdout.write(`${resolved}\n`);
}

function assertFreshDistinctOutputPaths(
  entries: Array<{ flag: string; value: string }>,
  protectedEntries: Array<{ flag: string; value: string }> = []
): void {
  const seen = new Map<string, string>();
  for (const entry of protectedEntries) {
    const resolved = canonicalPath(entry.value);
    const prior = seen.get(resolved);
    if (prior) throw new Error(`${entry.flag} must not reuse the same path as ${prior}.`);
    seen.set(resolved, entry.flag);
  }
  for (const entry of entries) {
    const resolved = canonicalPath(entry.value);
    const prior = seen.get(resolved);
    if (prior) throw new Error(`${entry.flag} must not reuse the same path as ${prior}.`);
    seen.set(resolved, entry.flag);
    if (fs.existsSync(path.resolve(entry.value))) {
      throw new Error(`${entry.flag} must identify a fresh output path so a stale artifact cannot be mistaken for this run.`);
    }
  }
}

function markExplicitUnscoredUserWorkflow(workflow: AtomicMepDraftWorkflowRequest): AtomicMepDraftWorkflowRequest {
  return {
    ...workflow,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  };
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run existing-conditions -- normalize --visible <export-visible-elements.json> --connectors <get-connectors.json> --ids <id,id,...> --out <snapshot.json>",
    "  npm run existing-conditions -- inventory (--expected-model <model.rvt> | --expected-document-title <exact-title> --allow-title-only-development) --view-id <id> --out-dir <inventory-dir> --token-file <operator_token.txt> --grant-file <write_grant.json> [--categories <OST_...,OST_...>] [--include-linked] [--model-bounds <minX,minY,minZ,maxX,maxY,maxZ>]",
    "  npm run existing-conditions -- scope-image-region --visible <export-visible-elements.json> --image-region <minX,minY,maxX,maxY> --out <scope.json> [--padding-px <pixels>] [--include-linked-scope] [--level-names <name,name>]",
    "  npm run existing-conditions -- solve-registration --input <registration-input-or-wrapper.json> --out <registration-receipt.json>",
    "  npm run existing-conditions -- assess-registration-ambiguity --input <candidate-search.json> --out <ambiguity-receipt.json>",
    "  npm run existing-conditions -- compare-calibrated-crops --input <hash-bound-source-candidate-controls-and-features.json> --out-dir <evidence-dir> --out <comparison-receipt.json>",
    "  npm run existing-conditions -- extract-plan-traces --input <hash-bound-extraction-policy.json> --out <trace-receipt.json> [--preview-out <diagnostic-overlay.png>]",
    "  npm run existing-conditions -- repair-plan-trace-continuation-anchor --input <trusted-anchor-policy.json> --receipt <trace-receipt.json> --out <attachment-receipt.json>",
    "  npm run existing-conditions -- compile-plan-trace-seed-spines --input <host-trusted-seed-spans.json> --receipt <trace-receipt.json> --out <spine-receipt.json>",
    "  npm run existing-conditions -- normalize-plan-trace-spines --input <bounded-normalization-policy.json> --receipt <spine-receipt.json> --out <normalized-spine-receipt.json>",
    "  npm run existing-conditions -- detect-repeated-mep-symbols --input <hash-bound-template-search.json> --out <candidate-receipt.json>",
    "  npm run existing-conditions -- extract-sheet-vector-text --input <hash-bound-pdf-render-and-text-filter.json> --out <vector-text-receipt.json>",
    "  npm run existing-conditions -- detect-sheet-chromatic-components --input <hash-bound-hue-component-search.json> --out <candidate-receipt.json> [--overlay-out <diagnostic-overlay.png>]",
    "  npm run existing-conditions -- validate-sheet-route-chromatic-coverage --input <hash-bound-source-policy.json> [--candidate <sheet-interpretation-or-provider-receipt.json>] --out <coverage-receipt.json> [--overlay-out <diagnostic-overlay.png>]",
    "  npm run existing-conditions -- compile-sheet-overlap-routes --input <registered-overlap-tiles.json> --out <parent-route-compilation.json>",
    "  npm run existing-conditions -- evaluate-source-native-pair-health --input <evaluator-only-pair.json> --out <pair-health-receipt.json>",
    "  npm run existing-conditions -- grade-sealed-candidate-native-routes --input <evaluator-only-post-seal-grade.json> --out <native-grade-receipt.json>",
    "  npm run existing-conditions -- validate-mep-region-coverage --input <source-coverage.json> --context <coverage-context.json> --out <coverage-receipt.json>",
    "  npm run existing-conditions -- compile-sheet-topology --input <whole-sheet-primitives.json> --context <trusted-views-and-calibration.json> --out <compiled-topology.json>",
    "  npm run existing-conditions -- build-sheet-topology-calibration --input <sealed-blind-outcomes.json> --out <calibration-profile.json>",
    "  npm run existing-conditions -- compile-sheet-pixel-interpretation --input <normalized-sheet-observations.json> --context <trusted-frames-and-calibration.json> --out <compiled-topology.json>",
    "  npm run existing-conditions -- interpret-sheet-gemini --input <source-only-sheet-request.json> --out <normalized-sheet-observations.json>",
    "  npm run existing-conditions -- validate-sheet-pixel-evidence --input <observations-or-provider-receipt.json> --image <source-image.png> --out <evidence-receipt.json> [--overlay-out <overlay.png>]",
    "  npm run existing-conditions -- plan-registered-route-snap --input <registered-route-candidate.json> --context <native-connectors-and-policy.json> --out <staged-route-action.json>",
    "  npm run existing-conditions -- discover-registered-route-frontier --input <source-registered-route.json> --context <native-connectors-and-policy.json> --out <resolved-frontier.json>",
    "  npm run existing-conditions -- compile-provisional-plan-traces --input <plan-trace-draft.json> --context <source-accounting-context.json> --out <compiled-plan.json> [--workflow-out <atomic-dry-run-request.json> --allow-unscored-user-workflow] [--max-created <count>]",
    "  npm run existing-conditions -- compile-registered-mep-observations --input <registered-pixel-observations.json> --out <compilation.json> [--package-out <mep-draft-package.json>] [--workflow-out <atomic-dry-run-request.json> --allow-unscored-user-workflow] [--max-created <count>]",
    "  npm run existing-conditions -- promote-registered-mep-observations --input <registered-pixel-observations.json> --truth <evaluator-ground-truth.json> --out <promotion.json> --score-out <pre-apply-score.json> --workflow-out <atomic-request.json> [--max-created <count>] [--apply]",
    "  npm run existing-conditions -- compile-mep-draft --input <source-observations.json> --out <compiled-plan.json> [--workflow-out <atomic-dry-run-request.json> --allow-unscored-user-workflow] [--max-created <count>]",
    "  npm run existing-conditions -- compile-architectural-preview --input <source-observations.json> --out <preview.json>",
    "  npm run existing-conditions -- score-architectural-preview --truth <ground-truth.json> --preview <compiled-preview.json> --out <score.json>",
    "  npm run existing-conditions -- build-architectural-delta --input <registered-source-and-redacted-capture.json> --out-dir <derived-artifacts-dir> --out <receipt.json>",
    "  npm run existing-conditions -- build-architectural-measurement --delta-receipt <receipt.json> --out-dir <measurement-dir> --out <measurement-receipt.json>",
    "  npm run existing-conditions -- build-architectural-wall-candidates --delta-receipt <receipt.json> --measurement-receipt <receipt.json> --out-dir <candidate-dir> --out <candidate-receipt.json>",
    "  npm run existing-conditions -- validate-architectural-opening-classification --candidate-receipt <receipt.json> --classification <agent-classification.json> --out <validated-classification.json>",
    "  npm run existing-conditions -- score-architectural-opening-classification --truth <ground-truth.json> --candidate-receipt <receipt.json> --classification <validated-classification.json> --out <score.json>",
    "  npm run existing-conditions -- validate-architectural-door-span --delta-receipt <receipt.json> --candidate-receipt <receipt.json> --classification <validated-classification.json> --observation <agent-door-span.json> --out <validated-door-span.json>",
    "  npm run existing-conditions -- resolve-architectural-opening-hosts --candidate-receipt <receipt.json> --classification <validated-classification.json> --out <resolution.json>",
    "  npm run existing-conditions -- score-architectural-opening-hosts --truth <ground-truth.json> --candidate-receipt <receipt.json> --classification <validated-classification.json> --resolution <resolution.json> --out <score.json>",
    "  npm run existing-conditions -- compile-architectural-pixel-preview --input <pixel-observations.json> --measurement-receipt <measurement-receipt.json> --out <compiled-preview.json> [--source-out <converted-source-observations.json>] [--compilation-out <compilation.json>]",
    "  npm run existing-conditions -- audit-architectural-redaction --truth <ground-truth.json> --delta-receipt <receipt.json> --out <gate-receipt.json>",
    "  npm run existing-conditions -- audit-linked-background --model-health <model-health.json> --out <gate-receipt.json> [--link-name-tokens <token,token,...>]",
    "  npm run existing-conditions -- promote-architectural-preview --input <source-observations.json> --truth <evaluator-ground-truth.json> (--catalog <approved-precedents.json> --mapping-signals <hash-bound-signals.json> | --resolutions <evidence-backed-resolutions.json>) --out <promotion.json> [--score-out <recomputed-plan-score.json>] [--action-out <atomic-import-request.json>] [--apply]",
    "  npm run existing-conditions -- compile-architectural-shell --input <source-observations.json> --out <compiled-plan.json> [--action-out <atomic-import-request.json>] [--apply]",
    "  npm run existing-conditions -- capture (--expected-model <model.rvt> | --expected-document-title <exact-title> --allow-title-only-development) (--view-id <id> | --view-ids <id,id,...>) (--ids <id,id,...> | --scope <scope.json>) --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- package --fixture-id <id> --scope-id <id> --discipline <mechanical|plumbing|electrical|architectural|mixed> --task-class <exact_reconstruction|standards_compliance_repair|generative_layout> [--standards-profile <json>] [--source-pdf-render <image> --surrounding-model-capture <image> --architectural-delta-receipt <json> [--architectural-measurement-receipt <json> [--architectural-wall-candidate-receipt <json>]]] --redacted-model <agent-redacted.rvt> --source-pdf <source.pdf> --view-id <id> --model-bounds <minX,minY,minZ,maxX,maxY,maxZ> --image-region <minX,minY,maxX,maxY> --allowed-categories <OST_...,OST_...> --out-dir <agent-dir> [--registration-artifact <verified-registration.json> (required for exact reconstruction)]",
    "  npm run existing-conditions -- seal-truth --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --ground-truth-model <source.rvt> --deletion-manifest <json> --delete-dry-run <json> --out <truth.json>",
    "  npm run existing-conditions -- evaluator-review-visual --post-capture <image> --post-pdf <pdf> --status <pass|needs_review|fail> --out <receipt.json>",
    "  npm run existing-conditions -- seal-candidate --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --evaluator-visual-receipt <json> --out <candidate.json>",
    "  npm run existing-conditions -- score --package <agent_package.json> [--truth <truth.json> --candidate <candidate.json> --policy <json> | --evaluator-checks <json> --evaluator-change-receipt <json> --evaluator-access-provenance <json> --constructability <pass|fail> --drawing-legibility <pass|fail>] --out-dir <score-dir>",
    "  npm run existing-conditions -- seal-engineering-evidence --case <case-definition.json> --native-evidence <evaluator-native-evidence.json> --evaluator-key-file <secret> --out <provenance.json>",
    "  npm run existing-conditions -- collect-gfci-native-evidence --adapter-config <json> --room-contents <json> --parameter-readbacks <json> --out <evaluator-native-evidence.json>",
    "  npm run existing-conditions -- capture-gfci-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- collect-dwelling-wall-native-evidence --adapter-config <json> --planner-response <json> --room-contents <json> --out <evaluator-native-evidence.json>",
    "  npm run existing-conditions -- capture-dwelling-wall-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- collect-circuit-loading-native-evidence --adapter-config <json> --room-contents <json> --circuit-audit <json> --out <evaluator-native-evidence.json>",
    "  npm run existing-conditions -- capture-circuit-loading-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- collect-plumbing-fixture-services-native-evidence --adapter-config <json> --plumbing-audit <json> --out <evaluator-native-evidence.json>",
    "  npm run existing-conditions -- capture-plumbing-fixture-services-native-evidence --adapter-config <json> --expected-model <model.rvt> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- evaluate-engineering-case --case <case-definition.json> --native-evidence <evaluator-native-evidence.json> --evaluator-provenance <provenance.json> --evaluator-key-file <secret> --out <checks.json>",
    "  npm run existing-conditions -- advance-controller --state <controller-state-or-receipt.json> --event <event.json> --out <next-receipt.json>",
    "  npm run existing-conditions -- evaluator-diff --before-visible <json> --after-visible <json> --package <agent_package.json> --out <receipt.json>",
    "  npm run existing-conditions -- validate-contract --kind <agent_package|ground_truth|candidate|architectural_preview|architectural_pixel_measurement|registered_mep_observations|mep_region_coverage|registration_ambiguity|architectural_wall_candidate_clarification|architectural_opening_classification|architectural_door_span_observation|architectural_opening_host_resolution> --file <json>",
    "  npm run existing-conditions -- redact --expected-source <source.rvt> --staging-model <withheld-staging.rvt> --redacted-model <agent-redacted.rvt> --view-id <id> --ids <id,id,...> --anchor-ids <id,id,...> --out-dir <fixture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "Options:",
    "  --allow-missing-connectors  Permit non-MEP normalization without connector readback.",
    "  --categories <tokens>       Override the supported cross-discipline visible-element categories during capture.",
    "  --allow-dependent-deletes   Permit the delete dry-run to include IDs beyond --ids.",
    "  --require-evaluator-receipt Require evaluator-owned native before/after scope-diff evidence when scoring.",
    "  --evaluator-change-receipt <json>  Attach the evaluator-owned native scope-diff receipt when sealing a candidate.",
    "  --evaluator-visual-receipt <json>  Attach a separately generated evaluator visual-review receipt.",
    "  --notes <text|text>        Pipe-delimited evaluator notes for evaluator-review-visual.",
    "  --resume-staging            Resume from the already active --staging-model after a prior safety stop.",
    "  --resume-redacted           Finalize receipts from the already active --redacted-model after verifying every requested ID is absent.",
    "  --bridge-url <url>          Default: http://localhost:5000."
  ].join("\n"));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function responseIds(value: unknown): number[] {
  const obj = asObject(value);
  const values = Array.isArray(obj.ids)
    ? obj.ids
    : Array.isArray(obj.deletedIds)
      ? obj.deletedIds
      : Array.isArray(obj.impactedIds)
        ? obj.impactedIds
        : [];
  return [...new Set(values.map(Number).filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertVerifiedRegistrationArtifact(
  value: unknown,
  expectedSourceEvidenceSha256: string
): ExistingConditionsRegistrationReceipt {
  const receipt = asObject(value);
  const translation = asObject(receipt.translation_ft);
  const numeric = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
  const rmsError = receipt.rms_error_ft;
  const maximumError = receipt.maximum_error_ft;
  const maxRmsError = receipt.max_rms_error_ft;
  const maxPointError = receipt.max_point_error_ft;
  const controlPointCount = receipt.control_point_count;
  const thresholdedErrorsAreValid = numeric(rmsError)
    && numeric(maximumError)
    && numeric(maxRmsError)
    && numeric(maxPointError)
    && rmsError >= 0
    && maximumError >= 0
    && maxRmsError >= 0
    && maxPointError >= 0
    && rmsError <= maxRmsError
    && maximumError <= maxPointError;
  if (receipt.schema_version !== 1
    || receipt.verified !== true
    || typeof receipt.source_evidence_sha256 !== "string"
    || receipt.source_evidence_sha256.toLowerCase() !== expectedSourceEvidenceSha256.toLowerCase()
    || !numeric(controlPointCount)
    || !Number.isInteger(controlPointCount)
    || controlPointCount < 3
    || !numeric(receipt.scale)
    || receipt.scale <= 0
    || !numeric(receipt.rotation_degrees)
    || !numeric(translation.x)
    || !numeric(translation.y)
    || !thresholdedErrorsAreValid
    || (receipt.reflection_applied != null && typeof receipt.reflection_applied !== "boolean")) {
    throw new Error("registration_artifact_must_be_verified_source_to_model_registration");
  }
  return receipt as ExistingConditionsRegistrationReceipt;
}

const DEFAULT_EXISTING_CONDITIONS_CATEGORIES = [
  "OST_DuctCurves", "OST_DuctFitting", "OST_DuctAccessory", "OST_MechanicalEquipment", "OST_DuctTerminal",
  "OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory", "OST_PlumbingFixtures", "OST_Sprinklers",
  "OST_ElectricalFixtures", "OST_ElectricalEquipment", "OST_LightingFixtures", "OST_LightingDevices", "OST_FireAlarmDevices", "OST_DataDevices", "OST_CommunicationDevices"
];

type BridgeClient = {
  get(route: string): Promise<unknown>;
  post(route: string, body: unknown, write?: boolean): Promise<unknown>;
};

function bridgeClient(): BridgeClient {
  const baseUrl = (argument("--bridge-url") || "http://localhost:5000").replace(/\/+$/, "");
  const token = fs.readFileSync(path.resolve(requiredArgument("--token-file")), "utf8").trim();
  const grantObject = asObject(readJson(requiredArgument("--grant-file")));
  const grant = String(grantObject.token ?? "").trim();
  if (!token) throw new Error("operator_token_is_empty");
  if (!grant) throw new Error("write_grant_token_is_empty");
  const call = async (method: "GET" | "POST", route: string, body?: unknown, write = false): Promise<unknown> => {
    const headers: Record<string, string> = { "X-Operator-Token": token };
    if (write) headers["X-Operator-Write-Grant"] = grant;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
    if (!response.ok) throw new Error(`${route} returned ${response.status}: ${text.slice(0, 1000)}`);
    return parsed;
  };
  return {
    get: (route) => call("GET", route),
    post: (route, body, write = false) => call("POST", route, body, write)
  };
}

function activeDocumentPath(contextValue: unknown): string {
  const context = asObject(contextValue);
  return String(asObject(context.document).path ?? asObject(context.readiness).active_document_path ?? "").trim();
}

function activeDocumentTitle(contextValue: unknown): string {
  const context = asObject(contextValue);
  return String(asObject(context.document).title ?? asObject(context.readiness).active_document_name ?? "").trim();
}

function assertExpectedActiveDocument(context: unknown): {
  expected_model_path: string | null;
  expected_document_title: string | null;
  identity_assurance: "path_bound" | "path_and_title_bound" | "title_only_development";
  evaluator_truth_eligible: boolean;
} {
  const expectedModelValue = argument("--expected-model");
  const expectedTitle = argument("--expected-document-title");
  if (!expectedModelValue && !expectedTitle) throw new Error("--expected-model or --expected-document-title is required.");
  const expectedModel = expectedModelValue ? path.resolve(expectedModelValue) : null;
  if (!expectedModel && expectedTitle && !process.argv.includes("--allow-title-only-development")) {
    throw new Error("--expected-document-title without --expected-model is development-only and requires --allow-title-only-development.");
  }
  if (expectedModel && !fs.existsSync(expectedModel)) throw new Error(`Expected model does not exist: ${expectedModel}`);
  if (expectedModel && canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  if (expectedTitle && activeDocumentTitle(context) !== expectedTitle) {
    throw new Error(`Active document title '${activeDocumentTitle(context)}' does not match expected title '${expectedTitle}'.`);
  }
  return {
    expected_model_path: expectedModel,
    expected_document_title: expectedTitle || null,
    identity_assurance: expectedModel
      ? (expectedTitle ? "path_and_title_bound" : "path_bound")
      : "title_only_development",
    evaluator_truth_eligible: expectedModel !== null
  };
}

function selectedIdsFromArguments(viewIds: number[]): { ids: number[]; scope: ExistingConditionsImageScopeReceipt | null } {
  const scopePath = argument("--scope");
  if (scopePath && argument("--ids")) throw new Error("Use either --ids or --scope, not both.");
  if (!scopePath) return { ids: parseIds(requiredArgument("--ids")), scope: null };
  const scope = asObject(readJson(scopePath));
  if (scope.host_scope_required !== true) {
    throw new Error("--scope must be host-only for native connector capture; linked scopes are evaluator-only.");
  }
  const scopeViewId = Number(scope.view_id ?? scope.viewId);
  const scopeFrameId = String(scope.frame_id ?? scope.frameId ?? "").trim();
  if (!Number.isSafeInteger(scopeViewId) || !viewIds.includes(scopeViewId)) {
    throw new Error("--scope view_id must match one of the requested capture views.");
  }
  if (!scopeFrameId) throw new Error("--scope frame_id is required.");
  const ids = Array.isArray(scope.selected_element_ids)
    ? scope.selected_element_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  if (ids.length === 0) throw new Error("--scope must contain selected_element_ids with at least one positive integer.");
  return { ids: [...new Set(ids)], scope: scope as ExistingConditionsImageScopeReceipt };
}

async function exportCompleteVisibleInventory(
  client: BridgeClient,
  viewId: number,
  categories: string[],
  imageSize: number,
  includeLinked: boolean,
  modelBounds?: number[]
): Promise<unknown> {
  const exportBatch = async (batch: string[]): Promise<unknown[]> => {
    const payload = await client.post("/revit/export-visible-elements", {
      viewId,
      imageSize,
      includeMapping: true,
      includeGeometry: true,
      includeLinked,
      ...(modelBounds ? { modelBounds } : {}),
      limit: 2000,
      categories: batch
    });
    const root = asObject(payload);
    if (root.truncated !== true) return [payload];
    if (batch.length === 1) {
      throw new Error(`Visible-element category '${batch[0]}' exceeds the native 2,000-element limit; narrow the view or category before using it as evaluator truth.`);
    }
    const middle = Math.ceil(batch.length / 2);
    return [
      ...await exportBatch(batch.slice(0, middle)),
      ...await exportBatch(batch.slice(middle))
    ];
  };

  const payloads = await exportBatch(categories);
  if (payloads.length === 1) return payloads[0];
  return mergeExistingConditionsSameViewVisibleElementPayloads(payloads, viewId, includeLinked);
}

async function captureVisibleInventory(): Promise<void> {
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewId = Number(requiredArgument("--view-id"));
  if (!Number.isSafeInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty inventory directory: ${outDir}`);
  }
  const categories = argument("--categories")
    ? parseCsv(argument("--categories"), "--categories")
    : DEFAULT_EXISTING_CONDITIONS_CATEGORIES;
  const modelBounds = argument("--model-bounds")
    ? parseNumbers(argument("--model-bounds"), 6, "--model-bounds")
    : undefined;
  if (modelBounds && (modelBounds[0]! >= modelBounds[3]! || modelBounds[1]! >= modelBounds[4]! || modelBounds[2]! >= modelBounds[5]!)) {
    throw new Error("--model-bounds minimum coordinates must be strictly below maximum coordinates.");
  }
  const imageSize = Number(argument("--image-size") || "3000");
  if (!Number.isSafeInteger(imageSize) || imageSize < 512 || imageSize > 6000) {
    throw new Error("--image-size must be an integer from 512 through 6000.");
  }
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  const expected = assertExpectedActiveDocument(context);
  const visible = await exportCompleteVisibleInventory(
    client,
    viewId,
    categories,
    imageSize,
    process.argv.includes("--include-linked"),
    modelBounds
  );
  const visibleObject = asObject(visible);
  if (visibleObject.truncated === true) throw new Error("Visible-element inventory is truncated; narrow --categories before using it as evaluator truth.");
  fs.mkdirSync(outDir, { recursive: true });
  const sourceCapturePath = String(visibleObject.path ?? "").trim();
  let durableCapture: { path: string; sha256: string } | null = null;
  if (sourceCapturePath && fs.existsSync(sourceCapturePath)) {
    const extension = path.extname(sourceCapturePath) || ".jpg";
    const destination = path.join(outDir, `visible_inventory${extension}`);
    fs.copyFileSync(sourceCapturePath, destination, fs.constants.COPYFILE_EXCL);
    durableCapture = { path: destination, sha256: sha256(destination) };
  }
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "visible_elements.json"), visible);
  writeJson(path.join(outDir, "inventory_receipt.json"), {
    schema_version: 1,
    view_id: viewId,
    expected_model_path: expected.expected_model_path,
    expected_model_sha256: expected.expected_model_path ? sha256(expected.expected_model_path) : null,
    expected_document_title: expected.expected_document_title,
    identity_assurance: expected.identity_assurance,
    evaluator_truth_eligible: expected.evaluator_truth_eligible,
    active_document_title: activeDocumentTitle(context),
    active_document_path: activeDocumentPath(context),
    include_linked: process.argv.includes("--include-linked"),
    model_bounds_ft: modelBounds ?? null,
    categories,
    count: Number(visibleObject.count ?? 0),
    scanned: Number(visibleObject.scanned ?? 0),
    truncated: visibleObject.truncated === true,
    durable_capture: durableCapture
  });
}

function buildImageScopeReceipt(): void {
  const visible = readJson(requiredArgument("--visible"));
  const [minX, minY, maxX, maxY] = parseNumbers(requiredArgument("--image-region"), 4, "--image-region");
  const padding = Number(argument("--padding-px") || "0");
  const receipt = selectExistingConditionsImageScope(visible, {
    min_x_px: minX!, min_y_px: minY!, max_x_px: maxX!, max_y_px: maxY!
  }, {
    padding_px: padding,
    include_linked: process.argv.includes("--include-linked-scope"),
    level_names: argument("--level-names") ? parseCsv(argument("--level-names"), "--level-names") : undefined
  });
  if (receipt.selected_count === 0) throw new Error("Registered image region did not select any visible elements.");
  writeJson(requiredArgument("--out"), receipt);
}

async function captureNativeSnapshot(): Promise<void> {
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewIds = argument("--view-ids")
    ? parseIds(argument("--view-ids"))
    : [Number(requiredArgument("--view-id"))];
  const selection = selectedIdsFromArguments(viewIds);
  const ids = selection.ids;
  if (viewIds.some((viewId) => !Number.isInteger(viewId) || viewId <= 0)) {
    throw new Error("--view-id/--view-ids must contain positive integers.");
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty capture directory: ${outDir}`);
  }
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  const expected = assertExpectedActiveDocument(context);
  const categories = argument("--categories")
    ? parseCsv(argument("--categories"), "--categories")
    : DEFAULT_EXISTING_CONDITIONS_CATEGORIES;
  const visibleByView: unknown[] = [];
  for (const viewId of viewIds) {
    visibleByView.push(await exportCompleteVisibleInventory(client, viewId, categories, 3000, false));
  }
  if (selection.scope) {
    const scopeViewIndex = viewIds.indexOf(selection.scope.view_id);
    validateExistingConditionsImageScopeAgainstVisibleInventory(selection.scope, visibleByView[scopeViewIndex]);
  }
  const visible = visibleByView.length === 1
    ? visibleByView[0]
    : mergeExistingConditionsVisibleElementPayloads(visibleByView, viewIds);
  const connectors = await client.post("/revit/get-connectors", {
    elementIds: ids,
    includeAllRefs: true,
    includeCoordinateSystem: true
  });
  const snapshot = normalizeExistingConditionsSnapshot(visible, connectors, {
    selected_element_ids: ids,
    require_connector_readback: !process.argv.includes("--allow-missing-connectors")
  });
  if (!snapshot.native_readback) {
    const capturedIds = new Set(snapshot.elements.map((entry) => Number(String(entry.key).replace(/^host:/, ""))).filter(Number.isInteger));
    const missingIds = ids.filter((id) => !capturedIds.has(id));
    throw new Error(`Native capture is incomplete for the requested scope. Missing visible/native rows: ${missingIds.join(",") || "connector_readback"}. Supply all required discipline views with --view-ids.`);
  }
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "visible_elements.json"), visible);
  if (visibleByView.length > 1) {
    for (let index = 0; index < visibleByView.length; index += 1) {
      writeJson(path.join(outDir, `visible_elements_view_${viewIds[index]}.json`), visibleByView[index]);
    }
  }
  writeJson(path.join(outDir, "connectors.json"), connectors);
  writeJson(path.join(outDir, "snapshot.json"), snapshot);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    model_path: expected.expected_model_path ?? activeDocumentPath(context),
    model_sha256: expected.expected_model_path ? sha256(expected.expected_model_path) : null,
    expected_document_title: expected.expected_document_title,
    active_document_title: activeDocumentTitle(context),
    identity_assurance: expected.identity_assurance,
    evaluator_truth_eligible: expected.evaluator_truth_eligible,
    view_id: viewIds[0],
    view_ids: viewIds,
    selected_element_count: ids.length,
    native_readback: snapshot.native_readback
  });
}

function buildAgentPackage(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const redactedModel = path.resolve(requiredArgument("--redacted-model"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewId = Number(requiredArgument("--view-id"));
  const discipline = optionalDiscipline();
  if (!discipline) throw new Error("--discipline is required.");
  const allowedCategories = parseCsv(requiredArgument("--allowed-categories"), "--allowed-categories");
  const modelBounds = parseNumbers(requiredArgument("--model-bounds"), 6, "--model-bounds");
  const imageRegion = parseNumbers(requiredArgument("--image-region"), 4, "--image-region");
  if (imageRegion.some((value) => value < 0 || value > 1) || imageRegion[0]! >= imageRegion[2]! || imageRegion[1]! >= imageRegion[3]!) {
    throw new Error("--image-region must be normalized 0..1 with min values below max values.");
  }
  if (modelBounds[0]! >= modelBounds[3]! || modelBounds[1]! >= modelBounds[4]! || modelBounds[2]! > modelBounds[5]!) {
    throw new Error("--model-bounds minimum values must be below maximum values.");
  }
  const maximumCreatedElements = Number(argument("--max-created") || "50");
  if (!Number.isInteger(maximumCreatedElements) || maximumCreatedElements < 1 || maximumCreatedElements > 500) {
    throw new Error("--max-created must be an integer from 1 through 500.");
  }
  const maxRepairs = Number(argument("--max-repairs") || "2");
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) throw new Error("--max-repairs must be an integer from 0 through 10.");
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (!fs.existsSync(redactedModel)) throw new Error(`Redacted model does not exist: ${redactedModel}`);
  if (!fs.existsSync(sourcePdf)) throw new Error(`Source PDF does not exist: ${sourcePdf}`);
  const taskClass = argument("--task-class") || "exact_reconstruction";
  if (!["exact_reconstruction", "standards_compliance_repair", "generative_layout"].includes(taskClass)) {
    throw new Error("--task-class must be exact_reconstruction, standards_compliance_repair, or generative_layout.");
  }
  const standardsProfileSource = argument("--standards-profile");
  const registrationArtifactSource = argument("--registration-artifact");
  const typeMappingArtifactSource = argument("--type-mapping-artifact");
  const architecturalDeltaReceiptSource = argument("--architectural-delta-receipt");
  const architecturalMeasurementReceiptSource = argument("--architectural-measurement-receipt");
  const architecturalWallCandidateReceiptSource = argument("--architectural-wall-candidate-receipt");
  const sourcePdfRenderSource = argument("--source-pdf-render");
  const surroundingModelCaptureSource = argument("--surrounding-model-capture");
  if (taskClass !== "exact_reconstruction" && (!standardsProfileSource || !fs.existsSync(path.resolve(standardsProfileSource)))) {
    throw new Error("--standards-profile must identify an existing JSON file for compliance and generative tasks.");
  }
  for (const [flag, source] of [["--source-pdf-render", sourcePdfRenderSource], ["--surrounding-model-capture", surroundingModelCaptureSource]] as const) {
    if (source && (!fs.existsSync(path.resolve(source)) || !fs.statSync(path.resolve(source)).isFile())) {
      throw new Error(`${flag} must identify an existing image file.`);
    }
  }
  if (taskClass === "exact_reconstruction" && !registrationArtifactSource) {
    throw new Error("exact_reconstruction_requires_verified_source_to_model_registration");
  }
  let registrationArtifact: ExistingConditionsRegistrationReceipt | null = null;
  if (registrationArtifactSource) {
    const resolved = path.resolve(registrationArtifactSource);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("--registration-artifact must identify an existing JSON file.");
    }
    let rawRegistration: unknown;
    try {
      rawRegistration = readJson(resolved);
    } catch {
      throw new Error("--registration-artifact must identify valid JSON.");
    }
    const registeredSource = sourcePdfRenderSource ? path.resolve(sourcePdfRenderSource) : sourcePdf;
    registrationArtifact = assertVerifiedRegistrationArtifact(rawRegistration, sha256(registeredSource));
  }
  for (const [flag, source] of [["--type-mapping-artifact", typeMappingArtifactSource]] as const) {
    if (!source) continue;
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${flag} must identify an existing JSON file.`);
    try {
      JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch {
      throw new Error(`${flag} must identify valid JSON.`);
    }
  }
  let architecturalDeltaReceipt: ArchitecturalSourceDeltaReceipt | null = null;
  if (architecturalDeltaReceiptSource) {
    if (!sourcePdfRenderSource || !surroundingModelCaptureSource) {
      throw new Error("--architectural-delta-receipt requires --source-pdf-render and --surrounding-model-capture.");
    }
    const resolved = path.resolve(architecturalDeltaReceiptSource);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("--architectural-delta-receipt must identify an existing JSON file.");
    }
    architecturalDeltaReceipt = readJson(resolved) as ArchitecturalSourceDeltaReceipt;
    if (architecturalDeltaReceipt.schema_version !== 1
      || architecturalDeltaReceipt.artifact_role !== "architectural_source_redacted_delta"
      || architecturalDeltaReceipt.fixture_id !== fixtureId
      || architecturalDeltaReceipt.scope_id !== scopeId
      || !architecturalDeltaReceipt.registration_verified
      || !architecturalDeltaReceipt.artifacts
      || typeof architecturalDeltaReceipt.artifacts !== "object"
      || !/^[a-f0-9]{64}$/i.test(String(architecturalDeltaReceipt.source_render_sha256 ?? ""))
      || !/^[a-f0-9]{64}$/i.test(String(architecturalDeltaReceipt.redacted_model_capture_sha256 ?? ""))) {
      throw new Error("--architectural-delta-receipt does not match the package fixture/scope or verified V1 contract.");
    }
    for (const requiredArtifact of ["source_aligned", "redacted_aligned", "candidate_delta_mask", "comparison"] as const) {
      if (!architecturalDeltaReceipt.artifacts[requiredArtifact]) {
        throw new Error(`architectural_delta_${requiredArtifact}_is_required`);
      }
    }
    for (const [name, artifact] of Object.entries(architecturalDeltaReceipt.artifacts)) {
      const artifactPath = path.resolve(artifact.path);
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`architectural_delta_${name}_file_not_found`);
      }
      if (sha256(artifactPath).toLowerCase() !== String(artifact.sha256).toLowerCase()) {
        throw new Error(`architectural_delta_${name}_sha256_mismatch`);
      }
    }
    if (sha256(path.resolve(sourcePdfRenderSource)).toLowerCase() !== architecturalDeltaReceipt.source_render_sha256.toLowerCase()) {
      throw new Error("architectural_delta_source_render_sha256_mismatch");
    }
    if (sha256(path.resolve(surroundingModelCaptureSource)).toLowerCase() !== architecturalDeltaReceipt.redacted_model_capture_sha256.toLowerCase()) {
      throw new Error("architectural_delta_surrounding_model_capture_sha256_mismatch");
    }
  }
  let architecturalMeasurementReceipt: ArchitecturalMeasurementOverlayReceipt | null = null;
  if (architecturalMeasurementReceiptSource) {
    if (!architecturalDeltaReceipt || !architecturalDeltaReceiptSource) {
      throw new Error("--architectural-measurement-receipt requires --architectural-delta-receipt.");
    }
    const resolved = path.resolve(architecturalMeasurementReceiptSource);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("--architectural-measurement-receipt must identify an existing JSON file.");
    }
    architecturalMeasurementReceipt = readJson(resolved) as ArchitecturalMeasurementOverlayReceipt;
    if (architecturalMeasurementReceipt.schema_version !== 1
      || architecturalMeasurementReceipt.artifact_role !== "architectural_registered_measurement_overlay"
      || architecturalMeasurementReceipt.fixture_id !== fixtureId
      || architecturalMeasurementReceipt.scope_id !== scopeId
      || architecturalMeasurementReceipt.architectural_delta_receipt_sha256 !== sha256(path.resolve(architecturalDeltaReceiptSource)).toLowerCase()
      || architecturalMeasurementReceipt.registration_source_evidence_sha256 !== architecturalDeltaReceipt.registration_source_evidence_sha256
      || architecturalMeasurementReceipt.source_aligned_sha256 !== architecturalDeltaReceipt.artifacts.source_aligned.sha256
      || architecturalMeasurementReceipt.candidate_delta_mask_sha256 !== architecturalDeltaReceipt.artifacts.candidate_delta_mask.sha256) {
      throw new Error("--architectural-measurement-receipt does not match the delta receipt fixture, scope, registration, or image hashes.");
    }
    const overlayPath = path.resolve(architecturalMeasurementReceipt.overlay.path);
    if (!fs.existsSync(overlayPath) || !fs.statSync(overlayPath).isFile()) {
      throw new Error("architectural_measurement_overlay_file_not_found");
    }
    if (sha256(overlayPath).toLowerCase() !== architecturalMeasurementReceipt.overlay.sha256.toLowerCase()) {
      throw new Error("architectural_measurement_overlay_sha256_mismatch");
    }
    if (architecturalMeasurementReceipt.overlay.width_px !== architecturalDeltaReceipt.output_frame.width_px
      || architecturalMeasurementReceipt.overlay.height_px !== architecturalDeltaReceipt.output_frame.height_px) {
      throw new Error("architectural_measurement_overlay_dimensions_mismatch");
    }
  }
  let architecturalWallCandidateReceipt: ArchitecturalWallLineCandidateReceipt | null = null;
  if (architecturalWallCandidateReceiptSource) {
    if (!architecturalDeltaReceipt || !architecturalDeltaReceiptSource
      || !architecturalMeasurementReceipt || !architecturalMeasurementReceiptSource) {
      throw new Error("--architectural-wall-candidate-receipt requires both architectural delta and measurement receipts.");
    }
    const resolved = path.resolve(architecturalWallCandidateReceiptSource);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("--architectural-wall-candidate-receipt must identify an existing JSON file.");
    }
    architecturalWallCandidateReceipt = readJson(resolved) as ArchitecturalWallLineCandidateReceipt;
    if (architecturalWallCandidateReceipt.schema_version !== 1
      || architecturalWallCandidateReceipt.artifact_role !== "architectural_wall_line_candidates"
      || architecturalWallCandidateReceipt.fixture_id !== fixtureId
      || architecturalWallCandidateReceipt.scope_id !== scopeId
      || architecturalWallCandidateReceipt.architectural_delta_receipt_sha256 !== sha256(path.resolve(architecturalDeltaReceiptSource)).toLowerCase()
      || architecturalWallCandidateReceipt.measurement_receipt_sha256 !== sha256(path.resolve(architecturalMeasurementReceiptSource)).toLowerCase()
      || architecturalWallCandidateReceipt.source_aligned_sha256 !== architecturalDeltaReceipt.artifacts.source_aligned.sha256
      || architecturalWallCandidateReceipt.candidate_delta_mask_sha256 !== architecturalDeltaReceipt.artifacts.candidate_delta_mask.sha256
      || !Array.isArray(architecturalWallCandidateReceipt.candidates)
      || architecturalWallCandidateReceipt.candidates.length === 0) {
      throw new Error("--architectural-wall-candidate-receipt does not match the fixture, upstream receipts, images, or candidate contract.");
    }
    const overlayPath = path.resolve(architecturalWallCandidateReceipt.overlay.path);
    if (!fs.existsSync(overlayPath) || !fs.statSync(overlayPath).isFile()) {
      throw new Error("architectural_wall_candidate_overlay_file_not_found");
    }
    if (sha256(overlayPath).toLowerCase() !== architecturalWallCandidateReceipt.overlay.sha256.toLowerCase()) {
      throw new Error("architectural_wall_candidate_overlay_sha256_mismatch");
    }
    if (architecturalWallCandidateReceipt.overlay.width_px !== architecturalDeltaReceipt.output_frame.width_px
      || architecturalWallCandidateReceipt.overlay.height_px !== architecturalDeltaReceipt.output_frame.height_px) {
      throw new Error("architectural_wall_candidate_overlay_dimensions_mismatch");
    }
    const openingHypotheses = Array.isArray(architecturalWallCandidateReceipt.opening_gap_hypotheses)
      ? architecturalWallCandidateReceipt.opening_gap_hypotheses
      : [];
    const openingCrops = Array.isArray(architecturalWallCandidateReceipt.opening_evidence_crops)
      ? architecturalWallCandidateReceipt.opening_evidence_crops
      : [];
    if (openingCrops.length !== openingHypotheses.length) {
      throw new Error("architectural_opening_evidence_crop_count_mismatch");
    }
    for (const crop of openingCrops) {
      const opening = openingHypotheses.find(
        (entry) => entry.opening_hypothesis_id === crop.opening_hypothesis_id
          && entry.host_candidate_id === crop.host_candidate_id
      );
      if (!opening) throw new Error("architectural_opening_evidence_crop_hypothesis_mismatch");
      for (const [label, artifact] of [["source", crop.source_crop], ["overlay", crop.evidence_overlay]] as const) {
        const artifactPath = path.resolve(artifact.path);
        if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
          throw new Error(`architectural_opening_${label}_crop_file_not_found`);
        }
        if (sha256(artifactPath).toLowerCase() !== artifact.sha256.toLowerCase()) {
          throw new Error(`architectural_opening_${label}_crop_sha256_mismatch`);
        }
      }
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const pdfCopy = path.join(outDir, "source_evidence.pdf");
  const packagePath = path.join(outDir, "agent_package.json");
  const controllerStatePath = path.join(outDir, "controller_state.json");
  const standardsProfileCopy = path.join(outDir, "standards_profile.json");
  const registrationArtifactCopy = path.join(outDir, "source_to_model_registration.json");
  const typeMappingArtifactCopy = path.join(outDir, "approved_type_catalog.json");
  const architecturalDeltaDirectory = path.join(outDir, "architectural_source_delta");
  const architecturalDeltaReceiptCopy = path.join(architecturalDeltaDirectory, "receipt.json");
  const architecturalMeasurementDirectory = path.join(outDir, "architectural_measurement");
  const architecturalMeasurementReceiptCopy = path.join(architecturalMeasurementDirectory, "receipt.json");
  const architecturalWallCandidateDirectory = path.join(outDir, "architectural_wall_candidates");
  const architecturalWallCandidateReceiptCopy = path.join(architecturalWallCandidateDirectory, "receipt.json");
  const sourcePdfRenderCopy = sourcePdfRenderSource
    ? path.join(outDir, `source_evidence_page_${Number(argument("--pdf-page") || "1")}${path.extname(sourcePdfRenderSource) || ".png"}`)
    : null;
  const surroundingModelCaptureCopy = surroundingModelCaptureSource
    ? path.join(outDir, `surrounding_model_capture${path.extname(surroundingModelCaptureSource) || ".png"}`)
    : null;
  if (fs.existsSync(pdfCopy) || fs.existsSync(packagePath) || fs.existsSync(controllerStatePath)
    || (taskClass !== "exact_reconstruction" && fs.existsSync(standardsProfileCopy))
    || (registrationArtifactSource && fs.existsSync(registrationArtifactCopy))
    || (typeMappingArtifactSource && fs.existsSync(typeMappingArtifactCopy))
    || (architecturalDeltaReceipt && fs.existsSync(architecturalDeltaDirectory))
    || (architecturalMeasurementReceipt && fs.existsSync(architecturalMeasurementDirectory))
    || (architecturalWallCandidateReceipt && fs.existsSync(architecturalWallCandidateDirectory))
    || (sourcePdfRenderCopy && fs.existsSync(sourcePdfRenderCopy))
    || (surroundingModelCaptureCopy && fs.existsSync(surroundingModelCaptureCopy))) {
    throw new Error(`Refusing to overwrite an existing agent package in: ${outDir}`);
  }
  fs.copyFileSync(sourcePdf, pdfCopy, fs.constants.COPYFILE_EXCL);
  if (taskClass !== "exact_reconstruction") {
    fs.copyFileSync(path.resolve(standardsProfileSource), standardsProfileCopy, fs.constants.COPYFILE_EXCL);
  }
  if (registrationArtifactSource) {
    fs.copyFileSync(path.resolve(registrationArtifactSource), registrationArtifactCopy, fs.constants.COPYFILE_EXCL);
  }
  if (typeMappingArtifactSource) {
    fs.copyFileSync(path.resolve(typeMappingArtifactSource), typeMappingArtifactCopy, fs.constants.COPYFILE_EXCL);
  }
  if (sourcePdfRenderCopy) {
    fs.copyFileSync(path.resolve(sourcePdfRenderSource), sourcePdfRenderCopy, fs.constants.COPYFILE_EXCL);
  }
  if (surroundingModelCaptureCopy) {
    fs.copyFileSync(path.resolve(surroundingModelCaptureSource), surroundingModelCaptureCopy, fs.constants.COPYFILE_EXCL);
  }
  let packagedArchitecturalDelta: ArchitecturalSourceDeltaReceipt | null = null;
  if (architecturalDeltaReceipt) {
    fs.mkdirSync(architecturalDeltaDirectory);
    const copiedArtifacts = Object.fromEntries(Object.entries(architecturalDeltaReceipt.artifacts).map(([name, artifact]) => {
      const destination = path.join(architecturalDeltaDirectory, `${name}.png`);
      fs.copyFileSync(path.resolve(artifact.path), destination, fs.constants.COPYFILE_EXCL);
      return [name, { ...artifact, path: destination, sha256: sha256(destination) }];
    })) as ArchitecturalSourceDeltaReceipt["artifacts"];
    packagedArchitecturalDelta = { ...architecturalDeltaReceipt, artifacts: copiedArtifacts };
    writeJson(architecturalDeltaReceiptCopy, packagedArchitecturalDelta);
  }
  let packagedArchitecturalMeasurement: ArchitecturalMeasurementOverlayReceipt | null = null;
  if (architecturalMeasurementReceipt) {
    if (!packagedArchitecturalDelta) throw new Error("packaged_architectural_delta_is_required_for_measurement");
    fs.mkdirSync(architecturalMeasurementDirectory);
    const overlayCopy = path.join(architecturalMeasurementDirectory, "registered_measurement_overlay.png");
    fs.copyFileSync(path.resolve(architecturalMeasurementReceipt.overlay.path), overlayCopy, fs.constants.COPYFILE_EXCL);
    packagedArchitecturalMeasurement = {
      ...architecturalMeasurementReceipt,
      architectural_delta_receipt_sha256: sha256(architecturalDeltaReceiptCopy),
      source_aligned_sha256: packagedArchitecturalDelta.artifacts.source_aligned.sha256,
      candidate_delta_mask_sha256: packagedArchitecturalDelta.artifacts.candidate_delta_mask.sha256,
      overlay: {
        ...architecturalMeasurementReceipt.overlay,
        path: overlayCopy,
        sha256: sha256(overlayCopy)
      }
    };
    writeJson(architecturalMeasurementReceiptCopy, packagedArchitecturalMeasurement);
  }
  let packagedArchitecturalWallCandidates: ArchitecturalWallLineCandidateReceipt | null = null;
  if (architecturalWallCandidateReceipt) {
    if (!packagedArchitecturalDelta || !packagedArchitecturalMeasurement) {
      throw new Error("packaged_architectural_delta_and_measurement_are_required_for_wall_candidates");
    }
    fs.mkdirSync(architecturalWallCandidateDirectory);
    const overlayCopy = path.join(architecturalWallCandidateDirectory, "wall_line_candidates.png");
    fs.copyFileSync(path.resolve(architecturalWallCandidateReceipt.overlay.path), overlayCopy, fs.constants.COPYFILE_EXCL);
    const openingEvidenceDirectory = path.join(architecturalWallCandidateDirectory, "opening_evidence");
    const sourceOpeningCrops = Array.isArray(architecturalWallCandidateReceipt.opening_evidence_crops)
      ? architecturalWallCandidateReceipt.opening_evidence_crops
      : [];
    if (sourceOpeningCrops.length > 0) fs.mkdirSync(openingEvidenceDirectory);
    const packagedOpeningCrops = sourceOpeningCrops.map((crop) => {
      const sourceCopy = path.join(openingEvidenceDirectory, `${crop.opening_hypothesis_id}-source.png`);
      const overlayArtifactCopy = path.join(openingEvidenceDirectory, `${crop.opening_hypothesis_id}-overlay.png`);
      fs.copyFileSync(path.resolve(crop.source_crop.path), sourceCopy, fs.constants.COPYFILE_EXCL);
      fs.copyFileSync(path.resolve(crop.evidence_overlay.path), overlayArtifactCopy, fs.constants.COPYFILE_EXCL);
      return {
        ...crop,
        source_crop: { ...crop.source_crop, path: sourceCopy, sha256: sha256(sourceCopy) },
        evidence_overlay: { ...crop.evidence_overlay, path: overlayArtifactCopy, sha256: sha256(overlayArtifactCopy) }
      };
    });
    packagedArchitecturalWallCandidates = {
      ...architecturalWallCandidateReceipt,
      architectural_delta_receipt_sha256: sha256(architecturalDeltaReceiptCopy),
      measurement_receipt_sha256: sha256(architecturalMeasurementReceiptCopy),
      source_aligned_sha256: packagedArchitecturalDelta.artifacts.source_aligned.sha256,
      candidate_delta_mask_sha256: packagedArchitecturalDelta.artifacts.candidate_delta_mask.sha256,
      overlay: {
        ...architecturalWallCandidateReceipt.overlay,
        path: overlayCopy,
        sha256: sha256(overlayCopy)
      },
      opening_evidence_crops: packagedOpeningCrops
    };
    writeJson(architecturalWallCandidateReceiptCopy, packagedArchitecturalWallCandidates);
  }
  const allowsMultipleValidSolutions = taskClass !== "exact_reconstruction";
  const agentPackage = {
    schema_version: 1,
    fixture_id: fixtureId,
    discipline,
    task_class: taskClass,
    task: argument("--task") || "Reconstruct the missing existing-condition work from the plotted PDF evidence in the currently open redacted model.",
    standards_profile: taskClass === "exact_reconstruction" ? null : {
      role: "standards_profile",
      path: standardsProfileCopy,
      sha256: sha256(standardsProfileCopy)
    },
    acceptance_contract: {
      acceptance_basis: taskClass === "exact_reconstruction"
        ? ["hidden_truth_geometry", "system_topology", "drawing_legibility", "scope_safety"]
        : ["engineering_invariants", "system_topology", "constructability", "drawing_legibility", "scope_safety"],
      allows_multiple_valid_solutions: allowsMultipleValidSolutions,
      requires_exact_element_ids: false,
      requires_exact_coordinates: !allowsMultipleValidSolutions
    },
    working_model: {
      role: "redacted_model",
      path: redactedModel,
      sha256: sha256(redactedModel)
    },
    registration_artifact: registrationArtifact ? {
      role: "source_to_model_registration",
      path: registrationArtifactCopy,
      sha256: sha256(registrationArtifactCopy)
    } : null,
    type_mapping_artifact: typeMappingArtifactSource ? {
      role: "approved_type_catalog",
      path: typeMappingArtifactCopy,
      sha256: sha256(typeMappingArtifactCopy)
    } : null,
    derived_evidence: packagedArchitecturalDelta ? [
      { role: "architectural_source_redacted_delta", path: architecturalDeltaReceiptCopy, sha256: sha256(architecturalDeltaReceiptCopy) },
      { role: "architectural_source_aligned", path: packagedArchitecturalDelta.artifacts.source_aligned.path, sha256: packagedArchitecturalDelta.artifacts.source_aligned.sha256 },
      { role: "architectural_redacted_aligned", path: packagedArchitecturalDelta.artifacts.redacted_aligned.path, sha256: packagedArchitecturalDelta.artifacts.redacted_aligned.sha256 },
      { role: "architectural_candidate_delta_mask", path: packagedArchitecturalDelta.artifacts.candidate_delta_mask.path, sha256: packagedArchitecturalDelta.artifacts.candidate_delta_mask.sha256 },
      { role: "architectural_source_redacted_comparison", path: packagedArchitecturalDelta.artifacts.comparison.path, sha256: packagedArchitecturalDelta.artifacts.comparison.sha256 },
      ...(packagedArchitecturalMeasurement ? [
        { role: "architectural_registered_measurement", path: architecturalMeasurementReceiptCopy, sha256: sha256(architecturalMeasurementReceiptCopy) },
        { role: "architectural_registered_measurement_overlay", path: packagedArchitecturalMeasurement.overlay.path, sha256: packagedArchitecturalMeasurement.overlay.sha256 }
      ] : []),
      ...(packagedArchitecturalWallCandidates ? [
        { role: "architectural_wall_line_candidates", path: architecturalWallCandidateReceiptCopy, sha256: sha256(architecturalWallCandidateReceiptCopy) },
        { role: "architectural_wall_line_candidate_overlay", path: packagedArchitecturalWallCandidates.overlay.path, sha256: packagedArchitecturalWallCandidates.overlay.sha256 },
        ...packagedArchitecturalWallCandidates.opening_evidence_crops.flatMap((crop) => [
          { role: "architectural_opening_source_crop", path: crop.source_crop.path, sha256: crop.source_crop.sha256 },
          { role: "architectural_opening_evidence_overlay", path: crop.evidence_overlay.path, sha256: crop.evidence_overlay.sha256 }
        ])
      ] : [])
    ] : undefined,
    evidence: [
      {
        role: "source_pdf",
        path: pdfCopy,
        sha256: sha256(pdfCopy),
        page: Number(argument("--pdf-page") || "1")
      },
      ...(sourcePdfRenderCopy ? [{
        role: "source_pdf_render",
        path: sourcePdfRenderCopy,
        sha256: sha256(sourcePdfRenderCopy),
        page: Number(argument("--pdf-page") || "1")
      }] : []),
      ...(surroundingModelCaptureCopy ? [{
        role: "surrounding_model_capture",
        path: surroundingModelCaptureCopy,
        sha256: sha256(surroundingModelCaptureCopy)
      }] : [])
    ],
    scope: {
      scope_id: scopeId,
      view_id: viewId,
      sheet_number: argument("--sheet-number") || null,
      model_bounds_ft: {
        min: { x: modelBounds[0], y: modelBounds[1], z: modelBounds[2] },
        max: { x: modelBounds[3], y: modelBounds[4], z: modelBounds[5] }
      },
      image_region_normalized: {
        min_x: imageRegion[0], min_y: imageRegion[1], max_x: imageRegion[2], max_y: imageRegion[3]
      }
    },
    allowed_categories: allowedCategories,
    write_policy: {
      dry_run_required: true,
      bounded_scope_required: true,
      out_of_scope_changes_allowed: false,
      maximum_created_elements: maximumCreatedElements,
      max_repairs: maxRepairs,
      material_confidence_threshold: 0.75,
      forbidden_artifact_roles: [
        "ground_truth_model",
        "ground_truth_snapshot",
        "deletion_manifest",
        "withheld_evaluator_package",
        "evaluator_native_evidence",
        "evaluator_provenance",
        "evaluator_signing_key",
        "evaluator_native_adapter_config"
      ],
      require_native_readback: true,
      require_source_observation_grounding: taskClass === "exact_reconstruction",
      require_post_change_visual_receipt: true,
      require_evaluator_change_receipt: true,
      require_evaluator_access_provenance: true
    },
    output_contract: {
      candidate_snapshot_path: path.join(outDir, "candidate_snapshot.json"),
      post_change_capture_path: path.join(outDir, "post_change_capture.png"),
      post_change_pdf_path: path.join(outDir, "post_change.pdf"),
      run_receipt_path: path.join(outDir, "reconstruction_run_receipt.json"),
      controller_state_path: controllerStatePath,
      evaluator_access_provenance_path: path.join(outDir, "evaluator_access_provenance.json")
    }
  };
  assertExistingConditionsContract("agent_package", agentPackage);
  writeJson(packagePath, agentPackage);
  const controllerState = createExistingConditionsControllerState({
    fixture_id: fixtureId,
    scope_id: scopeId,
    discipline,
    allowed_categories: allowedCategories,
    maximum_created_elements: maximumCreatedElements,
    visible_evidence: [
      { role: "source_pdf", sha256: sha256(pdfCopy) },
      ...(sourcePdfRenderCopy ? [{ role: "source_pdf_render", sha256: sha256(sourcePdfRenderCopy) }] : []),
      ...(surroundingModelCaptureCopy ? [{ role: "surrounding_model_capture", sha256: sha256(surroundingModelCaptureCopy) }] : []),
      ...(registrationArtifact ? [{ role: "source_to_model_registration", sha256: sha256(registrationArtifactCopy) }] : []),
      ...(typeMappingArtifactSource ? [{ role: "approved_type_catalog", sha256: sha256(typeMappingArtifactCopy) }] : []),
      ...(packagedArchitecturalDelta ? [
        { role: "architectural_source_redacted_delta", sha256: sha256(architecturalDeltaReceiptCopy) },
        { role: "architectural_source_aligned", sha256: packagedArchitecturalDelta.artifacts.source_aligned.sha256 },
        { role: "architectural_redacted_aligned", sha256: packagedArchitecturalDelta.artifacts.redacted_aligned.sha256 },
        { role: "architectural_candidate_delta_mask", sha256: packagedArchitecturalDelta.artifacts.candidate_delta_mask.sha256 },
        { role: "architectural_source_redacted_comparison", sha256: packagedArchitecturalDelta.artifacts.comparison.sha256 }
      ] : []),
      ...(packagedArchitecturalMeasurement ? [
        { role: "architectural_registered_measurement", sha256: sha256(architecturalMeasurementReceiptCopy) },
        { role: "architectural_registered_measurement_overlay", sha256: packagedArchitecturalMeasurement.overlay.sha256 }
      ] : []),
      ...(packagedArchitecturalWallCandidates ? [
        { role: "architectural_wall_line_candidates", sha256: sha256(architecturalWallCandidateReceiptCopy) },
        { role: "architectural_wall_line_candidate_overlay", sha256: packagedArchitecturalWallCandidates.overlay.sha256 },
        ...packagedArchitecturalWallCandidates.opening_evidence_crops.flatMap((crop) => [
          { role: "architectural_opening_source_crop", sha256: crop.source_crop.sha256 },
          { role: "architectural_opening_evidence_overlay", sha256: crop.evidence_overlay.sha256 }
        ])
      ] : [])
    ],
    require_source_observation_grounding: taskClass === "exact_reconstruction",
    material_confidence_threshold: 0.75,
    max_repairs: maxRepairs
  });
  writeJson(controllerStatePath, {
    state: controllerState,
    next_action: getExistingConditionsControllerNextAction(controllerState)
  });
}

function advanceController(): void {
  const rawState = readJson(requiredArgument("--state"));
  const stateObject = asObject(rawState);
  const state = (stateObject.state && typeof stateObject.state === "object" ? stateObject.state : rawState) as ExistingConditionsControllerState;
  const event = readJson(requiredArgument("--event")) as ExistingConditionsControllerEvent;
  const next = advanceExistingConditionsController(state, event);
  writeJson(requiredArgument("--out"), {
    state: next,
    next_action: getExistingConditionsControllerNextAction(next)
  });
}

function sealGroundTruth(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const snapshotPath = path.resolve(requiredArgument("--snapshot"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const groundTruthModel = path.resolve(requiredArgument("--ground-truth-model"));
  const deletionManifestPath = path.resolve(requiredArgument("--deletion-manifest"));
  const deleteDryRunPath = path.resolve(requiredArgument("--delete-dry-run"));
  const outPath = path.resolve(requiredArgument("--out"));
  if (canonicalPath(outPath).includes("/agent/")) {
    throw new Error("Ground truth must not be written into an agent-visible directory.");
  }
  const discipline = optionalDiscipline();
  if (!fs.existsSync(groundTruthModel)) throw new Error(`Ground-truth model does not exist: ${groundTruthModel}`);
  const manifest = asObject(readJson(deletionManifestPath));
  const truth: ExistingConditionsGroundTruth = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    ...(discipline ? { discipline } : {}),
    ground_truth_model: { path: groundTruthModel, sha256: sha256(groundTruthModel) },
    visible_evidence: [{ role: "source_pdf", sha256: sha256(sourcePdf) }],
    evaluation_policy: {
      require_evaluator_change_receipt: process.argv.includes("--require-evaluator-receipt")
    },
    deletion_manifest: {
      requested_element_ids: Array.isArray(manifest.requested_element_ids) ? manifest.requested_element_ids.map(Number) : [],
      deleted_element_ids: Array.isArray(manifest.deleted_element_ids) ? manifest.deleted_element_ids.map(Number) : [],
      dependent_element_ids: Array.isArray(manifest.dependent_element_ids) ? manifest.dependent_element_ids.map(Number) : [],
      dry_run_receipt_sha256: sha256(deleteDryRunPath)
    },
    snapshot: readJson(snapshotPath) as ExistingConditionsSnapshot
  };
  assertExistingConditionsContract("ground_truth", truth);
  writeJson(outPath, truth);
}

function sealCandidate(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const snapshotPath = path.resolve(requiredArgument("--snapshot"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const visualReceipt = readJson(requiredArgument("--evaluator-visual-receipt")) as ExistingConditionsEvaluatorVisualReceipt;
  if (!validateExistingConditionsEvaluatorVisualReceipt(visualReceipt)) {
    throw new Error("Evaluator visual receipt is invalid or has been modified.");
  }
  const discipline = optionalDiscipline();
  const candidate: ExistingConditionsCandidate = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    ...(discipline ? { discipline } : {}),
    visible_evidence: [{ role: "source_pdf", sha256: sha256(sourcePdf) }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    ...(argument("--evaluator-change-receipt")
      ? { evaluator_change_receipt: readJson(argument("--evaluator-change-receipt")) as ExistingConditionsCandidate["evaluator_change_receipt"] }
      : {}),
    snapshot: readJson(snapshotPath) as ExistingConditionsSnapshot,
    visual_receipt: visualReceipt
  };
  assertExistingConditionsContract("candidate", candidate);
  writeJson(requiredArgument("--out"), candidate);
}

function reviewVisualEvidence(): void {
  const postCapture = path.resolve(requiredArgument("--post-capture"));
  const postPdf = path.resolve(requiredArgument("--post-pdf"));
  const status = requiredArgument("--status").toLowerCase();
  if (!fs.existsSync(postCapture)) throw new Error(`Post-change capture does not exist: ${postCapture}`);
  if (!fs.existsSync(postPdf)) throw new Error(`Post-change PDF does not exist: ${postPdf}`);
  if (!["pass", "needs_review", "fail"].includes(status)) throw new Error("--status must be pass, needs_review, or fail.");
  const notes = argument("--notes").split("|").map((note) => note.trim()).filter(Boolean);
  const receipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_sha256: sha256(postCapture),
    post_change_pdf_sha256: sha256(postPdf),
    review_status: status as "pass" | "needs_review" | "fail",
    notes
  });
  writeJson(requiredArgument("--out"), receipt);
}

function validateContractFile(): void {
  const kind = requiredArgument("--kind");
  if (!["agent_package", "ground_truth", "candidate", "architectural_preview", "architectural_pixel_measurement", "registered_mep_observations", "mep_region_coverage", "architectural_wall_candidate_clarification", "architectural_opening_classification", "architectural_door_span_observation", "architectural_opening_host_resolution"].includes(kind)) {
    throw new Error("--kind must be agent_package, ground_truth, candidate, architectural_preview, architectural_pixel_measurement, registered_mep_observations, mep_region_coverage, architectural_wall_candidate_clarification, architectural_opening_classification, architectural_door_span_observation, or architectural_opening_host_resolution.");
  }
  const filePath = path.resolve(requiredArgument("--file"));
  assertExistingConditionsContract(
    kind as "agent_package" | "ground_truth" | "candidate" | "architectural_preview" | "architectural_pixel_measurement" | "registered_mep_observations" | "mep_region_coverage" | "architectural_wall_candidate_clarification" | "architectural_opening_classification" | "architectural_door_span_observation" | "architectural_opening_host_resolution",
    readJson(filePath)
  );
  process.stdout.write(`${filePath}: valid ${kind}\n`);
}

function scoreSealedCandidate(): void {
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty score directory: ${outDir}`);
  }
  const packageArgument = argument("--package");
  let taskClass = "exact_reconstruction";
  let packageValue: Record<string, unknown> | null = null;
  if (packageArgument) {
    packageValue = asObject(readJson(packageArgument));
    assertExistingConditionsContract("agent_package", packageValue);
    taskClass = String(packageValue.task_class ?? "");
  }

  if (taskClass !== "exact_reconstruction") {
    const standardsReference = asObject(packageValue?.standards_profile);
    const standardsPath = path.resolve(String(standardsReference.path ?? ""));
    if (!fs.existsSync(standardsPath)) throw new Error(`Standards profile does not exist: ${standardsPath}`);
    const expectedStandardsHash = String(standardsReference.sha256 ?? "").toLowerCase();
    const actualStandardsHash = sha256(standardsPath).toLowerCase();
    if (expectedStandardsHash !== actualStandardsHash) throw new Error("standards_profile_hash_mismatch");
    const standardsContext = readJson(standardsPath) as EngineeringStandardsContext;
    const acceptance = asObject(packageValue?.acceptance_contract);
    const writePolicy = asObject(packageValue?.write_policy);
    const contract: EngineeringBenchmarkTaskContract = {
      task_class: taskClass as "standards_compliance_repair" | "generative_layout",
      acceptance_basis: (Array.isArray(acceptance.acceptance_basis) ? acceptance.acceptance_basis : []) as EngineeringAcceptanceBasis[],
      allows_multiple_valid_solutions: acceptance.allows_multiple_valid_solutions === true,
      requires_exact_element_ids: acceptance.requires_exact_element_ids === true,
      requires_exact_coordinates: acceptance.requires_exact_coordinates === true,
      standards_context: standardsContext,
      standards_profile_artifact_sha256: actualStandardsHash,
      requires_evaluator_change_receipt: writePolicy.require_evaluator_change_receipt === true,
      requires_evaluator_access_provenance: writePolicy.require_evaluator_access_provenance === true
    };
    const rawChecks = readJson(requiredArgument("--evaluator-checks"));
    const checks = (Array.isArray(rawChecks) ? rawChecks : asObject(rawChecks).checks) as EngineeringCheckResult[];
    if (!Array.isArray(checks)) throw new Error("--evaluator-checks must contain a JSON array or {checks:[...]}.");
    const constructability = requiredArgument("--constructability").toLowerCase();
    const drawingLegibility = requiredArgument("--drawing-legibility").toLowerCase();
    if (!['pass', 'fail'].includes(constructability)) throw new Error("--constructability must be pass or fail.");
    if (!['pass', 'fail'].includes(drawingLegibility)) throw new Error("--drawing-legibility must be pass or fail.");
    const result = scoreEngineeringInvariantBenchmark({
      contract,
      evaluator_checks: checks,
      evaluator_change_receipt: readJson(requiredArgument("--evaluator-change-receipt")) as EvaluatorOwnedChangeReceipt,
      evaluator_access_provenance: readJson(requiredArgument("--evaluator-access-provenance")) as EvaluatorOwnedAccessProvenance,
      constructability_passed: constructability === "pass",
      drawing_legibility_passed: drawingLegibility === "pass"
    });
    writeJson(path.join(outDir, "existing_conditions_engineering_score.json"), result);
    const lines = [
      `# Existing conditions engineering evaluation - ${String(packageValue?.fixture_id ?? "fixture")}`,
      "",
      `- Task class: ${result.task_class}`,
      `- Valid run: ${result.valid_run ? "yes" : "no"}`,
      `- Passed: ${result.passed ? "yes" : "no"}`,
      `- Score: ${result.score.toFixed(3)} / 100`,
      `- Engineering invariants: ${result.metrics.engineering_invariants.toFixed(3)}`,
      `- Scope safety: ${result.metrics.scope_safety.toFixed(3)}`,
      `- Access provenance: ${result.metrics.access_provenance.toFixed(3)}`,
      ""
    ];
    fs.writeFileSync(path.join(outDir, "existing_conditions_engineering_score.md"), `${lines.join("\n")}\n`, "utf8");
    return;
  }

  const truthValue = readJson(requiredArgument("--truth"));
  const candidateValue = readJson(requiredArgument("--candidate"));
  assertExistingConditionsContract("ground_truth", truthValue);
  assertExistingConditionsContract("candidate", candidateValue);
  const truth = truthValue as ExistingConditionsGroundTruth;
  const candidate = candidateValue as ExistingConditionsCandidate;
  const scoringPolicy = parseExistingConditionsScoringPolicy();
  const result = scoreExistingConditionsReconstruction(truth, candidate, scoringPolicy);
  const scoreReceipt = {
    ...result,
    scoring_policy: scoringPolicy,
    scoring_policy_fingerprint_sha256: existingConditionsScoringPolicyFingerprint(scoringPolicy)
  };
  writeJson(path.join(outDir, "existing_conditions_score.json"), scoreReceipt);
  const lines = [
    `# Existing conditions reconstruction - ${result.fixture_id}`,
    "",
    `- Scope: ${result.scope_id}`,
    `- Valid run: ${result.valid_run ? "yes" : "no"}`,
    `- Passed: ${result.passed ? "yes" : "no"}`,
    `- Score: ${result.score.toFixed(3)} / 100`,
    `- Scoring policy SHA-256: ${scoreReceipt.scoring_policy_fingerprint_sha256}`,
    `- Matched: ${result.counts.matched} / ${result.counts.truth}`,
    `- False positives: ${result.counts.false_positive}`,
    "",
    "| Metric | Score |",
    "| --- | ---: |",
    `| Element F1 | ${result.metrics.element_f1.toFixed(3)} |`,
    `| Geometry | ${result.metrics.geometry.toFixed(3)} |`,
    `| Attributes | ${result.metrics.attributes.toFixed(3)} |`,
    `| Connectivity | ${result.metrics.connectivity.toFixed(3)} |`,
    `| Systems | ${result.metrics.systems.toFixed(3)} |`,
    `| Drawing evidence | ${result.metrics.drawing_evidence.toFixed(3)} |`,
    ""
  ];
  fs.writeFileSync(path.join(outDir, "existing_conditions_score.md"), `${lines.join("\n")}\n`, "utf8");
}

function evaluateEngineeringCaseFile(): void {
  const definition = readJson(requiredArgument("--case")) as EngineeringCaseDefinition;
  const evidence = readJson(requiredArgument("--native-evidence")) as EngineeringCaseNativeEvidence;
  const provenance = readJson(requiredArgument("--evaluator-provenance")) as EngineeringCaseEvidenceProvenance;
  const evaluatorKey = fs.readFileSync(path.resolve(requiredArgument("--evaluator-key-file")), "utf8").trim();
  const result = evaluateEngineeringInvariantCase(definition, evidence, provenance, evaluatorKey);
  writeJson(requiredArgument("--out"), result);
  if (!result.valid) throw new Error(result.invalid_reasons.join(","));
  if (!result.passed) {
    const failures = result.checks.filter((check) => !check.passed)
      .map((check) => check.failure_classification ?? "engineering_invariant_failed");
    throw new Error(`engineering_case_failed:${[...new Set(failures)].join(",")}`);
  }
}

function sealEngineeringEvidenceFile(): void {
  const definition = readJson(requiredArgument("--case")) as EngineeringCaseDefinition;
  const evidence = readJson(requiredArgument("--native-evidence")) as EngineeringCaseNativeEvidence;
  const evaluatorKey = fs.readFileSync(path.resolve(requiredArgument("--evaluator-key-file")), "utf8").trim();
  writeJson(requiredArgument("--out"), createEngineeringCaseEvidenceProvenance(definition, evidence, evaluatorKey));
}

function collectGfciNativeEvidenceFile(): void {
  const config = readJson(requiredArgument("--adapter-config")) as GfciNativeAdapterConfig;
  const readbacks = readJson(requiredArgument("--parameter-readbacks"));
  if (!Array.isArray(readbacks)) throw new Error("--parameter-readbacks must contain a JSON array.");
  const evidence = collectGfciNativeEvidence(
    config,
    readJson(requiredArgument("--room-contents")),
    readbacks as NativeParameterReadback[]
  );
  writeJson(requiredArgument("--out"), evidence);
}

async function captureGfciNativeEvidence(): Promise<void> {
  const expectedModel = path.resolve(requiredArgument("--expected-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty GFCI capture directory: ${outDir}`);
  }
  const config = readJson(requiredArgument("--adapter-config")) as GfciNativeAdapterConfig;
  const expectedModelSha256 = sha256(expectedModel);
  assertExpectedGfciModelSha256(config, expectedModelSha256);
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  const roomContents = await client.post("/revit/room-contents", {
    roomNumber: config.room_number,
    categories: ["Plumbing Fixtures", "Electrical Fixtures"],
    includeLinked: true,
    mode: "auto",
    verticalScope: "room",
    spatialKindPreference: "space",
    limit: 50000
  });
  const elementIds = selectGfciScopedElementIds(config, roomContents);
  if (elementIds.length === 0) throw new Error("gfci_adapter_scoped_receptacles_missing");
  const parameterReadbacks: NativeParameterReadback[] = [];
  for (const elementId of elementIds) {
    parameterReadbacks.push(await client.post("/revit/get-parameters", { elementId }) as NativeParameterReadback);
  }
  const evidence = collectGfciNativeEvidence(config, roomContents, parameterReadbacks);
  evidence.collection_receipt = {
    ...(evidence.collection_receipt ?? {}),
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256
  };
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "room_contents.json"), roomContents);
  writeJson(path.join(outDir, "parameter_readbacks.json"), parameterReadbacks);
  writeJson(path.join(outDir, "native_evidence.json"), evidence);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256,
    room_number: config.room_number,
    scoped_element_ids: elementIds,
    adapter_config_sha256: sha256(path.resolve(requiredArgument("--adapter-config"))),
    native_readback: evidence.native_readback
  });
}

function collectDwellingWallCoverageNativeEvidenceFile(): void {
  const config = readJson(requiredArgument("--adapter-config")) as DwellingWallCoverageNativeAdapterConfig;
  const evidence = collectDwellingWallCoverageNativeEvidence(
    config,
    readJson(requiredArgument("--planner-response")),
    readJson(requiredArgument("--room-contents"))
  );
  writeJson(requiredArgument("--out"), evidence);
}

function collectCircuitLoadingNativeEvidenceFile(): void {
  const config = readJson(requiredArgument("--adapter-config")) as CircuitLoadingNativeAdapterConfig;
  const evidence = collectCircuitLoadingNativeEvidence(
    config,
    readJson(requiredArgument("--room-contents")),
    readJson(requiredArgument("--circuit-audit"))
  );
  writeJson(requiredArgument("--out"), evidence);
}

async function captureCircuitLoadingNativeEvidence(): Promise<void> {
  const expectedModel = path.resolve(requiredArgument("--expected-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty circuit-loading capture directory: ${outDir}`);
  }
  const config = readJson(requiredArgument("--adapter-config")) as CircuitLoadingNativeAdapterConfig;
  const expectedModelSha256 = sha256(expectedModel);
  assertExpectedCircuitLoadingModelSha256(config, expectedModelSha256);
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  let roomContents: unknown = null;
  let elementIds: number[] = [];
  if (config.room_number) {
    roomContents = await client.post("/revit/room-contents", {
      roomNumber: config.room_number,
      categories: ["Electrical Fixtures"],
      includeLinked: false,
      mode: "auto",
      verticalScope: "room",
      spatialKindPreference: "space",
      limit: 50000
    });
    elementIds = selectCircuitLoadingScopedElementIds(config, roomContents);
    if (elementIds.length === 0) throw new Error("circuit_adapter_scoped_receptacles_missing");
  }
  const circuitAudit = await client.post("/revit/audit-electrical-circuit-loading", {
    ...(config.panel_name ? { panelName: config.panel_name } : { elementIds }),
    wireAmpacityProfiles: config.wire_ampacity_profiles.map((profile) => ({
      wireSizeToken: profile.wire_size_token,
      ampacityAmps: profile.ampacity_amps
    })),
    maxElements: 5000
  });
  const evidence = collectCircuitLoadingNativeEvidence(config, roomContents, circuitAudit);
  evidence.collection_receipt = {
    ...(evidence.collection_receipt ?? {}),
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256
  };
  writeJson(path.join(outDir, "context.json"), context);
  if (config.room_number) writeJson(path.join(outDir, "room_contents.json"), roomContents);
  writeJson(path.join(outDir, "circuit_audit.json"), circuitAudit);
  writeJson(path.join(outDir, "native_evidence.json"), evidence);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256,
    ...(config.panel_name ? { panel_name: config.panel_name } : { room_number: config.room_number, scoped_element_ids: elementIds }),
    adapter_config_sha256: sha256(path.resolve(requiredArgument("--adapter-config"))),
    native_readback: evidence.native_readback
  });
}

function collectPlumbingFixtureServicesNativeEvidenceFile(): void {
  const config = readJson(requiredArgument("--adapter-config")) as PlumbingFixtureServicesNativeAdapterConfig;
  const evidence = collectPlumbingFixtureServicesNativeEvidence(
    config,
    readJson(requiredArgument("--plumbing-audit"))
  );
  writeJson(requiredArgument("--out"), evidence);
}

async function capturePlumbingFixtureServicesNativeEvidence(): Promise<void> {
  const expectedModel = path.resolve(requiredArgument("--expected-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty plumbing fixture-services capture directory: ${outDir}`);
  }
  const config = readJson(requiredArgument("--adapter-config")) as PlumbingFixtureServicesNativeAdapterConfig;
  const expectedModelSha256 = sha256(expectedModel);
  assertExpectedPlumbingFixtureServicesModelSha256(config, expectedModelSha256);
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  const discovery = plumbingFixtureAuditDiscoveryTokens(config);
  const plumbingAudit = await client.post("/revit/audit-plumbing-fixture-services", {
    levelName: config.level_name,
    familyMatchTokens: discovery.familyMatchTokens,
    typeMatchTokens: discovery.typeMatchTokens,
    maxElements: 5000,
    maxVentSearchElements: 2000,
    maxVentSearchHops: 40
  });
  const evidence = collectPlumbingFixtureServicesNativeEvidence(config, plumbingAudit);
  evidence.collection_receipt = {
    ...(evidence.collection_receipt ?? {}),
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256
  };
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "plumbing_audit.json"), plumbingAudit);
  writeJson(path.join(outDir, "native_evidence.json"), evidence);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256,
    level_name: config.level_name,
    adapter_config_sha256: sha256(path.resolve(requiredArgument("--adapter-config"))),
    native_readback: evidence.native_readback
  });
}

async function captureDwellingWallCoverageNativeEvidence(): Promise<void> {
  const expectedModel = path.resolve(requiredArgument("--expected-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty dwelling-wall capture directory: ${outDir}`);
  }
  const config = readJson(requiredArgument("--adapter-config")) as DwellingWallCoverageNativeAdapterConfig;
  const expectedModelSha256 = sha256(expectedModel);
  assertExpectedDwellingWallCoverageModelSha256(config, expectedModelSha256);
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  const plannerResponse = await client.post("/revit/plan-dwelling-receptacles", {
    roomNumber: config.room_number,
    viewId: config.view_id,
    roomClassifications: config.room_classifications,
    includeExistingReceptacles: true
  });
  const roomContents = await client.post("/revit/room-contents", {
    roomNumber: config.room_number,
    categories: ["Electrical Fixtures"],
    includeLinked: false,
    mode: "auto",
    verticalScope: "room",
    spatialKindPreference: "space",
    limit: 50000
  });
  const evidence = collectDwellingWallCoverageNativeEvidence(config, plannerResponse, roomContents);
  evidence.collection_receipt = {
    ...(evidence.collection_receipt ?? {}),
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256
  };
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "planner_response.json"), plannerResponse);
  writeJson(path.join(outDir, "room_contents.json"), roomContents);
  writeJson(path.join(outDir, "native_evidence.json"), evidence);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    expected_model_path: expectedModel,
    expected_model_sha256: expectedModelSha256,
    room_number: config.room_number,
    view_id: config.view_id,
    target_wall_segment_ids: config.wall_segments.map((segment) => segment.segment_id),
    adapter_config_sha256: sha256(path.resolve(requiredArgument("--adapter-config"))),
    native_readback: evidence.native_readback
  });
}

async function runRedaction(): Promise<void> {
  const expectedSource = path.resolve(requiredArgument("--expected-source"));
  const stagingModel = path.resolve(requiredArgument("--staging-model"));
  const redactedModel = path.resolve(requiredArgument("--redacted-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewId = Number(requiredArgument("--view-id"));
  const ids = parseIds(requiredArgument("--ids"));
  const anchorIds = parseIds(requiredArgument("--anchor-ids"));
  const resumeStaging = process.argv.includes("--resume-staging");
  const resumeRedacted = process.argv.includes("--resume-redacted");
  if (resumeStaging && resumeRedacted) throw new Error("--resume-staging and --resume-redacted are mutually exclusive.");
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (!fs.existsSync(expectedSource)) throw new Error(`Expected source does not exist: ${expectedSource}`);
  if (canonicalPath(expectedSource) === canonicalPath(stagingModel) || canonicalPath(expectedSource) === canonicalPath(redactedModel)) {
    throw new Error("Source, staging, and redacted model paths must be distinct.");
  }
  if (canonicalPath(stagingModel) === canonicalPath(redactedModel)) throw new Error("Staging and redacted model paths must be distinct.");
  if (!resumeStaging && !resumeRedacted && (fs.existsSync(stagingModel) || fs.existsSync(redactedModel))) {
    throw new Error("Refusing to overwrite an existing staging or redacted model.");
  }
  if (resumeStaging && fs.existsSync(redactedModel)) throw new Error("--resume-staging refuses an existing redacted model.");
  if (resumeStaging && !fs.existsSync(stagingModel)) throw new Error("--resume-staging requires an existing staging model.");
  if (resumeRedacted && !fs.existsSync(redactedModel)) throw new Error("--resume-redacted requires an existing redacted model.");
  const withheldDir = path.join(outDir, "withheld");
  const agentDir = path.join(outDir, "agent");
  fs.mkdirSync(withheldDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const client = bridgeClient();
  const sourceContext = await client.get("/revit/context");
  const expectedActivePath = resumeRedacted ? redactedModel : resumeStaging ? stagingModel : expectedSource;
  if (canonicalPath(activeDocumentPath(sourceContext)) !== canonicalPath(expectedActivePath)) {
    const expectedRole = resumeRedacted ? "redacted model" : resumeStaging ? "staging model" : "source";
    throw new Error(`Active document is not the expected ${expectedRole}: ${activeDocumentPath(sourceContext)}`);
  }
  const stagingPlan = resumeStaging || resumeRedacted
    ? { status: "Skipped", reason: resumeRedacted ? "resume_redacted" : "resume_staging" }
    : await client.post("/revit/save-as", {
      filePath: stagingModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: true
    }, true);
  const stagingSave = resumeStaging || resumeRedacted
    ? { status: "Skipped", reason: resumeRedacted ? "resume_redacted" : "resume_staging", path: stagingModel }
    : await client.post("/revit/save-as", {
      filePath: stagingModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: false
    }, true);
  const stagingContext = resumeRedacted ? sourceContext : await client.get("/revit/context");
  if (!resumeRedacted && canonicalPath(activeDocumentPath(stagingContext)) !== canonicalPath(stagingModel)) {
    throw new Error(`Save As did not activate the staging model: ${activeDocumentPath(stagingContext)}`);
  }
  const requested = [...ids].sort((a, b) => a - b);
  const deletePlan = resumeRedacted
    ? { status: "Skipped", reason: "resume_redacted_requires_native_absence_readback" }
    : await client.post("/revit/delete", buildExistingConditionsDeleteRequest(ids, false), true);
  const plannedDeleteIds = resumeRedacted ? requested : responseIds(deletePlan);
  const dependentIds = resumeRedacted ? [] : plannedDeleteIds.filter((id) => !requested.includes(id));
  if (!resumeRedacted) {
    if (!process.argv.includes("--allow-dependent-deletes") && dependentIds.length > 0) {
      throw new Error(`Delete dry-run included dependent IDs: ${dependentIds.join(",")}`);
    }
    if (requested.some((id) => !plannedDeleteIds.includes(id))) throw new Error("Delete dry-run did not cover every requested ID.");
  }
  const deleteApply = resumeRedacted
    ? { status: "Skipped", reason: "resume_redacted_requires_native_absence_readback" }
    : await client.post("/revit/delete", buildExistingConditionsDeleteRequest(ids, true), true);
  const appliedDeleteIds = resumeRedacted ? requested : responseIds(deleteApply);
  if (!resumeRedacted && JSON.stringify(appliedDeleteIds) !== JSON.stringify(plannedDeleteIds)) {
    throw new Error(`Delete apply IDs differ from dry-run IDs: planned=${plannedDeleteIds.join(",")} applied=${appliedDeleteIds.join(",")}`);
  }
  const finalPlan = resumeRedacted
    ? { status: "Skipped", reason: "resume_redacted", path: redactedModel }
    : await client.post("/revit/save-as", {
      filePath: redactedModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: true
    }, true);
  const finalSave = resumeRedacted
    ? { status: "Skipped", reason: "resume_redacted", path: redactedModel }
    : await client.post("/revit/save-as", {
      filePath: redactedModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: false
    }, true);
  const finalContext = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(finalContext)) !== canonicalPath(redactedModel)) {
    throw new Error(`Final Save As did not activate the redacted model: ${activeDocumentPath(finalContext)}`);
  }
  const deletedElementReadback = await client.post("/revit/get-element-summary", { elementIds: requested });
  verifyExistingConditionsDeletedElementReadback(deletedElementReadback, requested);
  const visibleAfter = await client.post("/revit/export-visible-elements", {
    viewId,
    imageSize: 3000,
    includeMapping: true,
    includeGeometry: true,
    includeLinked: false,
    limit: 2000,
    categories: argument("--categories")
      ? parseCsv(argument("--categories"), "--categories")
      : DEFAULT_EXISTING_CONDITIONS_CATEGORIES
  });
  const anchorConnectorsAfter = await client.post("/revit/get-connectors", {
    elementIds: anchorIds,
    includeAllRefs: true,
    includeCoordinateSystem: true
  });
  writeJson(path.join(withheldDir, "source_context.json"), sourceContext);
  writeJson(path.join(withheldDir, "staging_save_plan.json"), stagingPlan);
  writeJson(path.join(withheldDir, "staging_save_result.json"), stagingSave);
  writeJson(path.join(withheldDir, "delete_dry_run.json"), deletePlan);
  writeJson(path.join(withheldDir, "delete_apply.json"), deleteApply);
  writeJson(path.join(withheldDir, "final_save_plan.json"), finalPlan);
  writeJson(path.join(withheldDir, "final_save_result.json"), finalSave);
  writeJson(path.join(withheldDir, "deleted_element_absence_readback.json"), deletedElementReadback);
  writeJson(path.join(withheldDir, "redaction_manifest.json"), {
    schema_version: 1,
    expected_source: expectedSource,
    source_sha256: sha256(expectedSource),
    staging_model: stagingModel,
    redacted_model: redactedModel,
    redacted_model_sha256: sha256(redactedModel),
    requested_element_ids: requested,
    deleted_element_ids: appliedDeleteIds,
    dependent_element_ids: resumeRedacted ? null : dependentIds,
    dependent_element_ids_status: resumeRedacted ? "unavailable_after_interrupted_controller" : "recorded_from_delete_dry_run",
    requested_element_absence_verified: true,
    view_id: viewId,
    anchor_element_ids: anchorIds
  });
  writeJson(path.join(agentDir, "redacted_context.json"), finalContext);
  writeJson(path.join(agentDir, "visible_elements_after_redaction.json"), visibleAfter);
  writeJson(path.join(agentDir, "anchor_connectors_after_redaction.json"), anchorConnectorsAfter);
  writeJson(path.join(agentDir, "working_model_receipt.json"), {
    schema_version: 1,
    fixture_role: "redacted_model",
    path: redactedModel,
    sha256: sha256(redactedModel),
    scope_view_id: viewId
  });
}

async function main(): Promise<void> {
  const command = String(process.argv[2] ?? "").trim().toLowerCase();
  if (command === "normalize") {
    const snapshot = normalizeExistingConditionsSnapshot(
      readJson(requiredArgument("--visible")),
      readJson(requiredArgument("--connectors")),
      {
        selected_element_ids: parseIds(requiredArgument("--ids")),
        require_connector_readback: !process.argv.includes("--allow-missing-connectors")
      }
    );
    writeJson(requiredArgument("--out"), snapshot);
    return;
  }
  if (command === "inventory") {
    await captureVisibleInventory();
    return;
  }
  if (command === "scope-image-region") {
    buildImageScopeReceipt();
    return;
  }
  if (command === "solve-registration") {
    const input = readJson(requiredArgument("--input"));
    const root = asObject(input);
    const registrationInput = asObject(root.registration_input ?? input) as ExistingConditionsRegistrationInput;
    writeJson(requiredArgument("--out"), solveExistingConditionsRegistration(registrationInput));
    return;
  }
  if (command === "assess-registration-ambiguity") {
    const input = readJson(requiredArgument("--input"));
    assertExistingConditionsContract("registration_ambiguity", input);
    writeJson(
      requiredArgument("--out"),
      assessExistingConditionsRegistrationAmbiguity(input as ExistingConditionsRegistrationAmbiguityInputV1)
    );
    return;
  }
  if (command === "extract-plan-traces") {
    const input = readJson(requiredArgument("--input")) as PlanTraceExtractionInput;
    const receipt = await extractPlanTraces(input);
    const previewOut = argument("--preview-out");
    const diagnosticPreview = previewOut
      ? await renderPlanTraceExtractionPreview(input.source_image_path, receipt, previewOut)
      : undefined;
    writeJson(requiredArgument("--out"), diagnosticPreview ? { ...receipt, diagnostic_preview: diagnosticPreview } : receipt);
    return;
  }
  if (command === "compile-plan-trace-seed-spines") {
    const inputPath = requiredArgument("--input");
    const receiptPath = requiredArgument("--receipt");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--receipt", value: receiptPath }]
    );
    writeJson(
      outputPath,
      compilePlanTraceSeedSpinesV1(
        readJson(inputPath) as PlanTraceSeedSpineInputV1,
        readJson(receiptPath) as PlanTraceExtractionReceipt
      )
    );
    return;
  }
  if (command === "repair-plan-trace-continuation-anchor") {
    const inputPath = requiredArgument("--input");
    const receiptPath = requiredArgument("--receipt");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--receipt", value: receiptPath }]
    );
    writeJson(
      outputPath,
      resolvePlanTraceContinuationAnchorV1(
        readJson(inputPath) as PlanTraceContinuationAnchorRepairInputV1,
        readJson(receiptPath) as PlanTraceExtractionReceipt
      )
    );
    return;
  }
  if (command === "normalize-plan-trace-spines") {
    const inputPath = requiredArgument("--input");
    const receiptPath = requiredArgument("--receipt");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--receipt", value: receiptPath }]
    );
    writeJson(
      outputPath,
      normalizePlanTraceSeedSpinesV1(
        readJson(inputPath) as PlanTraceSpineNormalizationInputV1,
        readJson(receiptPath) as ReturnType<typeof compilePlanTraceSeedSpinesV1>
      )
    );
    return;
  }
  if (command === "detect-repeated-mep-symbols") {
    const receipt = await detectRepeatedMepSymbols(
      readJson(requiredArgument("--input")) as MepRepeatedSymbolDetectionInputV1
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "extract-sheet-vector-text") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }]
    );
    writeJson(
      outputPath,
      await extractSheetVectorTextV1(readJson(inputPath) as SheetVectorTextExtractionInputV1)
    );
    return;
  }
  if (command === "detect-sheet-chromatic-components") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    const overlayPath = argument("--overlay-out");
    assertFreshDistinctOutputPaths(
      [
        { flag: "--out", value: outputPath },
        ...(overlayPath ? [{ flag: "--overlay-out", value: overlayPath }] : [])
      ],
      [{ flag: "--input", value: inputPath }]
    );
    const input = readJson(inputPath) as SheetChromaticComponentDetectionInputV1;
    const receipt = await detectSheetChromaticComponentsV1(input);
    const overlay = overlayPath
      ? await renderSheetChromaticComponentOverlayV1({
          source_image_path: input.source_image_path,
          receipt,
          output_path: overlayPath
        })
      : undefined;
    writeJson(outputPath, overlay ? { ...receipt, overlay } : receipt);
    return;
  }
  if (command === "validate-sheet-route-chromatic-coverage") {
    const inputPath = requiredArgument("--input");
    const candidatePath = argument("--candidate");
    const outputPath = requiredArgument("--out");
    const overlayPath = argument("--overlay-out");
    assertFreshDistinctOutputPaths(
      [
        { flag: "--out", value: outputPath },
        ...(overlayPath ? [{ flag: "--overlay-out", value: overlayPath }] : [])
      ],
      [{ flag: "--input", value: inputPath }, ...(candidatePath ? [{ flag: "--candidate", value: candidatePath }] : [])]
    );
    const rawInput = readJson(inputPath) as Partial<SheetRouteChromaticCoverageInputV1>;
    const interpretation = candidatePath
      ? sheetPixelInterpretation(readJson(candidatePath))
      : sheetPixelInterpretation({ interpretation: rawInput.interpretation });
    const input = {
      ...rawInput,
      source_view_key: rawInput.source_view_key || (interpretation.view_keys.length === 1 ? interpretation.view_keys[0] : undefined),
      interpretation
    } as SheetRouteChromaticCoverageInputV1;
    const receipt = await validateSheetRouteChromaticCoverageV1(input);
    const overlay = overlayPath
      ? await renderSheetRouteChromaticCoverageOverlayV1({
          source_image_path: input.source_image_path,
          interpretation: input.interpretation,
          receipt,
          output_path: overlayPath
        })
      : undefined;
    writeJson(outputPath, overlay ? { ...receipt, overlay } : receipt);
    if (!receipt.accepted) process.exitCode = 1;
    return;
  }
  if (command === "compile-sheet-overlap-routes") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths([{ flag: "--out", value: outputPath }], [{ flag: "--input", value: inputPath }]);
    const receipt = await compileSheetOverlapRoutesV1(readJson(inputPath) as SheetOverlapRouteCompilationInputV1);
    writeJson(outputPath, receipt);
    if (receipt.status !== "source_graph_compiled") process.exitCode = 1;
    return;
  }
  if (command === "evaluate-source-native-pair-health") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths([{ flag: "--out", value: outputPath }], [{ flag: "--input", value: inputPath }]);
    const receipt = await evaluateSourceNativePairHealthV1(readJson(inputPath) as SourceNativePairHealthInputV1);
    writeJson(outputPath, receipt);
    if (!receipt.candidate_release_allowed) process.exitCode = 1;
    return;
  }
  if (command === "grade-sealed-candidate-native-routes") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths([{ flag: "--out", value: outputPath }], [{ flag: "--input", value: inputPath }]);
    const receipt = await evaluateSealedCandidateNativeRouteGradeV1(readJson(inputPath) as SealedCandidateNativeRouteGradeInputV1);
    writeJson(outputPath, receipt);
    if (receipt.status !== "accepted_post_seal_native_grade") process.exitCode = 1;
    return;
  }
  if (command === "validate-mep-region-coverage") {
    const receipt = validateBoundedMepRegionCoverage(
      readJson(requiredArgument("--input")) as BoundedMepRegionCoverageV1 | BoundedMepRegionCoverageV2,
      readJson(requiredArgument("--context")) as BoundedMepRegionCoverageContext
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "compile-sheet-topology") {
    const inputPath = requiredArgument("--input");
    const contextPath = requiredArgument("--context");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--context", value: contextPath }]
    );
    writeJson(
      outputPath,
      compileSheetTopologyV1(
        readJson(inputPath) as SheetTopologyCompilationInputV1,
        readJson(contextPath) as SheetTopologyCompilationContextV1
      )
    );
    return;
  }
  if (command === "build-sheet-topology-calibration") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }]
    );
    writeJson(
      outputPath,
      buildSheetTopologyCalibrationProfileV1(
        readJson(inputPath) as SheetTopologyCalibrationBuildInputV1
      )
    );
    return;
  }
  if (command === "compile-sheet-pixel-interpretation") {
    const inputPath = requiredArgument("--input");
    const contextPath = requiredArgument("--context");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--context", value: contextPath }]
    );
    writeJson(
      outputPath,
      compileSheetPixelInterpretationV1(
        sheetPixelInterpretation(readJson(inputPath)),
        readJson(contextPath) as SheetPixelInterpretationContextV1
      )
    );
    return;
  }
  if (command === "validate-sheet-pixel-evidence") {
    const inputPath = requiredArgument("--input");
    const imagePath = requiredArgument("--image");
    const outputPath = requiredArgument("--out");
    const overlayPath = argument("--overlay-out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }, ...(overlayPath ? [{ flag: "--overlay-out", value: overlayPath }] : [])],
      [{ flag: "--input", value: inputPath }, { flag: "--image", value: imagePath }]
    );
    writeJson(outputPath, await validateSheetPixelEvidenceV1({
      image_path: imagePath,
      interpretation: sheetPixelInterpretation(readJson(inputPath)),
      ...(overlayPath ? { overlay_path: overlayPath } : {})
    }));
    return;
  }
  if (command === "plan-registered-route-snap") {
    const inputPath = requiredArgument("--input");
    const contextPath = requiredArgument("--context");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--context", value: contextPath }]
    );
    writeJson(
      outputPath,
      planRegisteredRouteConnectorSnapV1(
        readJson(inputPath) as RegisteredRouteSnapCandidateV1,
        readJson(contextPath) as RegisteredRouteSnapContextV1
      )
    );
    return;
  }
  if (command === "discover-registered-route-frontier") {
    const inputPath = requiredArgument("--input");
    const contextPath = requiredArgument("--context");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }, { flag: "--context", value: contextPath }]
    );
    const context = readJson(contextPath) as {
      native_connector_readback: unknown;
      policy?: Partial<RegisteredRouteFrontierPolicyV1>;
    };
    writeJson(
      outputPath,
      discoverRegisteredRouteFrontierV1(
        readJson(inputPath) as RegisteredRouteFrontierCandidateV1,
        context
      )
    );
    return;
  }
  if (command === "interpret-sheet-gemini") {
    const inputPath = requiredArgument("--input");
    const outputPath = requiredArgument("--out");
    assertFreshDistinctOutputPaths(
      [{ flag: "--out", value: outputPath }],
      [{ flag: "--input", value: inputPath }]
    );
    writeJson(
      outputPath,
      await analyzeExistingConditionsSheetWithGeminiV1(
        readJson(inputPath) as GeminiExistingConditionsSheetRequestV1
      )
    );
    return;
  }
  if (command === "compile-provisional-plan-traces") {
    const inputPath = requiredArgument("--input");
    const contextPath = requiredArgument("--context");
    const planOut = requiredArgument("--out");
    const workflowOut = argument("--workflow-out");
    const outputs = [
      { flag: "--out", value: planOut },
      ...(workflowOut ? [{ flag: "--workflow-out", value: workflowOut }] : [])
    ];
    assertFreshDistinctOutputPaths(outputs, [
      { flag: "--input", value: inputPath },
      { flag: "--context", value: contextPath }
    ]);
    if (workflowOut) {
      if (!process.argv.includes("--allow-unscored-user-workflow")) {
        throw new Error("provisional_plan_trace_workflow_requires_explicit_unscored_user_direction");
      }
    }
    const plan = compileProvisionalPlanTraceDraftV1(
      readJson(inputPath) as ProvisionalPlanTraceDraftInputV1,
      readJson(contextPath) as ProvisionalPlanTraceDraftContext
    );
    let workflow: AtomicMepDraftWorkflowRequest | undefined;
    if (workflowOut && ["ready", "partially_ready"].includes(plan.status)) {
      const expectedCreated = plan.actions.reduce(
        (sum, action) => sum + action.expected_created_max,
        0
      );
      const maxCreated = Number(argument("--max-created") || Math.max(
        1,
        expectedCreated
      ));
      if (!Number.isSafeInteger(maxCreated) || maxCreated < expectedCreated) {
        throw new Error(`provisional_plan_trace_max_created_below_expected:${maxCreated}/${expectedCreated}`);
      }
      workflow = markExplicitUnscoredUserWorkflow(
        buildAtomicMepDraftWorkflowRequest(plan, { maximum_created_elements: maxCreated })
      );
    }
    writeFreshJson(planOut, plan);
    if (workflowOut && workflow) writeFreshJson(workflowOut, workflow);
    return;
  }
  if (command === "compile-registered-mep-observations") {
    const workflowOut = argument("--workflow-out");
    if (workflowOut) assertFreshDistinctOutputPaths([{ flag: "--workflow-out", value: workflowOut }]);
    const input = readJson(requiredArgument("--input"));
    assertExistingConditionsContract("registered_mep_observations", input);
    const compilation = await compileRegisteredMepObservations(input as RegisteredMepObservationPackage);
    writeJson(requiredArgument("--out"), compilation);
    const packageOut = argument("--package-out");
    if (packageOut) writeJson(packageOut, compilation.converted_package);
    if (workflowOut && ["ready", "partially_ready"].includes(compilation.compiled_plan.status)) {
      if (!process.argv.includes("--allow-unscored-user-workflow")) {
        throw new Error("registered_mep_workflow_requires_pre_apply_score_or_explicit_unscored_user_direction");
      }
      const maxCreated = Number(argument("--max-created") || Math.max(1, compilation.compiled_plan.plan_elements.filter((entry) => entry.action === "create").length * 4));
      writeFreshJson(workflowOut, markExplicitUnscoredUserWorkflow(
        buildAtomicMepDraftWorkflowRequest(compilation.compiled_plan, { maximum_created_elements: maxCreated })
      ));
    }
    return;
  }
  if (command === "promote-registered-mep-observations") {
    const inputPath = requiredArgument("--input");
    const truthPath = requiredArgument("--truth");
    const promotionOut = requiredArgument("--out");
    const scoreOut = requiredArgument("--score-out");
    const workflowOut = requiredArgument("--workflow-out");
    assertFreshDistinctOutputPaths([
      { flag: "--out", value: promotionOut },
      { flag: "--score-out", value: scoreOut },
      { flag: "--workflow-out", value: workflowOut }
    ]);
    const protectedInputs = new Set([canonicalPath(inputPath), canonicalPath(truthPath)]);
    for (const [flag, value] of [["--out", promotionOut], ["--score-out", scoreOut], ["--workflow-out", workflowOut]] as const) {
      if (protectedInputs.has(canonicalPath(value))) throw new Error(`${flag} must not overwrite evaluator inputs.`);
    }
    const input = readJson(inputPath);
    assertExistingConditionsContract("registered_mep_observations", input);
    const truth = readJson(truthPath);
    assertExistingConditionsContract("ground_truth", truth);
    const compilation = await compileRegisteredMepObservations(input as RegisteredMepObservationPackage);
    const score = scoreMepPreApplyGeometry(truth as ExistingConditionsGroundTruth, compilation);
    writeFreshJson(scoreOut, score);
    const maxCreated = Number(argument("--max-created") || Math.max(1, compilation.compiled_plan.plan_elements.filter((entry) => entry.action === "create").length * 4));
    const promotion = promoteScoreGatedMepWorkflow(compilation, score, {
      dry_run: !process.argv.includes("--apply"),
      maximum_created_elements: maxCreated
    });
    writeFreshJson(promotionOut, promotion);
    writeFreshJson(workflowOut, promotion.workflow);
    return;
  }
  if (command === "compile-mep-draft") {
    const workflowOut = argument("--workflow-out");
    if (workflowOut) {
      assertFreshDistinctOutputPaths([{ flag: "--workflow-out", value: workflowOut }]);
      if (!process.argv.includes("--allow-unscored-user-workflow")) {
        throw new Error("mep_draft_workflow_requires_pre_apply_score_or_explicit_unscored_user_direction");
      }
    }
    const plan = compileMepDraftPlan(readJson(requiredArgument("--input")) as MepDraftPackage);
    writeJson(requiredArgument("--out"), plan);
    if (workflowOut && ["ready", "partially_ready"].includes(plan.status)) {
      const maxCreated = Number(argument("--max-created") || Math.max(1, plan.plan_elements.filter((entry) => entry.action === "create").length * 4));
      writeFreshJson(workflowOut, markExplicitUnscoredUserWorkflow(
        buildAtomicMepDraftWorkflowRequest(plan, { maximum_created_elements: maxCreated })
      ));
    }
    return;
  }
  if (command === "compile-architectural-shell") {
    const plan = compileArchitecturalShellPlan(readJson(requiredArgument("--input")) as ArchitecturalShellPackage);
    writeJson(requiredArgument("--out"), plan);
    const actionOut = argument("--action-out");
    if (actionOut) {
      if (!plan.action) throw new Error(`Architectural shell plan is ${plan.status}; no action request was emitted.`);
      writeJson(actionOut, process.argv.includes("--apply") ? plan.action.apply_body : plan.action.dry_run_body);
    }
    return;
  }
  if (command === "compile-architectural-preview") {
    const input = readJson(requiredArgument("--input"));
    assertExistingConditionsContract("architectural_preview", input);
    const preview = compileArchitecturalPlanGeometryPreview(input as ArchitecturalPlanGeometryPreviewPackage);
    writeJson(requiredArgument("--out"), preview);
    return;
  }
  if (command === "score-architectural-preview") {
    const truth = readJson(requiredArgument("--truth"));
    assertExistingConditionsContract("ground_truth", truth);
    const score = scoreArchitecturalPlanGeometryPreview(
      truth as ExistingConditionsGroundTruth,
      readJson(requiredArgument("--preview")) as CompiledArchitecturalPlanGeometryPreview
    );
    writeJson(requiredArgument("--out"), score);
    return;
  }
  if (command === "build-architectural-delta") {
    const receipt = await buildArchitecturalSourceDelta(
      readJson(requiredArgument("--input")) as ArchitecturalSourceDeltaInput,
      requiredArgument("--out-dir")
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "compare-calibrated-crops") {
    const receipt = await compareCalibratedExistingConditionsCrops(
      readJson(requiredArgument("--input")) as CalibratedCropComparisonInput,
      requiredArgument("--out-dir")
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "build-architectural-measurement") {
    const deltaReceiptPath = path.resolve(requiredArgument("--delta-receipt"));
    const receipt = await buildArchitecturalMeasurementOverlay(
      readJson(deltaReceiptPath) as ArchitecturalSourceDeltaReceipt,
      sha256(deltaReceiptPath),
      requiredArgument("--out-dir")
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "compile-architectural-pixel-preview") {
    const input = readJson(requiredArgument("--input"));
    assertExistingConditionsContract("architectural_pixel_measurement", input);
    const measurementReceiptPath = path.resolve(requiredArgument("--measurement-receipt"));
    const compilation = compileArchitecturalPixelMeasurementPreview(
      input as ArchitecturalPixelMeasurementPackage,
      readJson(measurementReceiptPath) as ArchitecturalMeasurementOverlayReceipt,
      sha256(measurementReceiptPath)
    );
    writeJson(requiredArgument("--out"), compilation.compiled_preview);
    const sourceOut = argument("--source-out");
    if (sourceOut) writeJson(sourceOut, compilation.converted_source_package);
    const compilationOut = argument("--compilation-out");
    if (compilationOut) writeJson(compilationOut, compilation);
    return;
  }
  if (command === "build-architectural-wall-candidates") {
    const deltaReceiptPath = path.resolve(requiredArgument("--delta-receipt"));
    const measurementReceiptPath = path.resolve(requiredArgument("--measurement-receipt"));
    const receipt = await buildArchitecturalWallLineCandidates(
      readJson(deltaReceiptPath) as ArchitecturalSourceDeltaReceipt,
      sha256(deltaReceiptPath),
      readJson(measurementReceiptPath) as ArchitecturalMeasurementOverlayReceipt,
      sha256(measurementReceiptPath),
      requiredArgument("--out-dir")
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  if (command === "validate-architectural-opening-classification") {
    const candidateReceiptPath = path.resolve(requiredArgument("--candidate-receipt"));
    const candidates = readJson(candidateReceiptPath) as ArchitecturalWallLineCandidateReceipt;
    const classification = readJson(requiredArgument("--classification")) as ArchitecturalOpeningClassificationReceipt;
    assertExistingConditionsContract("architectural_opening_classification", classification);
    validateArchitecturalOpeningClassification(classification, candidates, sha256(candidateReceiptPath));
    writeJson(requiredArgument("--out"), classification);
    return;
  }
  if (command === "score-architectural-opening-classification") {
    const truth = readJson(requiredArgument("--truth"));
    assertExistingConditionsContract("ground_truth", truth);
    const candidateReceiptPath = path.resolve(requiredArgument("--candidate-receipt"));
    const classification = readJson(requiredArgument("--classification")) as ArchitecturalOpeningClassificationReceipt;
    assertExistingConditionsContract("architectural_opening_classification", classification);
    const score = scoreArchitecturalOpeningClassification(
      truth as ExistingConditionsGroundTruth,
      readJson(candidateReceiptPath) as ArchitecturalWallLineCandidateReceipt,
      sha256(candidateReceiptPath),
      classification
    );
    writeJson(requiredArgument("--out"), score);
    if (!score.passed) process.exitCode = 1;
    return;
  }
  if (command === "validate-architectural-door-span") {
    const deltaReceiptPath = path.resolve(requiredArgument("--delta-receipt"));
    const candidateReceiptPath = path.resolve(requiredArgument("--candidate-receipt"));
    const classificationPath = path.resolve(requiredArgument("--classification"));
    const deltaArtifact = readJsonWithSha256(deltaReceiptPath);
    const candidateArtifact = readJsonWithSha256(candidateReceiptPath);
    const classificationArtifact = readJsonWithSha256(classificationPath);
    const classification = classificationArtifact.value as ArchitecturalOpeningClassificationReceipt;
    assertExistingConditionsContract("architectural_opening_classification", classification);
    const receipt = await buildArchitecturalDoorSpanObservationReceipt(
      readJson(requiredArgument("--observation")) as ArchitecturalDoorSpanObservationPackage,
      deltaArtifact.value as ArchitecturalSourceDeltaReceipt,
      deltaArtifact.sha256,
      candidateArtifact.value as ArchitecturalWallLineCandidateReceipt,
      candidateArtifact.sha256,
      classification,
      classificationArtifact.sha256
    );
    assertExistingConditionsContract("architectural_door_span_observation", receipt);
    writeJson(requiredArgument("--out"), receipt);
    if (receipt.status !== "measured") process.exitCode = 1;
    return;
  }
  if (command === "resolve-architectural-opening-hosts") {
    const candidateReceiptPath = path.resolve(requiredArgument("--candidate-receipt"));
    const classificationPath = path.resolve(requiredArgument("--classification"));
    const classification = readJson(classificationPath) as ArchitecturalOpeningClassificationReceipt;
    assertExistingConditionsContract("architectural_opening_classification", classification);
    const resolution = resolveArchitecturalOpeningHosts(
      readJson(candidateReceiptPath) as ArchitecturalWallLineCandidateReceipt,
      sha256(candidateReceiptPath),
      classification,
      sha256(classificationPath)
    );
    assertExistingConditionsContract("architectural_opening_host_resolution", resolution);
    writeJson(requiredArgument("--out"), resolution);
    if (resolution.status !== "resolved") process.exitCode = 1;
    return;
  }
  if (command === "score-architectural-opening-hosts") {
    const truth = readJson(requiredArgument("--truth"));
    assertExistingConditionsContract("ground_truth", truth);
    const candidateReceiptPath = path.resolve(requiredArgument("--candidate-receipt"));
    const classificationPath = path.resolve(requiredArgument("--classification"));
    const candidates = readJson(candidateReceiptPath) as ArchitecturalWallLineCandidateReceipt;
    const classification = readJson(classificationPath) as ArchitecturalOpeningClassificationReceipt;
    assertExistingConditionsContract("architectural_opening_classification", classification);
    const resolution = readJson(requiredArgument("--resolution")) as ArchitecturalOpeningHostResolutionReceipt;
    assertExistingConditionsContract("architectural_opening_host_resolution", resolution);
    const score = scoreArchitecturalOpeningHostResolution(
      truth as ExistingConditionsGroundTruth,
      candidates,
      sha256(candidateReceiptPath),
      classification,
      sha256(classificationPath),
      resolution
    );
    writeJson(requiredArgument("--out"), score);
    if (!score.passed) process.exitCode = 1;
    return;
  }
  if (command === "audit-architectural-redaction") {
    const truth = readJson(requiredArgument("--truth"));
    assertExistingConditionsContract("ground_truth", truth);
    const receipt = await auditArchitecturalRedactionVisibility(
      truth as ExistingConditionsGroundTruth,
      readJson(requiredArgument("--delta-receipt")) as ArchitecturalSourceDeltaReceipt
    );
    writeJson(requiredArgument("--out"), receipt);
    if (!receipt.passed) process.exitCode = 1;
    return;
  }
  if (command === "audit-linked-background") {
    const configuredTokens = argument("--link-name-tokens");
    const receipt = auditLinkedBackgroundModelHealth(
      readJson(requiredArgument("--model-health")),
      configuredTokens
        ? {
          ...DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY,
          expected_name_tokens: parseCsv(configuredTokens, "--link-name-tokens")
        }
        : DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY
    );
    writeJson(requiredArgument("--out"), receipt);
    if (!receipt.passed) process.exitCode = 1;
    return;
  }
  if (command === "promote-architectural-preview") {
    const input = readJson(requiredArgument("--input"));
    assertExistingConditionsContract("architectural_preview", input);
    const truth = readJson(requiredArgument("--truth"));
    assertExistingConditionsContract("ground_truth", truth);
    const compiledPreview = compileArchitecturalPlanGeometryPreview(input as ArchitecturalPlanGeometryPreviewPackage);
    const score = scoreArchitecturalPlanGeometryPreview(
      truth as ExistingConditionsGroundTruth,
      compiledPreview
    );
    const scoreOut = argument("--score-out");
    if (scoreOut) writeJson(scoreOut, score);
    const catalogPath = argument("--catalog");
    const signalsPath = argument("--mapping-signals");
    if (!!catalogPath !== !!signalsPath) {
      throw new Error("architectural_precedent_catalog_and_mapping_signals_must_be_supplied_together");
    }
    const promotion = catalogPath && signalsPath
      ? promoteArchitecturalPlanGeometryWithCatalog(
        input as ArchitecturalPlanGeometryPreviewPackage,
        readJson(catalogPath) as ArchitecturalPrecedentCatalog,
        readJson(signalsPath) as ArchitecturalPrecedentSignal[],
        { plan_geometry_score: score }
      )
      : promoteArchitecturalPlanGeometryPreview(
        input as ArchitecturalPlanGeometryPreviewPackage,
        readJson(requiredArgument("--resolutions")) as ArchitecturalPlanGeometryResolution[],
        { plan_geometry_score: score }
      );
    writeJson(requiredArgument("--out"), promotion);
    const actionOut = argument("--action-out");
    if (actionOut) {
      if (!promotion.compiled_plan.action) {
        throw new Error(`Promoted architectural shell plan is ${promotion.compiled_plan.status}; no action request was emitted.`);
      }
      writeJson(actionOut, process.argv.includes("--apply")
        ? promotion.compiled_plan.action.apply_body
        : promotion.compiled_plan.action.dry_run_body);
    }
    return;
  }
  if (command === "redact") {
    await runRedaction();
    return;
  }
  if (command === "capture") {
    await captureNativeSnapshot();
    return;
  }
  if (command === "package") {
    buildAgentPackage();
    return;
  }
  if (command === "seal-truth") {
    sealGroundTruth();
    return;
  }
  if (command === "seal-candidate") {
    sealCandidate();
    return;
  }
  if (command === "evaluator-review-visual") {
    reviewVisualEvidence();
    return;
  }
  if (command === "validate-contract") {
    validateContractFile();
    return;
  }
  if (command === "score") {
    scoreSealedCandidate();
    return;
  }
  if (command === "evaluate-engineering-case") {
    evaluateEngineeringCaseFile();
    return;
  }
  if (command === "seal-engineering-evidence") {
    sealEngineeringEvidenceFile();
    return;
  }
  if (command === "collect-gfci-native-evidence") {
    collectGfciNativeEvidenceFile();
    return;
  }
  if (command === "capture-gfci-native-evidence") {
    await captureGfciNativeEvidence();
    return;
  }
  if (command === "collect-dwelling-wall-native-evidence") {
    collectDwellingWallCoverageNativeEvidenceFile();
    return;
  }
  if (command === "capture-dwelling-wall-native-evidence") {
    await captureDwellingWallCoverageNativeEvidence();
    return;
  }
  if (command === "collect-circuit-loading-native-evidence") {
    collectCircuitLoadingNativeEvidenceFile();
    return;
  }
  if (command === "capture-circuit-loading-native-evidence") {
    await captureCircuitLoadingNativeEvidence();
    return;
  }
  if (command === "collect-plumbing-fixture-services-native-evidence") {
    collectPlumbingFixtureServicesNativeEvidenceFile();
    return;
  }
  if (command === "capture-plumbing-fixture-services-native-evidence") {
    await capturePlumbingFixtureServicesNativeEvidence();
    return;
  }
  if (command === "advance-controller") {
    advanceController();
    return;
  }
  if (command === "evaluator-diff") {
    const receipt = createExistingConditionsEvaluatorChangeReceipt(
      readJson(requiredArgument("--before-visible")),
      readJson(requiredArgument("--after-visible")),
      readJson(requiredArgument("--package"))
    );
    writeJson(requiredArgument("--out"), receipt);
    return;
  }
  usage();
}

await main();
