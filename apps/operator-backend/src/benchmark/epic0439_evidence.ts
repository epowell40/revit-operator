import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { benchmarkDataRoot, readJsonFile } from "./files.js";
import {
  materializeEpic0439Cases,
  type Epic0439Case,
  type Epic0439Metrics,
  type Epic0439Representation,
  type Epic0439Result,
  type Epic0439UsefulnessManifest
} from "./epic0439_usefulness.js";

export type Epic0439CaseSet = {
  schema_version: "epic0439_case_set/v1";
  suite_id: string;
  evidence_tier: "source_only";
  generated_outcomes: false;
  seed: string;
  wording_partition: "implementation" | "holdout" | "reviewer_holdout";
  cases: Epic0439Case[];
};

type Telemetry = {
  model_turns: number;
  tool_rpc_calls: number;
  generated_code_bytes: number;
  estimated_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  preview_repairs: number;
  special_purpose_product_code_bytes: number;
  recovery_attempts: number;
};

export type Epic0439EvidenceEntry = {
  case_id: string;
  task_id: string;
  config_id: string;
  representation: Epic0439Representation;
  evidence_file: string;
  evidence_sha256: string;
  telemetry: Telemetry;
};

export type Epic0439EvidenceManifest = {
  schema_version: "epic0439_evidence_manifest/v1";
  suite_id: string;
  case_set_sha256: string;
  entries: Epic0439EvidenceEntry[];
};

type JsonRecord = Record<string, unknown>;

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const evidenceManifestSchemaPath = path.join(
  benchmarkDataRoot(),
  "contracts",
  "epic0439_evidence_manifest.v1.schema.json"
);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object.`);
  return value;
}

function stringField(value: JsonRecord, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`${field} must be a non-empty string.`);
  return candidate;
}

function arrayField(value: JsonRecord, field: string): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`${field} must be an array.`);
  return candidate;
}

function booleanField(value: JsonRecord, field: string): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") throw new Error(`${field} must be a boolean.`);
  return candidate;
}

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJoin(values: string[]): string {
  return values.map((value) => `+${Buffer.from(value, "utf8").toString("base64")}\n`).join("");
}

function canonicalSet(value: unknown, field: string): string {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return canonicalJoin([...(value as string[])].sort());
}

function integerString(value: JsonRecord, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return String(candidate);
}

function effectBudgetHash(value: unknown): string {
  const budget = record(value, "applyAuthorizationReceipt.effect_budget");
  return sha256Bytes(canonicalJoin([
    stringField(budget, "Schema"),
    stringField(budget, "BudgetId"),
    canonicalSet(budget.TargetDocumentFingerprints, "effect_budget.TargetDocumentFingerprints"),
    canonicalSet(budget.AllowedCategories, "effect_budget.AllowedCategories"),
    canonicalSet(budget.ExplicitTargetUniqueIds, "effect_budget.ExplicitTargetUniqueIds"),
    canonicalSet(budget.AllowedSdkDomains, "effect_budget.AllowedSdkDomains"),
    canonicalSet(budget.AllowedExternalEffectClasses, "effect_budget.AllowedExternalEffectClasses"),
    stringField(budget, "ViewScopeHash"),
    stringField(budget, "LevelScopeHash"),
    stringField(budget, "WorksetScopeHash"),
    stringField(budget, "PhaseScopeHash"),
    integerString(budget, "MaximumOperationCount"),
    integerString(budget, "MaximumAffectedElements"),
    integerString(budget, "MaximumCreates"),
    integerString(budget, "MaximumModifications"),
    integerString(budget, "MaximumDeletes"),
    integerString(budget, "MaximumExecutionMilliseconds"),
    integerString(budget, "MaximumRegenerations"),
    integerString(budget, "MaximumOutputCount"),
    integerString(budget, "MaximumOutputBytes"),
    stringField(budget, "FileCapabilitySetHash")
  ]));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as JsonRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(",")}}`;
}

function parseEmbeddedReceipt(value: unknown, field: string): { raw: string; receipt: JsonRecord } {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must contain a non-empty JSON receipt string.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} is not valid JSON.`);
  }
  return { raw: value, receipt: record(parsed, field) };
}

function equal(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) throw new Error(`${field} does not match its canonical binding.`);
}

function elementIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) =>
    !((typeof entry === "string" && entry.trim()) || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)))) {
    throw new Error(`${field} must be an array of non-empty strings or non-negative integer ids.`);
  }
  return value.map((entry) => String(entry));
}

function sameStringSet(actual: unknown, expected: unknown, field: string): void {
  const left = [...elementIdArray(actual, field)].sort();
  const right = [...elementIdArray(expected, field)].sort();
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) {
    throw new Error(`${field} does not match the preview-bound element set.`);
  }
}

function validateEvidencePath(evidenceRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("evidence_file must be a relative path.");
  const root = fs.realpathSync(evidenceRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Evidence path '${relativePath}' escapes or aliases the evidence root.`);
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Evidence path '${relativePath}' must be a regular non-symlink file.`);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(root, realCandidate);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Evidence path '${relativePath}' resolves outside the evidence root.`);
  }
  return realCandidate;
}

function validateCaseSet(value: unknown, expectedSuiteId: string): Epic0439CaseSet {
  const caseSet = record(value, "case set") as Epic0439CaseSet & JsonRecord;
  equal(caseSet.schema_version, "epic0439_case_set/v1", "case_set.schema_version");
  equal(caseSet.suite_id, expectedSuiteId, "case_set.suite_id");
  equal(caseSet.evidence_tier, "source_only", "case_set.evidence_tier");
  equal(caseSet.generated_outcomes, false, "case_set.generated_outcomes");
  stringField(caseSet, "seed");
  if (!["implementation", "holdout", "reviewer_holdout"].includes(String(caseSet.wording_partition))) {
    throw new Error("case_set.wording_partition is invalid.");
  }
  if (!Array.isArray(caseSet.cases) || caseSet.cases.length === 0) throw new Error("case_set.cases must be non-empty.");
  const ids = new Set<string>();
  for (const benchmarkCase of caseSet.cases) {
    if (!isRecord(benchmarkCase) || benchmarkCase.schema_version !== "epic0439_case/v1") throw new Error("case_set contains an invalid case.");
    if (benchmarkCase.suite_id !== expectedSuiteId) throw new Error(`Case '${benchmarkCase.case_id}' has the wrong suite.`);
    if (!benchmarkCase.case_id || ids.has(benchmarkCase.case_id)) throw new Error(`Duplicate or empty case id '${benchmarkCase.case_id}'.`);
    ids.add(benchmarkCase.case_id);
  }
  return caseSet;
}

function verifyCanonicalCaseMaterialization(caseSet: Epic0439CaseSet, manifest: Epic0439UsefulnessManifest): void {
  if (caseSet.wording_partition === "reviewer_holdout") {
    throw new Error("Reviewer-holdout evidence ingestion requires an independently pinned reviewer wording contract.");
  }
  if (caseSet.cases.length % manifest.tasks.length !== 0) {
    throw new Error("Case set cardinality is not a complete task/variant matrix.");
  }
  const variants = caseSet.cases.length / manifest.tasks.length;
  const expected = materializeEpic0439Cases(manifest, {
    seed: caseSet.seed,
    variants_per_task: variants,
    wording_partition: caseSet.wording_partition
  });
  if (canonicalJson(caseSet.cases) !== canonicalJson(expected)) {
    throw new Error("Case set does not match canonical materialization for its seed, partition, and variant count.");
  }
}

export function readAndValidateEpic0439EvidenceManifest(filePath: string): Epic0439EvidenceManifest {
  const schema = readJsonFile<JsonRecord>(evidenceManifestSchemaPath);
  const value = readJsonFile<unknown>(filePath);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const detail = validate.errors?.map((entry) => `${entry.instancePath || "/"} ${entry.message}`).join("; ");
    throw new Error(`Invalid EPIC-0439 evidence manifest: ${detail}`);
  }
  return value as Epic0439EvidenceManifest;
}

export function verifyEpic0439LiveEvidenceReceipt(rawBytes: Buffer): {
  schema: "dynamic-revit-live-evidence/v1" | "dynamic-revit-phase2-live-evidence/v0";
  completed: boolean;
  executionTimeMs: number;
  recoveryOutcome: "not_needed" | "failed" | "outcome_uncertain";
  bindingHash: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Evidence file is not valid JSON.");
  }
  const top = record(parsed, "live evidence");
  const schema = stringField(top, "schema");
  if (schema !== "dynamic-revit-live-evidence/v1" && schema !== "dynamic-revit-phase2-live-evidence/v0") {
    throw new Error(`Unsupported live evidence schema '${schema}'.`);
  }
  const topOk = booleanField(top, "ok");
  const started = Date.parse(stringField(top, "startedUtc"));
  const completed = Date.parse(stringField(top, "completedUtc"));
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) throw new Error("Live evidence timestamps are invalid.");
  const worker = record(top.workerOutput, "workerOutput");
  equal(worker.schema, "dynamic-revit-worker-output/v0", "workerOutput.schema");
  const graph = record(worker.graph, "workerOutput.graph");
  const admission = record(top.admission, "admission");
  const preview = parseEmbeddedReceipt(top.previewReceipt, "previewReceipt");
  equal(preview.receipt.schema, "dynamic-revit-preview-receipt/v0", "previewReceipt.schema");
  const previewHash = sha256Bytes(preview.raw);
  equal(preview.receipt.source_hash, worker.sourceHash, "previewReceipt.source_hash");
  equal(preview.receipt.program_hash, worker.programHash, "previewReceipt.program_hash");
  equal(preview.receipt.sdk_hash, worker.sdkHash, "previewReceipt.sdk_hash");
  equal(preview.receipt.input_hash, graph.inputHash, "previewReceipt.input_hash");
  equal(preview.receipt.graph_hash, graph.graphHash, "previewReceipt.graph_hash");
  equal(preview.receipt.graph_hash, admission.operationGraphHash, "admission.operationGraphHash");
  equal(preview.receipt.document_fingerprint, admission.documentFingerprint, "previewReceipt.document_fingerprint");
  equal(preview.receipt.document_session_id, admission.documentSessionId, "previewReceipt.document_session_id");
  const previewId = stringField(preview.receipt, "preview_id");
  const previewOk = booleanField(preview.receipt, "ok");
  if (previewOk && preview.receipt.rollback_truth !== true) throw new Error("A successful preview must prove rollback truth.");

  let receiptCompleted = topOk && previewOk;
  const binding: JsonRecord = {
    evidence_schema: schema,
    source_hash: stringField(worker, "sourceHash"),
    program_hash: stringField(worker, "programHash"),
    sdk_hash: stringField(worker, "sdkHash"),
    graph_hash: stringField(graph, "graphHash"),
    document_fingerprint: stringField(admission, "documentFingerprint"),
    document_session_id: stringField(admission, "documentSessionId"),
    preview_id: previewId,
    preview_receipt_hash: previewHash
  };

  if (schema === "dynamic-revit-live-evidence/v1") {
    const authorization = parseEmbeddedReceipt(top.applyAuthorizationReceipt, "applyAuthorizationReceipt");
    const apply = parseEmbeddedReceipt(top.applyReceipt, "applyReceipt");
    const v1Admission = record(top.v1Admission, "v1Admission");
    equal(authorization.receipt.schema, "dynamic-revit-apply-authorization-receipt/v1", "applyAuthorizationReceipt.schema");
    equal(apply.receipt.schema, "dynamic-revit-apply-receipt/v1", "applyReceipt.schema");
    equal(v1Admission.schema, "dynamic_program_admission/v1", "v1Admission.schema");
    equal(authorization.receipt.preview_id, previewId, "applyAuthorizationReceipt.preview_id");
    equal(authorization.receipt.preview_receipt_hash, previewHash, "applyAuthorizationReceipt.preview_receipt_hash");
    equal(v1Admission.previewReceiptHash, previewHash, "v1Admission.previewReceiptHash");
    equal(v1Admission.operationGraphHash, graph.graphHash, "v1Admission.operationGraphHash");
    equal(v1Admission.documentFingerprint, admission.documentFingerprint, "v1Admission.documentFingerprint");
    equal(v1Admission.documentSessionId, admission.documentSessionId, "v1Admission.documentSessionId");
    const expectations = record(authorization.receipt.admission_expectations, "applyAuthorizationReceipt.admission_expectations");
    const recomputedEffectBudgetHash = effectBudgetHash(authorization.receipt.effect_budget);
    equal(expectations.OperationGraphHash, graph.graphHash, "admission_expectations.OperationGraphHash");
    equal(expectations.PreviewReceiptHash, previewHash, "admission_expectations.PreviewReceiptHash");
    equal(expectations.EffectBudgetHash, recomputedEffectBudgetHash, "admission_expectations.EffectBudgetHash");
    equal(v1Admission.effectBudgetHash, recomputedEffectBudgetHash, "v1Admission.effectBudgetHash");
    equal(apply.receipt.admission_id, v1Admission.admissionId, "applyReceipt.admission_id");
    equal(apply.receipt.preview_id, previewId, "applyReceipt.preview_id");
    equal(apply.receipt.preview_receipt_hash, previewHash, "applyReceipt.preview_receipt_hash");
    equal(apply.receipt.final_authorization_hash, v1Admission.finalAuthorizationHash, "applyReceipt.final_authorization_hash");
    equal(apply.receipt.graph_hash, graph.graphHash, "applyReceipt.graph_hash");
    equal(apply.receipt.effect_budget_hash, v1Admission.effectBudgetHash, "applyReceipt.effect_budget_hash");
    equal(apply.receipt.document_fingerprint, admission.documentFingerprint, "applyReceipt.document_fingerprint");
    equal(apply.receipt.document_session_id, admission.documentSessionId, "applyReceipt.document_session_id");
    sameStringSet(apply.receipt.changed_element_ids, preview.receipt.projected_changed_element_ids, "applyReceipt.changed_element_ids");
    const authorizationGranted = booleanField(authorization.receipt, "authorization_granted");
    const applyCommitted = apply.receipt.outcome === "committed_verified";
    receiptCompleted = receiptCompleted && authorizationGranted && applyCommitted;
    Object.assign(binding, {
      admission_id: stringField(v1Admission, "admissionId"),
      final_authorization_hash: stringField(v1Admission, "finalAuthorizationHash"),
      apply_receipt_hash: sha256Bytes(apply.raw),
      effect_budget_hash: stringField(v1Admission, "effectBudgetHash"),
      changed_element_ids: elementIdArray(apply.receipt.changed_element_ids, "applyReceipt.changed_element_ids").sort()
    });
  }

  return {
    schema,
    completed: receiptCompleted,
    executionTimeMs: completed - started,
    recoveryOutcome: top.failure == null ? "not_needed" : topOk ? "outcome_uncertain" : "failed",
    bindingHash: sha256Bytes(canonicalJson(binding))
  };
}

function metrics(entry: Epic0439EvidenceEntry, verified: ReturnType<typeof verifyEpic0439LiveEvidenceReceipt>): Epic0439Metrics {
  return {
    completion: verified.completed,
    correctness: 0,
    changed_element_precision: 0,
    model_turns: entry.telemetry.model_turns,
    tool_rpc_calls: entry.telemetry.tool_rpc_calls,
    generated_code_bytes: entry.telemetry.generated_code_bytes,
    execution_time_ms: verified.executionTimeMs,
    estimated_cost_usd: entry.telemetry.estimated_cost_usd,
    input_tokens: entry.telemetry.input_tokens,
    output_tokens: entry.telemetry.output_tokens,
    preview_repairs: entry.telemetry.preview_repairs,
    verification_quality: 0,
    special_purpose_product_code_bytes: entry.telemetry.special_purpose_product_code_bytes,
    recovery_attempts: entry.telemetry.recovery_attempts,
    recovery_outcome: verified.recoveryOutcome
  };
}

export function ingestEpic0439EvidenceCampaign(options: {
  manifest: Epic0439UsefulnessManifest;
  caseSetPath: string;
  evidenceManifestPath: string;
  evidenceRoot: string;
}): Epic0439Result[] {
  const caseSetBytes = fs.readFileSync(options.caseSetPath);
  const caseSet = validateCaseSet(JSON.parse(caseSetBytes.toString("utf8")) as unknown, options.manifest.suite_id);
  verifyCanonicalCaseMaterialization(caseSet, options.manifest);
  const evidenceManifest = readAndValidateEpic0439EvidenceManifest(options.evidenceManifestPath);
  equal(evidenceManifest.suite_id, options.manifest.suite_id, "evidence_manifest.suite_id");
  const caseSetHash = sha256Bytes(caseSetBytes);
  equal(evidenceManifest.case_set_sha256, caseSetHash, "evidence_manifest.case_set_sha256");
  const expectedCardinality = caseSet.cases.reduce((sum, benchmarkCase) => sum + benchmarkCase.execution_config_ids.length, 0);
  if (evidenceManifest.entries.length !== expectedCardinality) {
    throw new Error(`Evidence campaign must contain exactly ${expectedCardinality} case/config entries; found ${evidenceManifest.entries.length}.`);
  }
  const casesById = new Map(caseSet.cases.map((entry) => [entry.case_id, entry]));
  const seen = new Set<string>();
  const results: Epic0439Result[] = [];
  for (const entry of evidenceManifest.entries) {
    const benchmarkCase = casesById.get(entry.case_id);
    if (!benchmarkCase) throw new Error(`Evidence entry references unknown case '${entry.case_id}'.`);
    if (entry.task_id !== benchmarkCase.task_id) throw new Error(`Evidence entry '${entry.case_id}' has the wrong task id.`);
    if (!benchmarkCase.execution_config_ids.includes(entry.config_id)) throw new Error(`Evidence entry '${entry.case_id}' has the wrong config '${entry.config_id}'.`);
    const config = options.manifest.execution_configs.find((candidate) => candidate.config_id === entry.config_id);
    if (!config || config.representation !== entry.representation) throw new Error(`Evidence entry '${entry.case_id}' has the wrong representation.`);
    const pair = `${entry.case_id}\0${entry.config_id}`;
    if (seen.has(pair)) throw new Error(`Duplicate evidence entry for case/config '${entry.case_id}/${entry.config_id}'.`);
    seen.add(pair);
    const evidencePath = validateEvidencePath(options.evidenceRoot, entry.evidence_file);
    const evidenceBytes = fs.readFileSync(evidencePath);
    const evidenceHash = sha256Bytes(evidenceBytes);
    if (!sha256Pattern.test(entry.evidence_sha256) || entry.evidence_sha256 !== evidenceHash) {
      throw new Error(`Evidence hash mismatch for '${entry.case_id}/${entry.config_id}'.`);
    }
    const verified = verifyEpic0439LiveEvidenceReceipt(evidenceBytes);
    results.push({
      schema_version: "epic0439_result/v1",
      case_id: entry.case_id,
      task_id: entry.task_id,
      config_id: entry.config_id,
      representation: entry.representation,
      evidence_tier: "live_revit_unverified",
      metrics: metrics(entry, verified),
      failure: verified.completed ? null : {
        phase: "verification",
        classification: "evidence_receipt_not_completed",
        summary: "The scorer could not establish a completed preview/apply chain from the supplied receipt."
      },
      notes: [
        "Receipt schemas, file bytes, and internal canonical bindings were verified by the scorer.",
        "The runtime receipt does not authenticate this benchmark case/config assignment, so correctness, precision, and verification credit are withheld."
      ],
      scorer_evidence_receipt: {
        schema_version: "epic0439_scorer_evidence_receipt/v1",
        evidence_file_sha256: evidenceHash,
        canonical_binding_sha256: verified.bindingHash,
        receipt_schema: verified.schema,
        authenticated_campaign_binding: false
      }
    });
  }
  for (const benchmarkCase of caseSet.cases) {
    for (const configId of benchmarkCase.execution_config_ids) {
      if (!seen.has(`${benchmarkCase.case_id}\0${configId}`)) throw new Error(`Missing evidence entry for '${benchmarkCase.case_id}/${configId}'.`);
    }
  }
  return results;
}
