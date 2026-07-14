import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  normalizeExistingConditionsSnapshot,
  mergeExistingConditionsVisibleElementPayloads,
  scoreExistingConditionsReconstruction,
  type ExistingConditionsCandidate,
  type ExistingConditionsGroundTruth,
  type ExistingConditionsSnapshot
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
  type MepDraftPackage
} from "../existing_conditions/mep_draft_plan.js";
import {
  compileArchitecturalShellPlan,
  type ArchitecturalShellPackage
} from "../existing_conditions/architectural_shell_plan.js";

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

function writeJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`${resolved}\n`);
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run existing-conditions -- normalize --visible <export-visible-elements.json> --connectors <get-connectors.json> --ids <id,id,...> --out <snapshot.json>",
    "  npm run existing-conditions -- compile-mep-draft --input <source-observations.json> --out <compiled-plan.json> [--workflow-out <atomic-dry-run-request.json>] [--max-created <count>]",
    "  npm run existing-conditions -- compile-architectural-shell --input <source-observations.json> --out <compiled-plan.json> [--action-out <atomic-import-request.json>] [--apply]",
    "  npm run existing-conditions -- capture --expected-model <model.rvt> (--view-id <id> | --view-ids <id,id,...>) --ids <id,id,...> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- package --fixture-id <id> --scope-id <id> --discipline <mechanical|plumbing|electrical|architectural|mixed> --task-class <exact_reconstruction|standards_compliance_repair|generative_layout> [--standards-profile <json>] --redacted-model <agent-redacted.rvt> --source-pdf <source.pdf> --view-id <id> --model-bounds <minX,minY,minZ,maxX,maxY,maxZ> --image-region <minX,minY,maxX,maxY> --allowed-categories <OST_...,OST_...> --out-dir <agent-dir>",
    "  npm run existing-conditions -- seal-truth --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --ground-truth-model <source.rvt> --deletion-manifest <json> --delete-dry-run <json> --out <truth.json>",
    "  npm run existing-conditions -- evaluator-review-visual --post-capture <image> --post-pdf <pdf> --status <pass|needs_review|fail> --out <receipt.json>",
    "  npm run existing-conditions -- seal-candidate --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --evaluator-visual-receipt <json> --out <candidate.json>",
    "  npm run existing-conditions -- score --package <agent_package.json> [--truth <truth.json> --candidate <candidate.json> | --evaluator-checks <json> --evaluator-change-receipt <json> --evaluator-access-provenance <json> --constructability <pass|fail> --drawing-legibility <pass|fail>] --out-dir <score-dir>",
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
    "  npm run existing-conditions -- validate-contract --kind <agent_package|ground_truth|candidate> --file <json>",
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

async function captureNativeSnapshot(): Promise<void> {
  const expectedModel = path.resolve(requiredArgument("--expected-model"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewIds = argument("--view-ids")
    ? parseIds(argument("--view-ids"))
    : [Number(requiredArgument("--view-id"))];
  const ids = parseIds(requiredArgument("--ids"));
  if (viewIds.some((viewId) => !Number.isInteger(viewId) || viewId <= 0)) {
    throw new Error("--view-id/--view-ids must contain positive integers.");
  }
  if (!fs.existsSync(expectedModel)) throw new Error(`Expected model does not exist: ${expectedModel}`);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty capture directory: ${outDir}`);
  }
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  const categories = argument("--categories")
    ? parseCsv(argument("--categories"), "--categories")
    : DEFAULT_EXISTING_CONDITIONS_CATEGORIES;
  const visibleByView: unknown[] = [];
  for (const viewId of viewIds) {
    visibleByView.push(await client.post("/revit/export-visible-elements", {
      viewId,
      imageSize: 3000,
      includeMapping: true,
      includeGeometry: true,
      includeLinked: false,
      limit: 2000,
      categories
    }));
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
    model_path: expectedModel,
    model_sha256: sha256(expectedModel),
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
  if (taskClass !== "exact_reconstruction" && (!standardsProfileSource || !fs.existsSync(path.resolve(standardsProfileSource)))) {
    throw new Error("--standards-profile must identify an existing JSON file for compliance and generative tasks.");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const pdfCopy = path.join(outDir, "source_evidence.pdf");
  const packagePath = path.join(outDir, "agent_package.json");
  const controllerStatePath = path.join(outDir, "controller_state.json");
  const standardsProfileCopy = path.join(outDir, "standards_profile.json");
  if (fs.existsSync(pdfCopy) || fs.existsSync(packagePath) || fs.existsSync(controllerStatePath)
    || (taskClass !== "exact_reconstruction" && fs.existsSync(standardsProfileCopy))) {
    throw new Error(`Refusing to overwrite an existing agent package in: ${outDir}`);
  }
  fs.copyFileSync(sourcePdf, pdfCopy, fs.constants.COPYFILE_EXCL);
  if (taskClass !== "exact_reconstruction") {
    fs.copyFileSync(path.resolve(standardsProfileSource), standardsProfileCopy, fs.constants.COPYFILE_EXCL);
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
    evidence: [{
      role: "source_pdf",
      path: pdfCopy,
      sha256: sha256(pdfCopy),
      page: Number(argument("--pdf-page") || "1")
    }],
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
    visible_evidence: [{ role: "source_pdf", sha256: sha256(pdfCopy) }],
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
  if (!["agent_package", "ground_truth", "candidate"].includes(kind)) {
    throw new Error("--kind must be agent_package, ground_truth, or candidate.");
  }
  const filePath = path.resolve(requiredArgument("--file"));
  assertExistingConditionsContract(kind as "agent_package" | "ground_truth" | "candidate", readJson(filePath));
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
  const result = scoreExistingConditionsReconstruction(truth, candidate);
  writeJson(path.join(outDir, "existing_conditions_score.json"), result);
  const lines = [
    `# Existing conditions reconstruction - ${result.fixture_id}`,
    "",
    `- Scope: ${result.scope_id}`,
    `- Valid run: ${result.valid_run ? "yes" : "no"}`,
    `- Passed: ${result.passed ? "yes" : "no"}`,
    `- Score: ${result.score.toFixed(3)} / 100`,
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
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (!fs.existsSync(expectedSource)) throw new Error(`Expected source does not exist: ${expectedSource}`);
  if (canonicalPath(expectedSource) === canonicalPath(stagingModel) || canonicalPath(expectedSource) === canonicalPath(redactedModel)) {
    throw new Error("Source, staging, and redacted model paths must be distinct.");
  }
  if (canonicalPath(stagingModel) === canonicalPath(redactedModel)) throw new Error("Staging and redacted model paths must be distinct.");
  if ((!resumeStaging && fs.existsSync(stagingModel)) || fs.existsSync(redactedModel)) throw new Error("Refusing to overwrite an existing staging or redacted model.");
  if (resumeStaging && !fs.existsSync(stagingModel)) throw new Error("--resume-staging requires an existing staging model.");
  const withheldDir = path.join(outDir, "withheld");
  const agentDir = path.join(outDir, "agent");
  fs.mkdirSync(withheldDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const client = bridgeClient();
  const sourceContext = await client.get("/revit/context");
  const expectedActivePath = resumeStaging ? stagingModel : expectedSource;
  if (canonicalPath(activeDocumentPath(sourceContext)) !== canonicalPath(expectedActivePath)) {
    throw new Error(`Active document is not the expected ${resumeStaging ? "staging model" : "source"}: ${activeDocumentPath(sourceContext)}`);
  }
  const stagingPlan = resumeStaging
    ? { status: "Skipped", reason: "resume_staging" }
    : await client.post("/revit/save-as", {
      filePath: stagingModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: true
    }, true);
  const stagingSave = resumeStaging
    ? { status: "Skipped", reason: "resume_staging", path: stagingModel }
    : await client.post("/revit/save-as", {
      filePath: stagingModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: false
    }, true);
  const stagingContext = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(stagingContext)) !== canonicalPath(stagingModel)) {
    throw new Error(`Save As did not activate the staging model: ${activeDocumentPath(stagingContext)}`);
  }
  const deletePlan = await client.post("/revit/delete", { ids, apply: false }, true);
  const plannedDeleteIds = responseIds(deletePlan);
  const requested = [...ids].sort((a, b) => a - b);
  const dependentIds = plannedDeleteIds.filter((id) => !requested.includes(id));
  if (!process.argv.includes("--allow-dependent-deletes") && dependentIds.length > 0) {
    throw new Error(`Delete dry-run included dependent IDs: ${dependentIds.join(",")}`);
  }
  if (requested.some((id) => !plannedDeleteIds.includes(id))) throw new Error("Delete dry-run did not cover every requested ID.");
  const deleteApply = await client.post("/revit/delete", { ids, apply: true }, true);
  const appliedDeleteIds = responseIds(deleteApply);
  if (JSON.stringify(appliedDeleteIds) !== JSON.stringify(plannedDeleteIds)) {
    throw new Error(`Delete apply IDs differ from dry-run IDs: planned=${plannedDeleteIds.join(",")} applied=${appliedDeleteIds.join(",")}`);
  }
  const finalPlan = await client.post("/revit/save-as", {
    filePath: redactedModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: true
  }, true);
  const finalSave = await client.post("/revit/save-as", {
    filePath: redactedModel, overwrite: false, compact: true, maximumBackups: 1, dryRun: false
  }, true);
  const finalContext = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(finalContext)) !== canonicalPath(redactedModel)) {
    throw new Error(`Final Save As did not activate the redacted model: ${activeDocumentPath(finalContext)}`);
  }
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
  writeJson(path.join(withheldDir, "redaction_manifest.json"), {
    schema_version: 1,
    expected_source: expectedSource,
    source_sha256: sha256(expectedSource),
    staging_model: stagingModel,
    redacted_model: redactedModel,
    redacted_model_sha256: sha256(redactedModel),
    requested_element_ids: requested,
    deleted_element_ids: appliedDeleteIds,
    dependent_element_ids: dependentIds,
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
  if (command === "compile-mep-draft") {
    const plan = compileMepDraftPlan(readJson(requiredArgument("--input")) as MepDraftPackage);
    writeJson(requiredArgument("--out"), plan);
    const workflowOut = argument("--workflow-out");
    if (workflowOut && plan.status === "ready") {
      const maxCreated = Number(argument("--max-created") || Math.max(1, plan.plan_elements.filter((entry) => entry.action === "create").length * 4));
      writeJson(workflowOut, buildAtomicMepDraftWorkflowRequest(plan, { maximum_created_elements: maxCreated }));
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
