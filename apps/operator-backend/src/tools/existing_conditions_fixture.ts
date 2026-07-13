import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  normalizeExistingConditionsSnapshot,
  scoreExistingConditionsReconstruction,
  type ExistingConditionsCandidate,
  type ExistingConditionsGroundTruth,
  type ExistingConditionsSnapshot
} from "../benchmark/existing_conditions_reconstruction.js";

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
    "  npm run existing-conditions -- capture --expected-model <model.rvt> --view-id <id> --ids <id,id,...> --out-dir <capture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "  npm run existing-conditions -- package --fixture-id <id> --scope-id <id> --redacted-model <agent-redacted.rvt> --source-pdf <source.pdf> --view-id <id> --out-dir <agent-dir>",
    "  npm run existing-conditions -- seal-truth --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --out <truth.json>",
    "  npm run existing-conditions -- seal-candidate --fixture-id <id> --scope-id <id> --snapshot <snapshot.json> --source-pdf <source.pdf> --post-capture <image> --post-pdf <pdf> --out <candidate.json>",
    "  npm run existing-conditions -- score --truth <truth.json> --candidate <candidate.json> --out-dir <score-dir>",
    "  npm run existing-conditions -- redact --expected-source <source.rvt> --staging-model <withheld-staging.rvt> --redacted-model <agent-redacted.rvt> --view-id <id> --ids <id,id,...> --anchor-ids <id,id,...> --out-dir <fixture-dir> --token-file <operator_token.txt> --grant-file <write_grant.json>",
    "Options:",
    "  --allow-missing-connectors  Permit non-MEP normalization without connector readback.",
    "  --allow-dependent-deletes   Permit the delete dry-run to include IDs beyond --ids.",
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
  const viewId = Number(requiredArgument("--view-id"));
  const ids = parseIds(requiredArgument("--ids"));
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (!fs.existsSync(expectedModel)) throw new Error(`Expected model does not exist: ${expectedModel}`);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty capture directory: ${outDir}`);
  }
  const client = bridgeClient();
  const context = await client.get("/revit/context");
  if (canonicalPath(activeDocumentPath(context)) !== canonicalPath(expectedModel)) {
    throw new Error(`Active document is not the expected model: ${activeDocumentPath(context)}`);
  }
  const visible = await client.post("/revit/export-visible-elements", {
    viewId,
    imageSize: 3000,
    includeMapping: true,
    includeGeometry: true,
    includeLinked: false,
    limit: 2000,
    categories: ["OST_DuctCurves", "OST_DuctFitting", "OST_DuctAccessory", "OST_MechanicalEquipment", "OST_DuctTerminal", "OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory", "OST_PlumbingFixtures"]
  });
  const connectors = await client.post("/revit/get-connectors", {
    elementIds: ids,
    includeAllRefs: true,
    includeCoordinateSystem: true
  });
  const snapshot = normalizeExistingConditionsSnapshot(visible, connectors, {
    selected_element_ids: ids,
    require_connector_readback: !process.argv.includes("--allow-missing-connectors")
  });
  writeJson(path.join(outDir, "context.json"), context);
  writeJson(path.join(outDir, "visible_elements.json"), visible);
  writeJson(path.join(outDir, "connectors.json"), connectors);
  writeJson(path.join(outDir, "snapshot.json"), snapshot);
  writeJson(path.join(outDir, "capture_receipt.json"), {
    schema_version: 1,
    model_path: expectedModel,
    model_sha256: sha256(expectedModel),
    view_id: viewId,
    selected_element_count: ids.length,
    native_readback: true
  });
}

function buildAgentPackage(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const redactedModel = path.resolve(requiredArgument("--redacted-model"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const outDir = path.resolve(requiredArgument("--out-dir"));
  const viewId = Number(requiredArgument("--view-id"));
  if (!Number.isInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive integer.");
  if (!fs.existsSync(redactedModel)) throw new Error(`Redacted model does not exist: ${redactedModel}`);
  if (!fs.existsSync(sourcePdf)) throw new Error(`Source PDF does not exist: ${sourcePdf}`);
  fs.mkdirSync(outDir, { recursive: true });
  const pdfCopy = path.join(outDir, "source_evidence.pdf");
  const packagePath = path.join(outDir, "agent_package.json");
  if (fs.existsSync(pdfCopy) || fs.existsSync(packagePath)) {
    throw new Error(`Refusing to overwrite an existing agent package in: ${outDir}`);
  }
  fs.copyFileSync(sourcePdf, pdfCopy, fs.constants.COPYFILE_EXCL);
  writeJson(packagePath, {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    task: "Reconstruct missing existing-condition MEP work from the plotted PDF evidence in the currently open redacted model.",
    redacted_model: {
      role: "redacted_model",
      path: redactedModel,
      sha256: sha256(redactedModel)
    },
    visible_evidence: [{
      role: "source_pdf",
      path: pdfCopy,
      sha256: sha256(pdfCopy)
    }],
    scope: {
      view_id: viewId,
      description: "M104 / Level 4 / Unit 403",
      allowed_categories: ["Ducts", "Duct Fittings"]
    },
    policy: {
      forbidden_artifact_roles: ["ground_truth_model", "ground_truth_snapshot", "deletion_manifest", "withheld_evaluator_package"],
      allowed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
      require_dry_run_before_apply: true,
      require_native_readback: true,
      require_post_change_visual_receipt: true,
      reject_out_of_scope_writes: true
    },
    output_contract: {
      created_element_ids: "positive integer array",
      accessed_artifact_roles: "string array",
      out_of_scope_changed_element_keys: "string array",
      reconstruction_notes: "brief string"
    }
  });
}

function sealGroundTruth(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const snapshotPath = path.resolve(requiredArgument("--snapshot"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const outPath = path.resolve(requiredArgument("--out"));
  if (canonicalPath(outPath).includes("/agent/")) {
    throw new Error("Ground truth must not be written into an agent-visible directory.");
  }
  const truth: ExistingConditionsGroundTruth = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    visible_evidence: [{ role: "source_pdf", sha256: sha256(sourcePdf) }],
    snapshot: readJson(snapshotPath) as ExistingConditionsSnapshot
  };
  writeJson(outPath, truth);
}

function sealCandidate(): void {
  const fixtureId = requiredArgument("--fixture-id");
  const scopeId = requiredArgument("--scope-id");
  const snapshotPath = path.resolve(requiredArgument("--snapshot"));
  const sourcePdf = path.resolve(requiredArgument("--source-pdf"));
  const postCapture = path.resolve(requiredArgument("--post-capture"));
  const postPdf = path.resolve(requiredArgument("--post-pdf"));
  const candidate: ExistingConditionsCandidate = {
    schema_version: 1,
    fixture_id: fixtureId,
    scope_id: scopeId,
    visible_evidence: [{ role: "source_pdf", sha256: sha256(sourcePdf) }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    snapshot: readJson(snapshotPath) as ExistingConditionsSnapshot,
    visual_receipt: {
      post_change_capture_sha256: sha256(postCapture),
      post_change_pdf_sha256: sha256(postPdf),
      review_status: "pass"
    }
  };
  writeJson(requiredArgument("--out"), candidate);
}

function scoreSealedCandidate(): void {
  const truth = readJson(requiredArgument("--truth")) as ExistingConditionsGroundTruth;
  const candidate = readJson(requiredArgument("--candidate")) as ExistingConditionsCandidate;
  const outDir = path.resolve(requiredArgument("--out-dir"));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Refusing to overwrite a non-empty score directory: ${outDir}`);
  }
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
    categories: ["OST_DuctCurves", "OST_DuctFitting", "OST_DuctAccessory", "OST_MechanicalEquipment", "OST_DuctTerminal"]
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
  if (command === "score") {
    scoreSealedCandidate();
    return;
  }
  usage();
}

await main();
