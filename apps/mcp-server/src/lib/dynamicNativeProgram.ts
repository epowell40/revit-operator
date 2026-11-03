import {normalizeNativeParameterChecks,type NativeParameterCheck} from "@revitoperator/assignment-kernel-v2-contracts";
export {normalizeNativeParameterChecks} from "@revitoperator/assignment-kernel-v2-contracts";
import { createHash } from "node:crypto";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

export type NativeProgramInput = {
  entry_type: string;
  effect_scope?: "listed_elements" | "active_document";
  allowed_existing_unique_ids?: string[];
  allow_create?: boolean;
  max_affected_elements?: number;
  deadline_ms?: number;
  parameter_checks?: NativeParameterCheck[];
};

/** Requested bounds, never authority. Identity comes from the admitted task. */
export function normalizeNativeProgram(value: NativeProgramInput, mode: string, year: string,
  fingerprint: string | undefined, env: NodeJS.ProcessEnv) {
  const input = object(value);
  // Exposure is not write authority: the authenticated assignment and native
  // launcher still bind every execution to its document, source and scope.
  const localGeneral = ["local", "self_hosted"].includes(env.REVIT_OPERATOR_MODE ?? "")
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "general";
  const developmentLaboratory = env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
  const hostedGeneral = (env.REVIT_OPERATOR_MODE === "hosted" || env.REVIT_OPERATOR_MODE === "production")
    && env.OPERATOR_REVIT_TRANSPORT === "courier";
  if (!(localGeneral || hostedGeneral || developmentLaboratory) || !["2023", "2024", "2025", "2026", "2027"].includes(year) || !["read", "apply"].includes(mode))
    throw new Error("Native C# requires a local General Agent, hosted workstation courier or development/laboratory, a supported Revit target and explicit read or apply mode.");
  const expectedDocumentFingerprint = fingerprint?.startsWith("sha256:") ? fingerprint : `sha256:${fingerprint}`;
  if (!hash(expectedDocumentFingerprint)) throw new Error("Native C# requires the admitted task's current document identity.");
  if (Object.keys(input).some(key => !["entry_type", "effect_scope", "allowed_existing_unique_ids", "allow_create", "max_affected_elements", "deadline_ms", "parameter_checks"].includes(key))
      || typeof input.entry_type !== "string" || !input.entry_type.trim() || input.entry_type.length > 256 || /[\x00-\x1f\x7f]/.test(input.entry_type))
    throw new Error("Native C# entry type or request fields are invalid.");
  normalizeNativeParameterChecks(input.parameter_checks, mode);
  const ids = input.allowed_existing_unique_ids ?? [];
  const effectScope = input.effect_scope === undefined ? "listed_elements" : input.effect_scope;
  if (!["listed_elements", "active_document"].includes(String(effectScope))
      || effectScope === "active_document" && (mode !== "apply" || ["allowed_existing_unique_ids", "allow_create", "max_affected_elements"].some(k => Object.hasOwn(input, k))))
    throw new Error("Active-document scope is explicit write authority; do not mix it with listed-element restrictions or read mode.");
  const create = input.allow_create ?? false, maximum = input.max_affected_elements ?? (mode === "read" || effectScope === "active_document" ? 0 : 32), deadline = input.deadline_ms ?? 5000;
  if (!Array.isArray(ids) || ids.length > 64 || ids.some(id => typeof id !== "string" || !id.trim() || id.length > 512 || /[\x00-\x1f\x7f]/.test(id))
      || new Set(ids).size !== ids.length || typeof create !== "boolean" || !Number.isSafeInteger(maximum)
      || !Number.isSafeInteger(deadline) || Number(deadline) < 250 || Number(deadline) > 10000
      || mode === "read" && (ids.length !== 0 || create || maximum !== 0)
      || mode === "apply" && effectScope === "listed_elements" && (Number(maximum) < 1 || Number(maximum) > 64 || !create && ids.length === 0))
    throw new Error("Native C# target/effect/deadline bounds are invalid.");
  return { expectedDocumentFingerprint, program: { entryType: input.entry_type, mode: mode === "read" ? "read" : "write",
    ...(effectScope === "active_document" ? { effectScope } : {}),
    allowedExistingUniqueIds: ids as string[], allowCreate: create, maxAffectedElements: Number(maximum), deadlineMs: Number(deadline) } };
}

function parseReceipt(value: unknown): RecordValue {
  if (typeof value !== "string" || value.length === 0 || value.length > 2 * 1024 * 1024) throw new Error("Native C# receipt is missing or oversized.");
  const parsed = object(JSON.parse(value));
  if (!Object.keys(parsed).length) throw new Error("Native C# receipt is not an object.");
  return parsed;
}

/** This adapter is called only for the trusted launcher's retained output. The
 * launcher verifies the MAC with its ephemeral key; here we preserve the exact
 * authenticated body/source/document binding at the model-visible boundary. */
export function readNativeProgramEvidence(evidence: RecordValue, sourceHash: string, mode: string, expectedDocument: string) {
  if (evidence.nativeExecutionReceipt == null || evidence.nativeExecutionReceipt === "") {
    if (evidence.ok === true) throw new Error("Native C# success has no native execution receipt.");
    return null; // Lost apply response remains unknown in the existing controller.
  }
  if (evidence.schema !== "dynamic-revit-native-program-evidence/v1" || !hash(sourceHash) || !hash(expectedDocument))
    throw new Error("Native C# evidence identity is invalid.");
  const raw = evidence.nativeExecutionReceipt as string, receipt = parseReceipt(raw);
  const preparationRaw = evidence.snapshotReceipt as string, preparation = parseReceipt(preparationRaw);
  const document = object(preparation.Document), scope = object(preparation.Scope), worker = object(evidence.workerOutput);
  const artifact = object(worker.nativeProgramArtifact), admission = object(evidence.admission);
  if (preparation.Schema !== "dynamic-revit-native-preparation/v1" || preparation.SourceHash !== sourceHash
      || receipt.schema !== "dynamic-revit-native-execution-receipt/v1" || receipt.preparation_id !== preparation.PreparationId
      || receipt.source_hash !== sourceHash || receipt.assembly_hash !== worker.programHash || !hash(receipt.assembly_hash)
      || receipt.native_binding_hash !== admission.operationGraphHash || !hash(receipt.native_binding_hash)
      || document.ProjectFingerprint !== expectedDocument || scope.DocumentFingerprint !== expectedDocument
      || receipt.document_fingerprint !== expectedDocument || admission.documentFingerprint !== expectedDocument
      || typeof document.SessionId !== "string" || !document.SessionId || document.SessionId !== scope.DocumentSessionId
      || receipt.document_session_id !== document.SessionId || admission.documentSessionId !== document.SessionId
      || !Number.isSafeInteger(scope.DocumentRevision) || Number(scope.DocumentRevision) < 0 || receipt.document_revision_before !== scope.DocumentRevision
      || receipt.verified !== false || receipt.retry_permitted !== false || typeof receipt.success !== "boolean"
      || evidence.ok !== receipt.success || worker.ok !== true || worker.executionStatus !== "compiled_native"
      || worker.executionElapsedMs !== 0 || worker.sourceHash !== sourceHash || admission.sourceHash !== sourceHash
      || admission.programHash !== receipt.assembly_hash || artifact.sourceHash !== sourceHash || artifact.assemblyHash !== receipt.assembly_hash
      || artifact.mode !== (mode === "read" ? "read" : "write") || !(mode === "read" || mode === "apply")
      || (receipt.success === true && (typeof receipt.program_result !== "string" || receipt.program_result.length > 32768)))
    throw new Error("Native C# execution/source/document/mode binding is invalid.");
  if (!Array.isArray(evidence.hostAuthenticationReceipts)) throw new Error("Native C# authentication receipts are missing.");
  const auth = evidence.hostAuthenticationReceipts.map(parseReceipt);
  const boot = auth.filter(row => row.schema === "dynamic-revit-bootstrap-receipt/v0" && row.ok === true);
  if (boot.length !== 1 || typeof boot[0]!.runtimeInstanceId !== "string" || !boot[0]!.runtimeInstanceId
      || boot[0]!.runtimeInstanceId !== admission.runtimeInstanceId) throw new Error("Native C# bootstrap identity is invalid.");
  for (const [purpose, body, parsed] of [["native-program-prepare-receipt", preparationRaw, preparation], ["native-program-execute-receipt", raw, receipt]] as const) {
    const matches = auth.filter(row => row.schema === "dynamic-revit-authenticated-receipt/v0" && row.purpose === purpose);
    const item = matches[0];
    if (matches.length !== 1 || item!.runtime_instance_id !== boot[0]!.runtimeInstanceId || item!.receipt_hash !== digest(body)
        || !/^hmac-sha256:[a-f0-9]{64}$/.test(String(item!.host_receipt_mac))
        || payloadDigestV2(item!.receipt).digest !== payloadDigestV2(parsed).digest)
      throw new Error("Native C# authenticated receipt body was missing or substituted.");
  }
  const transaction = object(receipt.transaction);
  const effectScope = scope.EffectScope ?? "listed_elements";
  if (!["listed_elements", "active_document"].includes(String(effectScope))
      || (receipt.effect_scope ?? "listed_elements") !== effectScope
      || effectScope === "active_document" && (mode !== "apply" || scope.MaxAffectedElements !== 0 || scope.AllowCreate !== false
        || !Array.isArray(scope.AllowedExistingElementIds) || scope.AllowedExistingElementIds.length !== 0))
    throw new Error("Native C# effect scope is invalid or differs from authenticated preparation.");
  const maxAuditIds = effectScope === "active_document" ? 4096 : 64;
  const ids = (field: string): number[] => {
    const value = transaction[field];
    if (!Array.isArray(value) || value.length > maxAuditIds || value.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(value).size !== value.length)
      throw new Error("Native C# transaction identities are invalid.");
    return value;
  };
  const affected = ids("affected_element_ids"), added = ids("added_element_ids"), modified = ids("modified_element_ids"), deleted = ids("deleted_element_ids");
  let effect: "applied" | "none" | "unknown", transactionState: "committed" | "rolled_back" | "not_started" | "unknown";
  if (transaction.status === "committed" && transaction.committed === true) {
    effect = "applied"; transactionState = "committed";
    if ([...added, ...modified, ...deleted].some(id => !affected.includes(id))) throw new Error("Native C# committed inventory is inconsistent.");
  } else if ((transaction.status === "rolled_back" || transaction.status === "not_started") && transaction.committed === false) {
    effect = "none"; transactionState = transaction.status;
    if (added.length || modified.length || deleted.length) throw new Error("Native C# no-effect receipt claims committed changes.");
  } else if (transaction.committed === null && typeof transaction.status === "string" && transaction.status
      && !["committed", "rolled_back", "not_started"].includes(transaction.status)) { effect = "unknown"; transactionState = "unknown"; }
  else throw new Error("Native C# transaction status and commitment disagree.");
  if (mode === "read" && (effect !== "none" || transactionState !== "not_started" || receipt.read_only !== true || affected.length)
      || mode === "apply" && receipt.success === true && effect !== "applied") throw new Error("Native C# mode/outcome conflict.");
  // Canonical identities use ordinal string order, not the native numeric ID
  // order. Sort only this projection; preserve the authenticated receipt body.
  return { receipt, effect, transactionState, affectedTargetIdentities: affected.map(id => `element_id:${id}`).sort(),
    result: receipt.success === true ? receipt.program_result as string : null };
}
