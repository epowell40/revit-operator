import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getWorkspaceRoot } from "./workspace.js";

export const DYNAMIC_REVIT_PROGRAM_RUN_V1 = "revit-operator.dynamic-revit-program-run.v1" as const;

export type DynamicRevitProgramRunInput = {
  source: string;
  mode: "preview" | "apply";
  target_revit_year?: "2023" | "2024" | "2025" | "2026";
  category?: string;
  parameters?: string[];
  snapshot_limit?: number;
  operation_budget?: number;
  worker_deadline_ms?: number;
  apply_deadline_ms?: number;
  result_reference?: DynamicResultReferenceRunInput;
  resume?: DynamicExecutionResumeInput;
  continue_from_checkpoint?: DynamicCheckpointContinuationInput;
};

export type DynamicExecutionResumeInput = {
  prior_run_id: string;
  prior_evidence_sha256: string;
  mode: "facts" | "repair" | "retry";
};

export type DynamicCheckpointContinuationInput = {
  prior_run_id: string;
  prior_evidence_sha256: string;
  prior_checkpoint_sha256: string;
};

export type DynamicBuildingSystemsSelectorInput = {
  element_unique_ids?: string[];
  category_stable_ids?: string[];
  kinds?: Array<"mep_curve" | "equipment" | "device" | "accessory" | "system" | "text_note" | "independent_tag">;
  parameter_names?: string[];
  include_type_parameters?: boolean;
  page_size?: number;
};

export type DynamicEffectBudgetInput = {
  budget_id: string;
  target_document_fingerprints: string[];
  allowed_categories: string[];
  explicit_target_unique_ids: string[];
  allowed_sdk_domains: string[];
  allowed_external_effect_classes?: string[];
  view_scope_hash: string;
  level_scope_hash: string;
  workset_scope_hash: string;
  phase_scope_hash: string;
  maximum_operation_count: number;
  maximum_affected_elements: number;
  maximum_creates: number;
  maximum_modifications: number;
  maximum_deletes: number;
  maximum_execution_milliseconds: number;
  maximum_regenerations: number;
  maximum_output_count: number;
  maximum_output_bytes: number;
  file_capability_set_hash: string;
};

export type DynamicResultReferenceRunInput = {
  selector: DynamicBuildingSystemsSelectorInput;
  target_unique_ids?: string[];
  effect_budget: DynamicEffectBudgetInput;
};

type Executor = (file: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Local/development only. The bridge independently enforces its exact laboratory-mode gate and write authority. */
export async function runDynamicRevitProgram(input: DynamicRevitProgramRunInput, env: NodeJS.ProcessEnv = process.env, execute: Executor = executeFile) {
  const mode = (env.REVIT_OPERATOR_MODE || "development").trim().toLowerCase();
  if (!new Set(["local", "development", "self_hosted"]).has(mode)) throw new Error("Dynamic Revit program execution is unavailable outside local/development/self-hosted mode.");
  if (!input || typeof input.source !== "string" || input.source.length < 1 || input.source.length > 128_000 || input.source.includes("\0")) throw new Error("Dynamic Revit program source is invalid or exceeds 128,000 characters.");
  if (input.mode !== "preview" && input.mode !== "apply") throw new Error("Dynamic Revit program mode must be preview or apply.");
  if (input.category !== undefined && !/^OST_[A-Za-z0-9_]{1,120}$/.test(input.category)) throw new Error("Dynamic snapshot category must be a bounded BuiltInCategory token.");
  const parameters = input.parameters ?? [];
  if (!Array.isArray(parameters) || parameters.length > 16 || parameters.some(value => typeof value !== "string" || value.length < 1 || value.length > 128)) throw new Error("Dynamic snapshot parameters are invalid.");
  const normalizedSource = input.source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const sourceHash = sha256(Buffer.from(normalizedSource, "utf8"));
  const resultReference = input.result_reference === undefined ? undefined : normalizeResultReference(input.result_reference);
  const supervisor = requiredFile(env.OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH, "OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH");
  const workerDirectory = requiredDirectory(env.OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY, "OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY");
  const tokenFile = requiredFile(env.OPERATOR_TOKEN_FILE, "OPERATOR_TOKEN_FILE");
  const year = input.target_revit_year ?? boundedYear(env.OPERATOR_DYNAMIC_RUNTIME_REVIT_YEAR || "2024");
  const runId = `dynamic-${randomUUID().replaceAll("-", "")}`;
  const workspaceRoot = getWorkspaceRoot();
  const runsRoot = path.join(workspaceRoot, "artifacts", "dynamic-runtime-runs");
  ensureRunsRoot(workspaceRoot, runsRoot);
  if (input.resume !== undefined && input.continue_from_checkpoint !== undefined) throw new Error("Dynamic retry/repair and committed-checkpoint continuation are mutually exclusive.");
  const checkpoint = input.continue_from_checkpoint === undefined ? undefined : loadCheckpoint(input.continue_from_checkpoint, runsRoot);
  const resume = input.resume === undefined ? undefined : loadResume(input.resume, runsRoot, sourceHash, input.mode,
    resultReference ? "result_reference" : "legacy", resultReference?.selector);
  const activeCheckpoint = checkpoint ?? (resume?.receipt.checkpoint_parent ? loadCheckpointParent(resume.receipt.checkpoint_parent, runsRoot) : undefined);
  const runRoot = path.join(runsRoot, runId);
  fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  if (!fs.lstatSync(runRoot).isDirectory() || fs.lstatSync(runRoot).isSymbolicLink()) throw new Error("Dynamic run directory is not a private regular directory.");
  const sourceFile = path.join(runRoot, "program.cs"); const configFile = path.join(runRoot, "task.json"); const evidenceFile = path.join(runRoot, "evidence.json");
  fs.writeFileSync(sourceFile, normalizedSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const config = {
    workerDirectory, evidencePath: evidenceFile, bridgeUrl: env.OPERATOR_REVIT_URL || "http://127.0.0.1:5000",
    operatorTokenFile: tokenFile, sourceFile, targetRevitYear: year, category: input.category ?? null,
    limit: boundedInteger(input.snapshot_limit, 1, 1000, 200), parameters, operationBudget: boundedInteger(input.operation_budget, 1, 256, 32),
    workerDeadlineMs: boundedInteger(input.worker_deadline_ms, 1000, 30_000, 15_000), apply: input.mode === "apply",
    applyDeadlineMs: boundedInteger(input.apply_deadline_ms, 100, 5000, 5000),
    ...(resultReference ? {
      resultReference: true,
      requireExecutionTrace: true,
      buildingSystemsSelector: resultReference.selector,
      resultReferenceTargetUniqueIds: resultReference.targetUniqueIds,
      resultReferenceEffectBudget: resultReference.effectBudget
    } : {}),
    ...(activeCheckpoint ? {
      checkpointTaskSessionId: activeCheckpoint.receipt.task_session_id, checkpointIndex: activeCheckpoint.receipt.checkpoint_index,
      checkpointHash: activeCheckpoint.receipt.checkpoint_sha256, checkpointDocumentFingerprint: activeCheckpoint.receipt.document_fingerprint,
      checkpointDocumentSessionId: activeCheckpoint.receipt.document_session_id, checkpointApplyReceiptHash: activeCheckpoint.receipt.apply_receipt_sha256
    } : {})
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const execution = await execute(supervisor, ["--execute-task", configFile], Math.max(config.workerDeadlineMs + 90_000, 120_000));
  if (!fs.existsSync(evidenceFile)) throw new Error(`Dynamic supervisor returned ${execution.exitCode} without bounded evidence: ${execution.stderr.slice(0, 2000)}`);
  const evidenceBytes = readAnchoredRegularFile(evidenceFile, runRoot, 8 * 1024 * 1024);
  const evidenceSha256 = sha256(evidenceBytes);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as Record<string, unknown>;
  if (activeCheckpoint) validateCheckpointEcho(evidence, activeCheckpoint.receipt);
  const executionStatus = evidence.schema === "dynamic-revit-needs-facts-evidence/v1"
    ? "needs_facts"
    : execution.exitCode === 0 && evidence.ok === true ? "completed" : "failed";
  const emittedSourceHash = workerString(evidence, "sourceHash");
  if ((executionStatus === "completed" || executionStatus === "needs_facts") && emittedSourceHash === null)
    throw new Error("Successful worker evidence omitted its normalized source identity.");
  if (emittedSourceHash !== null && emittedSourceHash !== sourceHash) throw new Error("Worker evidence is not bound to the submitted source bytes.");
  const emittedStatus = workerString(evidence, "executionStatus");
  if (emittedStatus !== null && emittedStatus !== executionStatus) throw new Error("Worker and supervisor execution statuses disagree.");
  const continuation = executionStatus === "needs_facts" ? continuationFromEvidence(evidence) : undefined;
  const structuredDiagnostics = diagnosticsFromEvidence(evidence, execution.stderr);
  const stepPlan = executionStepPlan(evidence);
  const iteration = createIterationReceipt({ runId, sourceHash, requestedMode: input.mode,
    lane: resultReference ? "result_reference" : "legacy", executionStatus, evidenceSha256,
    executionIdentityHash: workerString(evidence, "executionIdentityHash"),
    diagnosticBundleHash: workerString(evidence, "diagnosticBundleHash"),
    factRequestHash: continuation === undefined ? null : String(continuation.fact_request.requestHash),
    retryable: structuredDiagnostics.some(diagnostic => diagnostic.retryable), diagnostics: structuredDiagnostics, resume,
    checkpointParent: activeCheckpoint?.parent ?? null });
  fs.writeFileSync(path.join(runRoot, "iteration.json"), JSON.stringify(iteration, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const committedCheckpoint = input.mode === "apply" && executionStatus === "completed" ? createCheckpoint({
    runId, sourceHash, evidence, evidenceSha256, iteration, prior: activeCheckpoint?.receipt ?? null
  }) : null;
  if (committedCheckpoint !== null) fs.writeFileSync(path.join(runRoot, "checkpoint.json"), JSON.stringify(committedCheckpoint, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    schema: DYNAMIC_REVIT_PROGRAM_RUN_V1, run_id: runId, requested_mode: input.mode,
    execution_status: executionStatus, execution_ok: executionStatus === "completed",
    evidence: { ...evidence, taskDirectory: "opaque:trusted-task", runtimeImageDirectory: "opaque:trusted-runtime" },
    continuation,
    step_plan: stepPlan,
    diagnostics: structuredDiagnostics,
    iteration,
    checkpoint: committedCheckpoint,
    verification: {
      evidence_sha256: evidenceSha256,
      iteration_chain_verified: true,
      deterministic_replay_verified: workerBoolean(evidence, "deterministicReplayVerified"),
      diagnostic_bundle_sha256: workerString(evidence, "diagnosticBundleHash"),
      compile_elapsed_ms: workerInteger(evidence, "compileElapsedMs"),
      execution_elapsed_ms: workerInteger(evidence, "executionElapsedMs")
    }
  };
}

function normalizeResultReference(value: DynamicResultReferenceRunInput) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dynamic result-reference config is invalid.");
  const selector = value.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) throw new Error("Dynamic building-systems selector is invalid.");
  const elementUniqueIds = boundedStrings(selector.element_unique_ids ?? [], 256, 256, "element unique IDs");
  const categoryStableIds = boundedStrings(selector.category_stable_ids ?? [], 32, 256, "category stable IDs");
  const kinds = boundedStrings(selector.kinds ?? [], 7, 32, "fact kinds");
  const allowedKinds = new Set(["mep_curve", "equipment", "device", "accessory", "system", "text_note", "independent_tag"]);
  if (kinds.some(kind => !allowedKinds.has(kind))) throw new Error("Dynamic building-systems selector contains an unknown fact kind.");
  const parameterNames = boundedStrings(selector.parameter_names ?? [], 32, 256, "parameter names");
  if (selector.include_type_parameters !== undefined && typeof selector.include_type_parameters !== "boolean") throw new Error("Dynamic include_type_parameters must be boolean.");
  const targetUniqueIds = boundedStrings(value.target_unique_ids ?? [], 256, 256, "trusted target unique IDs");
  const budget = value.effect_budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error("Dynamic result-reference effect budget is invalid.");
  const hashes = (items: string[], maximum: number, label: string) => {
    const result = boundedStrings(items, maximum, 80, label);
    if (result.some(item => !/^sha256:[a-f0-9]{64}$/.test(item))) throw new Error(`Dynamic ${label} must contain canonical SHA-256 identities.`);
    return result;
  };
  const hash = (item: string, label: string) => hashes([item], 1, label)[0]!;
  const maximumOperationCount = boundedInteger(budget.maximum_operation_count, 1, 256, 0);
  const maximumCreates = boundedInteger(budget.maximum_creates, 0, 256, -1);
  const maximumModifications = boundedInteger(budget.maximum_modifications, 0, 256, -1);
  const maximumDeletes = boundedInteger(budget.maximum_deletes, 0, 256, -1);
  if (maximumCreates + maximumModifications + maximumDeletes > maximumOperationCount) throw new Error("Dynamic effect sub-budgets exceed the operation budget.");
  return {
    selector: {
      schema: "dynamic-revit-building-systems-selector/v1",
      elementUniqueIds, categoryStableIds, kinds, parameterNames,
      includeTypeParameters: selector.include_type_parameters ?? false,
      pageSize: boundedInteger(selector.page_size, 1, 128, 64), cursor: null
    },
    targetUniqueIds,
    effectBudget: {
      schema: "dynamic_effect_budget/v1",
      budgetId: boundedText(budget.budget_id, 160, "budget ID"),
      targetDocumentFingerprints: hashes(budget.target_document_fingerprints, 8, "target document fingerprints"),
      allowedCategories: boundedStrings(budget.allowed_categories, 256, 256, "allowed categories"),
      explicitTargetUniqueIds: boundedStrings(budget.explicit_target_unique_ids, 256, 256, "explicit target unique IDs"),
      allowedSdkDomains: boundedStrings(budget.allowed_sdk_domains, 32, 128, "allowed SDK domains"),
      allowedExternalEffectClasses: boundedStrings(budget.allowed_external_effect_classes ?? [], 16, 128, "allowed external effects"),
      viewScopeHash: hash(budget.view_scope_hash, "view scope hash"),
      levelScopeHash: hash(budget.level_scope_hash, "level scope hash"),
      worksetScopeHash: hash(budget.workset_scope_hash, "workset scope hash"),
      phaseScopeHash: hash(budget.phase_scope_hash, "phase scope hash"),
      maximumOperationCount,
      maximumAffectedElements: boundedInteger(budget.maximum_affected_elements, 1, 50_000, 0),
      maximumCreates, maximumModifications, maximumDeletes,
      maximumExecutionMilliseconds: boundedInteger(budget.maximum_execution_milliseconds, 100, 600_000, 0),
      maximumRegenerations: boundedInteger(budget.maximum_regenerations, 0, 1000, -1),
      maximumOutputCount: boundedInteger(budget.maximum_output_count, 0, 10_000, -1),
      maximumOutputBytes: boundedInteger(budget.maximum_output_bytes, 0, 20 * 1024 * 1024 * 1024, -1),
      fileCapabilitySetHash: hash(budget.file_capability_set_hash, "file capability set hash")
    }
  };
}

type NormalizedSelector = ReturnType<typeof normalizeResultReference>["selector"];
type ExecutionLane = "legacy" | "result_reference";
type ExecutionStatus = "completed" | "needs_facts" | "failed";
type StructuredDiagnostic = {
  code: string; message: string; phase: string; severity: string; repair_action: string;
  line: number | null; column: number | null; end_line: number | null; end_column: number | null;
  step_id: string | null; assertion_id: string | null; retryable: boolean;
};
type IterationReceipt = {
  schema: "revit-operator.dynamic-code-iteration.v1";
  run_id: string; attempt: number; lane: ExecutionLane; resume_mode: "root" | "facts" | "repair" | "retry";
  parent: null | { run_id: string; evidence_sha256: string; iteration_sha256: string; execution_status: ExecutionStatus };
  checkpoint_parent: CheckpointParent | null;
  source_sha256: string; requested_mode: "preview" | "apply"; execution_status: ExecutionStatus;
  evidence_sha256: string; execution_identity_sha256: string | null; diagnostic_bundle_sha256: string | null;
  fact_request_sha256: string | null; retryable: boolean;
  progress: { classification: "root" | "completed" | "advanced_to_observation" | "diagnostics_reduced" | "no_progress" | "regressed_or_changed";
    parent_diagnostic_count: number; current_diagnostic_count: number; resolved_codes: string[]; introduced_codes: string[] };
  authorization_granted: false; iteration_sha256: string;
};
type LoadedResume = { mode: "facts" | "repair" | "retry"; receipt: IterationReceipt; diagnostics: StructuredDiagnostic[] };
type CheckpointParent = { task_session_id: string; checkpoint_index: number; run_id: string; checkpoint_sha256: string };
type CheckpointReceipt = {
  schema: "revit-operator.dynamic-code-checkpoint.v1"; task_session_id: string; checkpoint_index: number; run_id: string;
  parent: CheckpointParent | null; source_sha256: string; evidence_sha256: string; iteration_sha256: string;
  apply_receipt_sha256: string; apply_receipt_schema: string; graph_sha256: string; document_fingerprint: string;
  document_session_id: string; document_revision_after: number | null; outcome: "committed_verified";
  restoration: { policy: "discard_working_copy_or_verified_compensation"; status: "pending_final_acceptance_or_compensation" };
  authorization_granted: false; checkpoint_sha256: string;
};
type LoadedCheckpoint = { receipt: CheckpointReceipt; parent: CheckpointParent };

function loadCheckpoint(input: DynamicCheckpointContinuationInput, runsRoot: string): LoadedCheckpoint {
  if (!input || typeof input !== "object" || Array.isArray(input) || !/^dynamic-[a-f0-9]{32}$/.test(input.prior_run_id) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.prior_evidence_sha256) || !/^sha256:[a-f0-9]{64}$/.test(input.prior_checkpoint_sha256))
    throw new Error("Dynamic committed-checkpoint continuation is malformed.");
  const root = path.join(runsRoot, input.prior_run_id);
  const receipt = JSON.parse(readAnchoredRegularFile(path.join(root, "checkpoint.json"), root, 64 * 1024).toString("utf8")) as CheckpointReceipt;
  validateCheckpointReceipt(receipt, input.prior_run_id);
  validateCheckpointArtifacts(receipt, root, runsRoot);
  validateCheckpointAncestry(receipt, runsRoot);
  if (receipt.checkpoint_sha256 !== input.prior_checkpoint_sha256) throw new Error("Dynamic checkpoint identity does not match the retained receipt.");
  const evidence = readAnchoredRegularFile(path.join(root, "evidence.json"), root, 8 * 1024 * 1024);
  if (sha256(evidence) !== input.prior_evidence_sha256)
    throw new Error("Dynamic checkpoint evidence bytes do not match the committed receipt.");
  return { receipt, parent: { task_session_id: receipt.task_session_id, checkpoint_index: receipt.checkpoint_index,
    run_id: receipt.run_id, checkpoint_sha256: receipt.checkpoint_sha256 } };
}

function loadCheckpointParent(parent: CheckpointParent, runsRoot: string): LoadedCheckpoint {
  validateCheckpointParent(parent);
  const root = path.join(runsRoot, parent.run_id);
  const receipt = JSON.parse(readAnchoredRegularFile(path.join(root, "checkpoint.json"), root, 64 * 1024).toString("utf8")) as CheckpointReceipt;
  validateCheckpointReceipt(receipt, parent.run_id); validateCheckpointArtifacts(receipt, root, runsRoot); validateCheckpointAncestry(receipt, runsRoot);
  if (receipt.task_session_id !== parent.task_session_id || receipt.checkpoint_index !== parent.checkpoint_index || receipt.checkpoint_sha256 !== parent.checkpoint_sha256)
    throw new Error("Dynamic retry checkpoint parent was substituted.");
  return { receipt, parent };
}

function createCheckpoint(input: { runId: string; sourceHash: string; evidence: Record<string, unknown>; evidenceSha256: string;
  iteration: IterationReceipt; prior: CheckpointReceipt | null }): CheckpointReceipt {
  const verified = verifyCommittedApplyEvidence(input.evidence, input.sourceHash);
  const index = (input.prior?.checkpoint_index ?? 0) + 1;
  if (index > 64) throw new Error("Dynamic task sessions are limited to 64 verified committed checkpoints.");
  const parent = input.prior === null ? null : { task_session_id: input.prior.task_session_id, checkpoint_index: input.prior.checkpoint_index,
    run_id: input.prior.run_id, checkpoint_sha256: input.prior.checkpoint_sha256 };
  const unsigned = {
    schema: "revit-operator.dynamic-code-checkpoint.v1" as const,
    task_session_id: input.prior?.task_session_id ?? `task-${randomUUID().replaceAll("-", "")}`,
    checkpoint_index: index, run_id: input.runId, parent, source_sha256: input.sourceHash, evidence_sha256: input.evidenceSha256,
    iteration_sha256: input.iteration.iteration_sha256, apply_receipt_sha256: verified.applyReceiptHash,
    apply_receipt_schema: verified.schema, graph_sha256: verified.graphHash, document_fingerprint: verified.documentFingerprint,
    document_session_id: verified.documentSessionId, document_revision_after: verified.documentRevisionAfter,
    outcome: "committed_verified" as const,
    restoration: { policy: "discard_working_copy_or_verified_compensation" as const,
      status: "pending_final_acceptance_or_compensation" as const }, authorization_granted: false as const
  };
  return { ...unsigned, checkpoint_sha256: sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) };
}

function verifyCommittedApplyEvidence(evidence: Record<string, unknown>, expectedSourceHash: string, expected?: CheckpointReceipt) {
  if (evidence.ok !== true || typeof evidence.applyReceipt !== "string" || Buffer.byteLength(evidence.applyReceipt, "utf8") > 1024 * 1024)
    throw new Error("A committed checkpoint requires bounded successful supervisor apply evidence.");
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(evidence.applyReceipt) as Record<string, unknown>; } catch { throw new Error("Committed apply receipt is not valid JSON."); }
  const schemas = new Set(["dynamic-revit-apply-receipt/v1", "dynamic-revit-core-apply-receipt-envelope/v1",
    "dynamic-revit-mep-result-apply-receipt-envelope/v1", "dynamic-revit-annotation-result-apply-receipt-envelope/v1"]);
  const schema = typeof receipt.schema === "string" ? receipt.schema : "";
  if (!schemas.has(schema) || receipt.outcome !== "committed_verified") throw new Error("Checkpoint apply evidence is not an allowed committed_verified receipt.");
  if (workerString(evidence, "sourceHash") !== expectedSourceHash) throw new Error("Checkpoint worker evidence is bound to substituted source bytes.");
  const graph = workerGraph(evidence);
  const graphHash = recordString(graph, "graphHash") ?? recordString(receipt, "graph_hash");
  const receiptGraph = recordString(receipt, "graph_hash") ?? recordString(receipt, "graphHash");
  if (!graphHash || !/^sha256:[a-f0-9]{64}$/.test(graphHash) || receiptGraph !== graphHash) throw new Error("Checkpoint apply receipt is not bound to the worker graph.");
  const admission = evidence.admission && typeof evidence.admission === "object" && !Array.isArray(evidence.admission) ? evidence.admission as Record<string, unknown> : null;
  const documentFingerprint = recordString(graph, "documentFingerprint") ?? recordString(receipt, "document_fingerprint") ?? recordString(admission, "documentFingerprint");
  const documentSessionId = recordString(graph, "documentSessionId") ?? recordString(receipt, "document_session_id") ?? recordString(admission, "documentSessionId");
  if (!documentFingerprint || !/^sha256:[a-f0-9]{64}$/.test(documentFingerprint) || !documentSessionId || documentSessionId.length > 256)
    throw new Error("Checkpoint apply receipt omitted its exact document/session binding.");
  const receiptSource = recordString(receipt, "source_hash");
  if (receiptSource !== null && receiptSource !== expectedSourceHash) throw new Error("Checkpoint apply receipt is bound to substituted source bytes.");
  const inner = receipt.apply_receipt && typeof receipt.apply_receipt === "object" && !Array.isArray(receipt.apply_receipt) ? receipt.apply_receipt as Record<string, unknown> : null;
  const revision = recordInteger(inner, "documentRevisionAfter") ?? recordInteger(receipt, "document_revision_after");
  const value = { schema, applyReceiptHash: sha256(Buffer.from(evidence.applyReceipt, "utf8")), graphHash,
    documentFingerprint, documentSessionId, documentRevisionAfter: revision };
  if (expected && (expected.apply_receipt_sha256 !== value.applyReceiptHash || expected.apply_receipt_schema !== schema ||
    expected.graph_sha256 !== graphHash || expected.document_fingerprint !== documentFingerprint || expected.document_session_id !== documentSessionId ||
    expected.document_revision_after !== revision)) throw new Error("Retained checkpoint fields do not match the authenticated apply evidence.");
  return value;
}

function workerGraph(evidence: Record<string, unknown>): Record<string, unknown> {
  const worker = workerRecord(evidence);
  for (const key of ["resultReferenceProgramResult", "coreProgramResult"] as const) {
    const result = worker?.[key];
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const graph = (result as Record<string, unknown>).graph;
      if (graph && typeof graph === "object" && !Array.isArray(graph)) return graph as Record<string, unknown>;
    }
  }
  const graph = worker?.graph;
  if (graph && typeof graph === "object" && !Array.isArray(graph)) return graph as Record<string, unknown>;
  throw new Error("Committed checkpoint evidence omitted the exact worker graph.");
}

function validateCheckpointReceipt(receipt: CheckpointReceipt, expectedRunId: string) {
  const keys = ["schema", "task_session_id", "checkpoint_index", "run_id", "parent", "source_sha256", "evidence_sha256", "iteration_sha256",
    "apply_receipt_sha256", "apply_receipt_schema", "graph_sha256", "document_fingerprint", "document_session_id", "document_revision_after",
    "outcome", "restoration", "authorization_granted", "checkpoint_sha256"].sort();
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys) ||
    receipt.schema !== "revit-operator.dynamic-code-checkpoint.v1" || receipt.run_id !== expectedRunId || !/^task-[a-f0-9]{32}$/.test(receipt.task_session_id) ||
    !Number.isSafeInteger(receipt.checkpoint_index) || receipt.checkpoint_index < 1 || receipt.checkpoint_index > 64 || receipt.outcome !== "committed_verified" ||
    receipt.authorization_granted !== false || !/^sha256:[a-f0-9]{64}$/.test(receipt.source_sha256) || !/^sha256:[a-f0-9]{64}$/.test(receipt.evidence_sha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.iteration_sha256) || !/^sha256:[a-f0-9]{64}$/.test(receipt.apply_receipt_sha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.graph_sha256) || !/^sha256:[a-f0-9]{64}$/.test(receipt.document_fingerprint) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.checkpoint_sha256) || typeof receipt.document_session_id !== "string" || receipt.document_session_id.length < 1 || receipt.document_session_id.length > 256 ||
    !(receipt.document_revision_after === null || Number.isSafeInteger(receipt.document_revision_after) && receipt.document_revision_after >= 0) ||
    typeof receipt.apply_receipt_schema !== "string") throw new Error("Dynamic checkpoint receipt is malformed.");
  validateCheckpointParent(receipt.parent);
  if (receipt.parent === null ? receipt.checkpoint_index !== 1 : receipt.parent.checkpoint_index + 1 !== receipt.checkpoint_index || receipt.parent.task_session_id !== receipt.task_session_id)
    throw new Error("Dynamic checkpoint sequence is not contiguous.");
  if (!receipt.restoration || JSON.stringify(Object.keys(receipt.restoration).sort()) !== JSON.stringify(["policy", "status"]) ||
    receipt.restoration.policy !== "discard_working_copy_or_verified_compensation" || receipt.restoration.status !== "pending_final_acceptance_or_compensation")
    throw new Error("Dynamic checkpoint restoration contract is malformed.");
  const { checkpoint_sha256: claimed, ...unsigned } = receipt;
  if (sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) !== claimed) throw new Error("Dynamic checkpoint receipt hash is invalid.");
}

function validateCheckpointParent(parent: CheckpointParent | null) {
  if (parent === null) return;
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || JSON.stringify(Object.keys(parent).sort()) !== JSON.stringify(["checkpoint_index", "checkpoint_sha256", "run_id", "task_session_id"]) ||
    !/^task-[a-f0-9]{32}$/.test(parent.task_session_id) || !Number.isSafeInteger(parent.checkpoint_index) || parent.checkpoint_index < 1 || parent.checkpoint_index > 64 ||
    !/^dynamic-[a-f0-9]{32}$/.test(parent.run_id) || !/^sha256:[a-f0-9]{64}$/.test(parent.checkpoint_sha256)) throw new Error("Dynamic checkpoint parent is malformed.");
}

function validateCheckpointAncestry(tip: CheckpointReceipt, runsRoot: string) {
  let child = tip; const seen = new Set([child.run_id]);
  while (child.parent !== null) {
    if (seen.has(child.parent.run_id)) throw new Error("Dynamic checkpoint ancestry contains a cycle.");
    seen.add(child.parent.run_id);
    const root = path.join(runsRoot, child.parent.run_id);
    const parent = JSON.parse(readAnchoredRegularFile(path.join(root, "checkpoint.json"), root, 64 * 1024).toString("utf8")) as CheckpointReceipt;
    validateCheckpointReceipt(parent, child.parent.run_id);
    validateCheckpointArtifacts(parent, root, runsRoot);
    if (parent.checkpoint_sha256 !== child.parent.checkpoint_sha256 || parent.checkpoint_index + 1 !== child.checkpoint_index || parent.task_session_id !== child.task_session_id)
      throw new Error("Dynamic checkpoint ancestry is not exact and contiguous.");
    child = parent;
  }
  if (child.checkpoint_index !== 1 || seen.size !== tip.checkpoint_index) throw new Error("Dynamic checkpoint ancestry does not terminate at one exact root.");
}

function validateCheckpointArtifacts(receipt: CheckpointReceipt, root: string, runsRoot: string) {
  const iteration = JSON.parse(readAnchoredRegularFile(path.join(root, "iteration.json"), root, 64 * 1024).toString("utf8")) as IterationReceipt;
  validateIterationReceipt(iteration, receipt.run_id); validateIterationAncestry(iteration, runsRoot);
  if (iteration.iteration_sha256 !== receipt.iteration_sha256 || iteration.source_sha256 !== receipt.source_sha256 ||
    iteration.evidence_sha256 !== receipt.evidence_sha256 || JSON.stringify(iteration.checkpoint_parent) !== JSON.stringify(receipt.parent))
    throw new Error("Dynamic checkpoint is not bound to its exact iteration segment.");
  const evidence = readAnchoredRegularFile(path.join(root, "evidence.json"), root, 8 * 1024 * 1024);
  if (sha256(evidence) !== receipt.evidence_sha256) throw new Error("Dynamic checkpoint evidence bytes changed.");
  verifyCommittedApplyEvidence(JSON.parse(evidence.toString("utf8")) as Record<string, unknown>, receipt.source_sha256, receipt);
}

function validateCheckpointEcho(evidence: Record<string, unknown>, receipt: CheckpointReceipt) {
  const value = evidence.checkpointBinding;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor evidence omitted the committed checkpoint binding.");
  const item = value as Record<string, unknown>;
  if (item.schema !== "dynamic-revit-task-checkpoint-binding/v1" || item.taskSessionId !== receipt.task_session_id || item.checkpointIndex !== receipt.checkpoint_index ||
    item.checkpointHash !== receipt.checkpoint_sha256 || item.documentFingerprint !== receipt.document_fingerprint || item.documentSessionId !== receipt.document_session_id ||
    item.applyReceiptHash !== receipt.apply_receipt_sha256 || item.authorizationGranted !== false) throw new Error("Supervisor checkpoint binding was substituted.");
}

function recordString(value: Record<string, unknown> | null, key: string): string | null { const item = value?.[key]; return typeof item === "string" ? item : null; }
function recordInteger(value: Record<string, unknown> | null, key: string): number | null { const item = value?.[key]; return Number.isSafeInteger(item) && (item as number) >= 0 ? item as number : null; }

function loadResume(input: DynamicExecutionResumeInput, runsRoot: string, sourceHash: string, requestedMode: "preview" | "apply",
  lane: ExecutionLane, currentSelector: NormalizedSelector | undefined): LoadedResume {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Dynamic resume input is invalid.");
  if (!/^dynamic-[a-f0-9]{32}$/.test(input.prior_run_id)) throw new Error("Dynamic resume run ID is invalid.");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.prior_evidence_sha256)) throw new Error("Dynamic resume evidence identity is invalid.");
  if (input.mode !== "facts" && input.mode !== "repair" && input.mode !== "retry") throw new Error("Dynamic resume mode is invalid.");
  const priorRoot = path.join(runsRoot, input.prior_run_id);
  const receipt = JSON.parse(readAnchoredRegularFile(path.join(priorRoot, "iteration.json"), priorRoot, 64 * 1024).toString("utf8")) as IterationReceipt;
  validateIterationReceipt(receipt, input.prior_run_id);
  validateIterationAncestry(receipt, runsRoot);
  if (receipt.attempt >= 5) throw new Error("Dynamic execution is limited to five evidence-bound attempts.");
  if (receipt.requested_mode !== requestedMode || receipt.lane !== lane) throw new Error("Dynamic resume cannot change execution mode or program lane.");
  const priorEvidence = readAnchoredRegularFile(path.join(priorRoot, "evidence.json"), priorRoot, 8 * 1024 * 1024);
  const actualEvidenceHash = sha256(priorEvidence);
  if (actualEvidenceHash !== input.prior_evidence_sha256 || actualEvidenceHash !== receipt.evidence_sha256)
    throw new Error("Dynamic resume evidence bytes do not match the bound parent receipt.");
  const evidence = JSON.parse(priorEvidence.toString("utf8")) as Record<string, unknown>;
  const priorDiagnostics = diagnosticsFromEvidence(evidence, "");
  if (input.mode === "facts") {
    if (receipt.execution_status !== "needs_facts" || receipt.source_sha256 !== sourceHash || lane !== "result_reference" || currentSelector === undefined)
      throw new Error("A facts continuation requires the same source and a prior needs_facts result-reference attempt.");
    const continuation = continuationFromEvidence(evidence);
    if (!selectorCovers(currentSelector, continuation.fact_request.selector as Record<string, unknown>))
      throw new Error("The resumed observation selector does not cover the exact requested facts.");
  } else {
    if (receipt.execution_status !== "failed" || !receipt.retryable || !priorDiagnostics.some(diagnostic => diagnostic.retryable))
      throw new Error("Dynamic repair/retry requires a prior retryable failed attempt.");
    if (input.mode === "repair" && receipt.source_sha256 === sourceHash) throw new Error("Dynamic repair must provide changed source bytes.");
    if (input.mode === "retry" && receipt.source_sha256 !== sourceHash) throw new Error("Dynamic retry must preserve the exact source bytes.");
  }
  return { mode: input.mode, receipt, diagnostics: priorDiagnostics };
}

function createIterationReceipt(input: { runId: string; sourceHash: string; requestedMode: "preview" | "apply"; lane: ExecutionLane;
  executionStatus: ExecutionStatus; evidenceSha256: string; executionIdentityHash: string | null; diagnosticBundleHash: string | null;
  factRequestHash: string | null; retryable: boolean; diagnostics: StructuredDiagnostic[]; resume: LoadedResume | undefined;
  checkpointParent: CheckpointParent | null }): IterationReceipt {
  const progress = iterationProgress(input.resume, input.executionStatus, input.diagnostics);
  const unsigned = {
    schema: "revit-operator.dynamic-code-iteration.v1" as const,
    run_id: input.runId,
    attempt: input.resume === undefined ? 1 : input.resume.receipt.attempt + 1,
    lane: input.lane,
    resume_mode: input.resume?.mode ?? "root" as const,
    parent: input.resume === undefined ? null : {
      run_id: input.resume.receipt.run_id,
      evidence_sha256: input.resume.receipt.evidence_sha256,
      iteration_sha256: input.resume.receipt.iteration_sha256,
      execution_status: input.resume.receipt.execution_status
    },
    checkpoint_parent: input.checkpointParent,
    source_sha256: input.sourceHash,
    requested_mode: input.requestedMode,
    execution_status: input.executionStatus,
    evidence_sha256: input.evidenceSha256,
    execution_identity_sha256: canonicalHashOrNull(input.executionIdentityHash),
    diagnostic_bundle_sha256: canonicalHashOrNull(input.diagnosticBundleHash),
    fact_request_sha256: canonicalHashOrNull(input.factRequestHash),
    retryable: input.retryable,
    progress,
    authorization_granted: false as const
  };
  return { ...unsigned, iteration_sha256: sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) };
}

function validateIterationReceipt(receipt: IterationReceipt, expectedRunId: string) {
  const expectedKeys = ["schema", "run_id", "attempt", "lane", "resume_mode", "parent", "source_sha256", "requested_mode",
    "execution_status", "evidence_sha256", "execution_identity_sha256", "diagnostic_bundle_sha256", "fact_request_sha256",
    "retryable", "progress", "authorization_granted", "iteration_sha256", "checkpoint_parent"].sort();
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys))
    throw new Error("Dynamic parent iteration receipt has an invalid shape.");
  if (receipt.schema !== "revit-operator.dynamic-code-iteration.v1" || receipt.run_id !== expectedRunId ||
    !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > 5 || receipt.authorization_granted !== false ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.source_sha256) || !/^sha256:[a-f0-9]{64}$/.test(receipt.evidence_sha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.iteration_sha256)) throw new Error("Dynamic parent iteration receipt is malformed.");
  if (!new Set(["legacy", "result_reference"]).has(receipt.lane) || !new Set(["root", "facts", "repair", "retry"]).has(receipt.resume_mode) ||
    !new Set(["preview", "apply"]).has(receipt.requested_mode) || !new Set(["completed", "needs_facts", "failed"]).has(receipt.execution_status) ||
    typeof receipt.retryable !== "boolean" || !nullableHash(receipt.execution_identity_sha256) || !nullableHash(receipt.diagnostic_bundle_sha256) ||
    !nullableHash(receipt.fact_request_sha256)) throw new Error("Dynamic parent iteration semantic fields are malformed.");
  validateCheckpointParent(receipt.checkpoint_parent);
  if (receipt.parent !== null) {
    const parentKeys = ["run_id", "evidence_sha256", "iteration_sha256", "execution_status"].sort();
    if (typeof receipt.parent !== "object" || Array.isArray(receipt.parent) || JSON.stringify(Object.keys(receipt.parent).sort()) !== JSON.stringify(parentKeys) ||
      !/^dynamic-[a-f0-9]{32}$/.test(receipt.parent.run_id) || !/^sha256:[a-f0-9]{64}$/.test(receipt.parent.evidence_sha256) ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.parent.iteration_sha256) || !new Set(["completed", "needs_facts", "failed"]).has(receipt.parent.execution_status))
      throw new Error("Dynamic parent iteration chain fields are malformed.");
    if (receipt.attempt < 2 || receipt.resume_mode === "root") throw new Error("Dynamic resumed iteration fields are contradictory.");
  } else if (receipt.attempt !== 1 || receipt.resume_mode !== "root") throw new Error("Dynamic root iteration fields are contradictory.");
  const progress = receipt.progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress) ||
    JSON.stringify(Object.keys(progress).sort()) !== JSON.stringify(["classification", "current_diagnostic_count", "introduced_codes", "parent_diagnostic_count", "resolved_codes"]) ||
    !new Set(["root", "completed", "advanced_to_observation", "diagnostics_reduced", "no_progress", "regressed_or_changed"]).has(progress.classification) ||
    !Number.isSafeInteger(progress.parent_diagnostic_count) || progress.parent_diagnostic_count < 0 || progress.parent_diagnostic_count > 32 ||
    !Number.isSafeInteger(progress.current_diagnostic_count) || progress.current_diagnostic_count < 0 || progress.current_diagnostic_count > 32 ||
    !boundedCodes(progress.resolved_codes) || !boundedCodes(progress.introduced_codes)) throw new Error("Dynamic iteration progress fields are malformed.");
  const { iteration_sha256: claimed, ...unsigned } = receipt;
  if (sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) !== claimed) throw new Error("Dynamic parent iteration receipt hash is invalid.");
}

function validateIterationAncestry(tip: IterationReceipt, runsRoot: string) {
  let child = tip;
  const seen = new Set<string>([child.run_id]);
  while (child.parent !== null) {
    if (seen.has(child.parent.run_id)) throw new Error("Dynamic iteration chain contains a cycle.");
    seen.add(child.parent.run_id);
    const parentRoot = path.join(runsRoot, child.parent.run_id);
    const parent = JSON.parse(readAnchoredRegularFile(path.join(parentRoot, "iteration.json"), parentRoot, 64 * 1024).toString("utf8")) as IterationReceipt;
    validateIterationReceipt(parent, child.parent.run_id);
    if (child.attempt !== parent.attempt + 1 || child.parent.iteration_sha256 !== parent.iteration_sha256 ||
      child.parent.evidence_sha256 !== parent.evidence_sha256 || child.parent.execution_status !== parent.execution_status)
      throw new Error("Dynamic iteration ancestry is not an exact contiguous chain.");
    if (JSON.stringify(child.checkpoint_parent) !== JSON.stringify(parent.checkpoint_parent))
      throw new Error("Dynamic retry chain changed its committed checkpoint parent.");
    child = parent;
  }
  if (child.attempt !== 1 || child.resume_mode !== "root" || seen.size !== tip.attempt)
    throw new Error("Dynamic iteration ancestry does not terminate at one exact root.");
}

function nullableHash(value: unknown): boolean { return value === null || typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function boundedCodes(value: unknown): boolean { return Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === "string" && item.length >= 1 && item.length <= 128) && new Set(value).size === value.length; }

function iterationProgress(resume: LoadedResume | undefined, status: ExecutionStatus, current: StructuredDiagnostic[]): IterationReceipt["progress"] {
  const parentCodes = [...new Set((resume?.diagnostics ?? []).map(value => value.code))].sort();
  const currentCodes = [...new Set(current.map(value => value.code))].sort();
  const resolved = parentCodes.filter(code => !currentCodes.includes(code));
  const introduced = currentCodes.filter(code => !parentCodes.includes(code));
  const classification = resume === undefined ? "root" : status === "completed" ? "completed" : status === "needs_facts" ?
    "advanced_to_observation" : current.length < resume.diagnostics.length ? "diagnostics_reduced" :
      resolved.length === 0 && introduced.length === 0 ? "no_progress" : "regressed_or_changed";
  return { classification, parent_diagnostic_count: resume?.diagnostics.length ?? 0, current_diagnostic_count: current.length,
    resolved_codes: resolved, introduced_codes: introduced };
}

function selectorCovers(current: NormalizedSelector, requested: Record<string, unknown>): boolean {
  const covers = (actual: string[], required: unknown) => Array.isArray(required) && required.every(value => typeof value === "string" && actual.includes(value));
  return requested.schema === "dynamic-revit-building-systems-selector/v1" && requested.cursor == null &&
    covers(current.elementUniqueIds, requested.elementUniqueIds) && covers(current.categoryStableIds, requested.categoryStableIds) &&
    covers(current.kinds, requested.kinds) && covers(current.parameterNames, requested.parameterNames) &&
    (requested.includeTypeParameters !== true || current.includeTypeParameters === true);
}

function diagnosticsFromEvidence(evidence: Record<string, unknown>, stderr: string): StructuredDiagnostic[] {
  const worker = workerRecord(evidence);
  const raw = worker?.diagnostics;
  if (Array.isArray(raw)) {
    if (raw.length > 32) throw new Error("Worker returned too many diagnostics.");
    const diagnostics = raw.map((value, index) => normalizeDiagnostic(value, index));
    const claimed = workerString(evidence, "diagnosticBundleHash");
    if (claimed === null || claimed !== diagnosticBundleHash(diagnostics)) throw new Error("Worker diagnostic bundle identity is invalid.");
    return diagnostics;
  }
  if (evidence.ok === true) return [];
  const detailHash = sha256(Buffer.from(stderr.slice(0, 4_000), "utf8"));
  return [{ code: "SUPERVISOR_FAILURE", message: `Execution failed outside structured worker diagnostics (${detailHash}).`, phase: "supervisor",
    severity: "error", repair_action: "refresh_state_or_inspect_runtime", line: null, column: null, end_line: null, end_column: null,
    step_id: null, assertion_id: null, retryable: /stale|timeout|busy|pending/i.test(String(evidence.failure ?? "") + stderr) }];
}

function executionStepPlan(evidence: Record<string, unknown>) {
  const result = workerRecord(evidence)?.resultReferenceProgramResult;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const trace = (result as Record<string, unknown>).executionTrace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return null;
  const value = trace as Record<string, unknown>;
  const steps = value.steps;
  const assertions = value.assertions;
  if (!Array.isArray(steps) || steps.length > 256 || !Array.isArray(assertions) || assertions.length > 256 ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.traceHash ?? ""))) throw new Error("Worker execution trace summary is malformed.");
  const assertionCounts = new Map<string, number>();
  for (const assertion of assertions) {
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw new Error("Worker execution assertion is malformed.");
    const stepId = (assertion as Record<string, unknown>).stepId;
    if (typeof stepId !== "string") throw new Error("Worker execution assertion step is malformed.");
    assertionCounts.set(stepId, (assertionCounts.get(stepId) ?? 0) + 1);
  }
  const waves = new Map<string, number>();
  if (value.outcome !== "completed" && value.outcome !== "needs_facts") throw new Error("Worker execution trace outcome is malformed.");
  const summaries = steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Worker execution step ${index} is malformed.`);
    const item = step as Record<string, unknown>;
    const stepId = item.stepId; const purpose = item.purpose; const dependsOn = item.dependsOn; const nodeIds = item.nodeIds; const facts = item.factReferences;
    if (typeof stepId !== "string" || stepId.length < 1 || stepId.length > 128 || typeof purpose !== "string" || purpose.length < 1 || purpose.length > 320 ||
      waves.has(stepId) || !Array.isArray(dependsOn) || dependsOn.length > 256 || new Set(dependsOn).size !== dependsOn.length ||
      !Array.isArray(nodeIds) || nodeIds.length > 64 || !Array.isArray(facts) || facts.length > 128 ||
      dependsOn.some(dependency => typeof dependency !== "string" || !waves.has(dependency))) throw new Error(`Worker execution step ${index} dependencies are malformed or forward-referencing.`);
    const wave = dependsOn.length === 0 ? 1 : Math.max(...dependsOn.map(dependency => waves.get(dependency as string)!)) + 1;
    waves.set(stepId, wave);
    return { step_id: stepId, purpose, depends_on: dependsOn, wave, node_count: nodeIds.length,
      fact_reference_count: facts.length, assertion_count: assertionCounts.get(stepId) ?? 0 };
  });
  if ([...assertionCounts.keys()].some(stepId => !waves.has(stepId))) throw new Error("Worker execution assertion is not bound to a summarized step.");
  const waveCount = summaries.length === 0 ? 0 : Math.max(...summaries.map(step => step.wave));
  return { schema: "revit-operator.dynamic-code-step-plan.v1", trace_sha256: value.traceHash, outcome: value.outcome,
    authorization_granted: false, step_count: summaries.length, dependency_wave_count: waveCount,
    has_parallel_wave: [...new Set(summaries.map(step => step.wave))].some(wave => summaries.filter(step => step.wave === wave).length > 1), steps: summaries };
}

function normalizeDiagnostic(value: unknown, index: number): StructuredDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Worker diagnostic ${index} is invalid.`);
  const item = value as Record<string, unknown>;
  const text = (key: string, maximum: number, nullable = false) => {
    const raw = item[key];
    if (nullable && (raw === null || raw === undefined)) return null;
    if (typeof raw !== "string" || raw.length < 1 || raw.length > maximum || raw.includes("\0")) throw new Error(`Worker diagnostic ${key} is invalid.`);
    return raw;
  };
  const integer = (key: string) => item[key] === null || item[key] === undefined ? null :
    Number.isSafeInteger(item[key]) && (item[key] as number) >= 1 ? item[key] as number : (() => { throw new Error(`Worker diagnostic ${key} is invalid.`); })();
  if (typeof item.retryable !== "boolean") throw new Error("Worker diagnostic retryable flag is invalid.");
  return { code: text("code", 128)!, message: text("message", 2_048)!, phase: text("phase", 64)!, severity: text("severity", 16)!,
    repair_action: text("repairAction", 96)!, line: integer("line"), column: integer("column"), end_line: integer("endLine"),
    end_column: integer("endColumn"), step_id: text("stepId", 128, true), assertion_id: text("assertionId", 128, true), retryable: item.retryable };
}

function diagnosticBundleHash(diagnostics: StructuredDiagnostic[]): string {
  const canonical = diagnostics.map(value => [value.code, value.phase, value.severity, value.repair_action, value.line ?? "", value.column ?? "",
    value.end_line ?? "", value.end_column ?? "", value.step_id ?? "", value.assertion_id ?? "", value.retryable ? "1" : "0",
    sha256(Buffer.from(value.message, "utf8"))].join("|")).join("\n");
  return sha256(Buffer.from("dynamic-revit-worker-diagnostics/v1\n" + canonical, "utf8"));
}

function workerRecord(evidence: Record<string, unknown>): Record<string, unknown> | null {
  const value = evidence.workerOutput;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function workerString(evidence: Record<string, unknown>, key: string): string | null { const value = workerRecord(evidence)?.[key]; return typeof value === "string" ? value : null; }
function workerBoolean(evidence: Record<string, unknown>, key: string): boolean { return workerRecord(evidence)?.[key] === true; }
function workerInteger(evidence: Record<string, unknown>, key: string): number | null { const value = workerRecord(evidence)?.[key]; return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }
function canonicalHashOrNull(value: string | null): string | null { return value !== null && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null; }
function sha256(value: Buffer): string { return "sha256:" + createHash("sha256").update(value).digest("hex"); }

function readAnchoredRegularFile(file: string, trustedRoot: string, maximumBytes: number): Buffer {
  const relative = path.relative(path.resolve(trustedRoot), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Dynamic artifact path escaped its trusted run root.");
  let cursor = path.resolve(trustedRoot);
  if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Dynamic run root may not be a link.");
  for (const component of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Dynamic artifact ancestor may not be a link.");
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error("Dynamic artifact is not a bounded regular file.");
  const descriptor = fs.openSync(file, "r");
  try {
    const held = fs.fstatSync(descriptor);
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size) throw new Error("Dynamic artifact identity changed before read.");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size || bytes.length !== held.size)
      throw new Error("Dynamic artifact identity changed during read.");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function ensureRunsRoot(workspaceRoot: string, runsRoot: string) {
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(runsRoot));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Dynamic runs root escaped the workspace.");
  let cursor = path.resolve(workspaceRoot);
  if (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Dynamic workspace root is not a regular directory.");
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const state = fs.lstatSync(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Dynamic runs root contains a link or unsupported filesystem object.");
  }
}

function continuationFromEvidence(evidence: Record<string, unknown>) {
  if (evidence.ok !== false || evidence.failure !== "additional_facts_required") throw new Error("Needs-facts evidence has contradictory outcome fields.");
  const worker = evidence.workerOutput;
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) throw new Error("Needs-facts evidence omitted worker output.");
  const output = worker as Record<string, unknown>;
  if (output.executionStatus !== "needs_facts" || output.deterministicReplayVerified !== true) throw new Error("Needs-facts worker output is not deterministic.");
  const result = output.resultReferenceProgramResult;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Needs-facts evidence omitted its structured continuation.");
  const typed = result as Record<string, unknown>;
  if (!typed.factRequest || !typed.executionTrace) throw new Error("Needs-facts evidence omitted its request or execution trace.");
  const factRequest = typed.factRequest as Record<string, unknown>;
  const executionTrace = typed.executionTrace as Record<string, unknown>;
  if (factRequest.schema !== "dynamic-revit-fact-request/v1" || factRequest.authorizationGranted !== false
    || !/^sha256:[a-f0-9]{64}$/.test(String(factRequest.requestHash ?? ""))) {
    throw new Error("Needs-facts request is malformed or authorizing.");
  }
  if (executionTrace.schema !== "dynamic-revit-execution-trace/v1" || executionTrace.outcome !== "needs_facts"
    || executionTrace.authorizationGranted !== false || executionTrace.factRequestHash !== factRequest.requestHash
    || !/^sha256:[a-f0-9]{64}$/.test(String(executionTrace.protocolIdentity ?? ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(executionTrace.traceHash ?? ""))) {
    throw new Error("Needs-facts execution trace is malformed or not bound to its request.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(output.compiledAssemblyHash ?? ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(output.executionIdentityHash ?? ""))) {
    throw new Error("Needs-facts compiled or execution identity is invalid.");
  }
  return {
    schema: "revit-operator.dynamic-revit-continuation.v1",
    authorization_granted: false,
    fact_request: factRequest,
    execution_trace: executionTrace,
    compiled_assembly_sha256: output.compiledAssemblyHash,
    execution_identity_sha256: output.executionIdentityHash
  };
}

function executeFile(file: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0, stdout, stderr })));
}
function requiredFile(value: string | undefined, label: string): string { const resolved = value ? path.resolve(value) : ""; if (!resolved || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`${label} must identify an existing trusted file.`); return resolved; }
function requiredDirectory(value: string | undefined, label: string): string { const resolved = value ? path.resolve(value) : ""; if (!resolved || !fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} must identify an existing trusted directory.`); return resolved; }
function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error("Dynamic runtime numeric bound is invalid."); return result; }
function boundedText(value: string, maximum: number, label: string): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) throw new Error(`Dynamic ${label} is invalid.`); return value; }
function boundedStrings(value: string[], maximumItems: number, maximumChars: number, label: string): string[] { if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Dynamic ${label} exceeds its item bound.`); const result = value.map(item => boundedText(item, maximumChars, label)); if (new Set(result).size !== result.length) throw new Error(`Dynamic ${label} contains duplicates.`); return result; }
function boundedYear(value: string): "2023" | "2024" | "2025" | "2026" { if (value !== "2023" && value !== "2024" && value !== "2025" && value !== "2026") throw new Error("Dynamic runtime Revit year must be 2023, 2024, 2025, or 2026."); return value; }
