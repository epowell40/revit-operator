import crypto from "node:crypto";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a JSON object.`);
  return value as JsonRecord;
}
function stringField(value: JsonRecord, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`${field} must be a non-empty string.`);
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
  return values.map(value => `+${Buffer.from(value, "utf8").toString("base64")}\n`).join("");
}
function canonicalSet(value: unknown, field: string): string {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry.trim())) {
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
    stringField(budget, "Schema"), stringField(budget, "BudgetId"),
    canonicalSet(budget.TargetDocumentFingerprints, "effect_budget.TargetDocumentFingerprints"),
    canonicalSet(budget.AllowedCategories, "effect_budget.AllowedCategories"),
    canonicalSet(budget.ExplicitTargetUniqueIds, "effect_budget.ExplicitTargetUniqueIds"),
    canonicalSet(budget.AllowedSdkDomains, "effect_budget.AllowedSdkDomains"),
    canonicalSet(budget.AllowedExternalEffectClasses, "effect_budget.AllowedExternalEffectClasses"),
    stringField(budget, "ViewScopeHash"), stringField(budget, "LevelScopeHash"),
    stringField(budget, "WorksetScopeHash"), stringField(budget, "PhaseScopeHash"),
    integerString(budget, "MaximumOperationCount"), integerString(budget, "MaximumAffectedElements"),
    integerString(budget, "MaximumCreates"), integerString(budget, "MaximumModifications"),
    integerString(budget, "MaximumDeletes"), integerString(budget, "MaximumExecutionMilliseconds"),
    integerString(budget, "MaximumRegenerations"), integerString(budget, "MaximumOutputCount"),
    integerString(budget, "MaximumOutputBytes"), stringField(budget, "FileCapabilitySetHash")
  ]));
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as JsonRecord).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(",")}}`;
}
function parseEmbeddedReceipt(value: unknown, field: string): { raw: string; receipt: JsonRecord } {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must contain a non-empty JSON receipt string.`);
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error(`${field} is not valid JSON.`); }
  return { raw: value, receipt: record(parsed, field) };
}
function equal(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) throw new Error(`${field} does not match its canonical binding.`);
}
function elementIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry =>
    !((typeof entry === "string" && entry.trim()) || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)))) {
    throw new Error(`${field} must be an array of non-empty strings or non-negative integer ids.`);
  }
  return value.map(entry => String(entry));
}
function sameStringSet(actual: unknown, expected: unknown, field: string): void {
  const left = [...elementIdArray(actual, field)].sort();
  const right = [...elementIdArray(expected, field)].sort();
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) {
    throw new Error(`${field} does not match the preview-bound element set.`);
  }
}

function affectedTargetIdentities(value: unknown, field: string): string[] {
  const ids = elementIdArray(value, field);
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicate element ids.`);
  return ids.map(id => `element_id:${id}`).sort();
}

/** Verifies the generic Dynamic Revit receipt chain. The historical EPIC-0439
 * harness consumes this production contract; production does not import the
 * benchmark harness. */
export function verifyDynamicRevitLiveEvidenceReceipt(rawBytes: Buffer): {
  schema: "dynamic-revit-live-evidence/v1" | "dynamic-revit-phase2-live-evidence/v0";
  completed: boolean;
  executionTimeMs: number;
  recoveryOutcome: "not_needed" | "failed" | "outcome_uncertain";
  bindingHash: string;
  affectedTargetIdentities: string[];
} {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBytes.toString("utf8")) as unknown; }
  catch { throw new Error("Evidence file is not valid JSON."); }
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
  let authoritativeAffectedTargets: string[] = [];
  const binding: JsonRecord = {
    evidence_schema: schema,
    source_hash: stringField(worker, "sourceHash"), program_hash: stringField(worker, "programHash"),
    sdk_hash: stringField(worker, "sdkHash"), graph_hash: stringField(graph, "graphHash"),
    document_fingerprint: stringField(admission, "documentFingerprint"),
    document_session_id: stringField(admission, "documentSessionId"), preview_id: previewId,
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
    const budgetHash = effectBudgetHash(authorization.receipt.effect_budget);
    equal(expectations.OperationGraphHash, graph.graphHash, "admission_expectations.OperationGraphHash");
    equal(expectations.PreviewReceiptHash, previewHash, "admission_expectations.PreviewReceiptHash");
    equal(expectations.EffectBudgetHash, budgetHash, "admission_expectations.EffectBudgetHash");
    equal(v1Admission.effectBudgetHash, budgetHash, "v1Admission.effectBudgetHash");
    equal(apply.receipt.admission_id, v1Admission.admissionId, "applyReceipt.admission_id");
    equal(apply.receipt.preview_id, previewId, "applyReceipt.preview_id");
    equal(apply.receipt.preview_receipt_hash, previewHash, "applyReceipt.preview_receipt_hash");
    equal(apply.receipt.final_authorization_hash, v1Admission.finalAuthorizationHash, "applyReceipt.final_authorization_hash");
    equal(apply.receipt.graph_hash, graph.graphHash, "applyReceipt.graph_hash");
    equal(apply.receipt.effect_budget_hash, v1Admission.effectBudgetHash, "applyReceipt.effect_budget_hash");
    equal(apply.receipt.document_fingerprint, admission.documentFingerprint, "applyReceipt.document_fingerprint");
    equal(apply.receipt.document_session_id, admission.documentSessionId, "applyReceipt.document_session_id");
    sameStringSet(apply.receipt.changed_element_ids, preview.receipt.projected_changed_element_ids, "applyReceipt.changed_element_ids");
    receiptCompleted = receiptCompleted && booleanField(authorization.receipt, "authorization_granted")
      && apply.receipt.outcome === "committed_verified";
    const changedElementIds = elementIdArray(apply.receipt.changed_element_ids, "applyReceipt.changed_element_ids").sort();
    authoritativeAffectedTargets = affectedTargetIdentities(apply.receipt.changed_element_ids, "applyReceipt.changed_element_ids");
    Object.assign(binding, {
      admission_id: stringField(v1Admission, "admissionId"),
      final_authorization_hash: stringField(v1Admission, "finalAuthorizationHash"),
      apply_receipt_hash: sha256Bytes(apply.raw), effect_budget_hash: stringField(v1Admission, "effectBudgetHash"),
      changed_element_ids: changedElementIds
    });
  }
  return {
    schema,
    completed: receiptCompleted,
    executionTimeMs: completed - started,
    recoveryOutcome: top.failure == null ? "not_needed" : topOk ? "outcome_uncertain" : "failed",
    bindingHash: sha256Bytes(canonicalJson(binding)),
    affectedTargetIdentities: authoritativeAffectedTargets
  };
}
