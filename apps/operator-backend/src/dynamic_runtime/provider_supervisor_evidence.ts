import { createHash } from "node:crypto";
import path from "node:path";
import { verifyEpic0439LiveEvidenceReceipt } from "../benchmark/epic0439_evidence.js";

type JsonRecord = Record<string, unknown>;

const HASH = /^sha256:[a-f0-9]{64}$/;
const HMAC = /^hmac-sha256:[a-f0-9]{64}$/;
const TOP_FIELDS = [
  "schema", "ok", "startedUtc", "completedUtc", "sandboxProfile", "taskDirectory",
  "registrationReceipt", "snapshotReceipt", "workerOutput", "admission", "previewReceipt",
  "applyAuthorizationReceipt", "v1Admission", "applyReceipt", "hostAuthenticationReceipts",
  "replayEvidence", "failure", "runtimeImageDirectory", "runtimeImageIdentity",
  "runtimeDependencyCount", "targetRevitYear", "expectedHostExecutable", "observedHostExecutable"
] as const;

export type NormalizedProviderSupervisorEvidence = {
  schema: "dynamic-revit-live-evidence/v1" | "dynamic-revit-phase2-live-evidence/v0";
  binding_sha256: string;
  supervisor_package_sha256: string;
  worker_runtime_package_sha256: string;
  target_revit_year: "2023" | "2024" | "2025" | "2026";
  document_session_id: string;
  runtime_instance_id: string;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function exact(value: JsonRecord, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function string(value: JsonRecord, key: string, pattern?: RegExp): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0") || (pattern && !pattern.test(candidate))) {
    throw new Error(`supervisor evidence ${key} is invalid`);
  }
  return candidate;
}

function parseReceipt(value: unknown, label: string): { raw: string; value: JsonRecord } {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is empty`);
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error(`${label} is not valid JSON`); }
  return { raw: value, value: record(parsed, label) };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} is not bound to the requested execution`);
}

function equalObject(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} embedded receipt was tampered`);
}

function validateReadReport(top: JsonRecord, worker: JsonRecord, admission: JsonRecord, graph: JsonRecord): string {
  const report = parseReceipt(top.previewReceipt, "read report receipt");
  equal(report.value.schema, "dynamic-revit-read-report-receipt/v0", "read report schema");
  equal(report.value.ok, true, "read report outcome");
  equal(report.value.sourceHash, worker.sourceHash, "read report source hash");
  equal(report.value.programHash, worker.programHash, "read report program hash");
  equal(report.value.sdkHash, worker.sdkHash, "read report SDK hash");
  equal(report.value.inputHash, graph.inputHash, "read report input hash");
  equal(report.value.graphHash, graph.graphHash, "read report graph hash");
  equal(report.value.documentFingerprint, admission.documentFingerprint, "read report document fingerprint");
  equal(report.value.documentSessionId, admission.documentSessionId, "read report document session");
  equalObject(report.value.workerIdentity, admission, "read report worker identity");
  const operations = graph.operations;
  if (!Array.isArray(operations) || operations.length !== 0) throw new Error("read report requires an empty operation graph");
  return sha256(report.raw);
}

function validateAuthenticatedHostReceipts(top: JsonRecord, runtimeId: string, launcherHash: string, apply: boolean, readReport: boolean): void {
  const entries = top.hostAuthenticationReceipts;
  if (!Array.isArray(entries)) throw new Error("host authentication receipts must be an array");
  const expected = readReport
    ? [["snapshot-receipt", top.snapshotReceipt], ["register-worker-receipt", top.registrationReceipt]] as const
    : apply
      ? [["snapshot-receipt", top.snapshotReceipt], ["register-worker-receipt", top.registrationReceipt], ["preview-receipt", top.previewReceipt], ["authorize-apply-receipt", top.applyAuthorizationReceipt], ["apply-receipt", top.applyReceipt]] as const
      : [["snapshot-receipt", top.snapshotReceipt], ["register-worker-receipt", top.registrationReceipt], ["preview-receipt", top.previewReceipt]] as const;
  if (entries.length !== expected.length + 1) throw new Error("host authentication receipt count does not match the execution phase");
  const bootstrap = parseReceipt(entries[0], "bootstrap receipt").value;
  exact(bootstrap, ["schema", "ok", "runtimeInstanceId", "launcherProcessId", "revitProcessId", "expiresUnixSeconds", "launcherExecutableHash", "proofHash", "hostProofMac"], "bootstrap receipt");
  equal(bootstrap.schema, "dynamic-revit-bootstrap-receipt/v0", "bootstrap schema");
  equal(bootstrap.ok, true, "bootstrap outcome");
  equal(bootstrap.runtimeInstanceId, runtimeId, "bootstrap runtime identity");
  equal(bootstrap.launcherExecutableHash, launcherHash, "bootstrap launcher identity");
  string(bootstrap, "proofHash", HASH);
  string(bootstrap, "hostProofMac", HMAC);
  for (let index = 0; index < expected.length; index += 1) {
    const [purpose, embedded] = expected[index]!;
    const envelope = parseReceipt(entries[index + 1], `${purpose} authentication`).value;
    exact(envelope, ["schema", "runtime_instance_id", "purpose", "expires_unix_seconds", "receipt_hash", "host_receipt_mac", "receipt"], `${purpose} authentication`);
    equal(envelope.schema, "dynamic-revit-authenticated-receipt/v0", `${purpose} authentication schema`);
    equal(envelope.runtime_instance_id, runtimeId, `${purpose} runtime identity`);
    equal(envelope.purpose, purpose, `${purpose} purpose`);
    if (typeof embedded !== "string" || !embedded) throw new Error(`${purpose} embedded receipt is absent`);
    equal(envelope.receipt_hash, sha256(embedded), `${purpose} hash`);
    string(envelope, "host_receipt_mac", HMAC);
    equalObject(envelope.receipt, JSON.parse(embedded) as unknown, `${purpose} authentication`);
  }
}

export function normalizeProviderSupervisorEvidence(rawBytes: Buffer, expected: {
  applyRequested: boolean;
  targetRevitYear: "2023" | "2024" | "2025" | "2026";
  source: string;
  supervisorPackageSha256: string;
  workerRuntimePackageSha256: string;
}): NormalizedProviderSupervisorEvidence {
  if (!HASH.test(expected.supervisorPackageSha256) || !HASH.test(expected.workerRuntimePackageSha256)) {
    throw new Error("trusted supervisor and worker package pins must be canonical sha256 identities");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawBytes.toString("utf8")) as unknown; } catch { throw new Error("supervisor evidence is not valid JSON"); }
  const top = record(parsed, "supervisor evidence");
  exact(top, TOP_FIELDS, "supervisor evidence");
  const expectedSchema = expected.applyRequested ? "dynamic-revit-live-evidence/v1" : "dynamic-revit-phase2-live-evidence/v0";
  equal(top.schema, expectedSchema, "supervisor evidence schema");
  equal(top.ok, true, "supervisor evidence outcome");
  equal(top.failure, null, "supervisor evidence failure state");
  equal(top.targetRevitYear, expected.targetRevitYear, "target Revit year");
  equal(top.runtimeImageIdentity, expected.workerRuntimePackageSha256, "worker runtime package identity");
  equal(top.sandboxProfile, "windows-lpac-v1-zero-capabilities", "sandbox profile");
  if (!Number.isInteger(top.runtimeDependencyCount) || (top.runtimeDependencyCount as number) < 1) throw new Error("runtime dependency count is invalid");
  const expectedHost = string(top, "expectedHostExecutable");
  const observedHost = string(top, "observedHostExecutable");
  if (path.win32.normalize(expectedHost).toLowerCase() !== path.win32.normalize(observedHost).toLowerCase()
    || path.win32.basename(observedHost).toLowerCase() !== "revit.exe"
    || !observedHost.toLowerCase().includes(`revit ${expected.targetRevitYear}`)) {
    throw new Error("observed Revit host executable does not match the trusted target host");
  }
  const worker = record(top.workerOutput, "worker output");
  equal(worker.schema, "dynamic-revit-worker-output/v0", "worker output schema");
  equal(worker.ok, true, "worker output outcome");
  equal(worker.sourceHash, sha256(expected.source), "worker source hash");
  const graph = record(worker.graph, "worker graph");
  const admission = record(top.admission, "worker admission");
  equal(admission.schema, "dynamic-revit-worker-admission/v0", "worker admission schema");
  equal(admission.launcherExecutableHash, expected.supervisorPackageSha256, "worker admission launcher identity");
  equal(admission.sourceHash, worker.sourceHash, "worker admission source hash");
  equal(admission.programHash, worker.programHash, "worker admission program hash");
  equal(admission.sdkHash, worker.sdkHash, "worker admission SDK hash");
  equal(admission.operationGraphHash, graph.graphHash, "worker admission graph hash");
  const runtimeId = string(admission, "runtimeInstanceId");
  const sessionId = string(admission, "documentSessionId");
  const registration = parseReceipt(top.registrationReceipt, "registration receipt").value;
  equal(registration.schema, "dynamic-revit-runtime-registration-receipt/v0", "registration schema");
  equal(registration.ok, true, "registration outcome");
  equal(registration.runtime_instance_id, runtimeId, "registration runtime identity");
  const snapshot = parseReceipt(top.snapshotReceipt, "snapshot receipt").value;
  equal(snapshot.schema, "dynamic-revit-snapshot/v0", "snapshot schema");
  const document = record(snapshot.document, "snapshot document");
  equal(document.ProjectFingerprint, admission.documentFingerprint, "snapshot document fingerprint");
  equal(document.SessionId, sessionId, "snapshot document session");
  equal(snapshot.input_hash, graph.inputHash, "snapshot input hash");
  const preview = parseReceipt(top.previewReceipt, "preview receipt");
  const readReport = preview.value.schema === "dynamic-revit-read-report-receipt/v0";
  let bindingHash: string;
  if (readReport) {
    if (expected.applyRequested) throw new Error("apply execution cannot terminate with a read-only report");
    bindingHash = validateReadReport(top, worker, admission, graph);
  } else {
    const verified = verifyEpic0439LiveEvidenceReceipt(rawBytes);
    if (!verified.completed) throw new Error("supervisor receipt chain did not establish completion");
    bindingHash = verified.bindingHash;
  }
  if (expected.applyRequested) {
    const v1 = record(top.v1Admission, "v1 admission");
    equal(v1.workerRuntimePackageHash, expected.workerRuntimePackageSha256, "v1 worker runtime package identity");
    equal(v1.targetRevitVersion, expected.targetRevitYear, "v1 target Revit version");
    equal(v1.documentSessionId, sessionId, "v1 document session");
  } else if (top.applyAuthorizationReceipt !== null || top.v1Admission !== null || top.applyReceipt !== null) {
    throw new Error("preview evidence unexpectedly carries apply receipts");
  }
  validateAuthenticatedHostReceipts(top, runtimeId, expected.supervisorPackageSha256, expected.applyRequested, readReport);
  return {
    schema: expectedSchema,
    binding_sha256: bindingHash,
    supervisor_package_sha256: expected.supervisorPackageSha256,
    worker_runtime_package_sha256: expected.workerRuntimePackageSha256,
    target_revit_year: expected.targetRevitYear,
    document_session_id: sessionId,
    runtime_instance_id: runtimeId
  };
}
