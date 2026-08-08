import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  admitCertifiedMoveOneRequest,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  readCertifiedMoveOneTransportBinding,
  readLaboratoryMovePreviewLineage,
  registerLaboratoryMovePreviewLineage,
  type CertifiedMoveOneAdmission
} from "./certifiedMoveOneRequestFamily.js";
import { canonicalToolExposureJson } from "./toolExposurePolicy.js";
import {
  EPIC_0437_CANDIDATE_SOURCE_HASH,
  readLaboratoryEvidenceDispatchBinding,
  type LaboratoryEvidenceDispatch,
  type LaboratoryPolicyBinding
} from "./laboratoryEvidenceDispatch.js";

export const LABORATORY_MOVE_EVIDENCE_ADMISSION_SCHEMA = "revit-operator.laboratory-move-evidence-admission.v1";
export const LABORATORY_MOVE_PREVIEW_LINEAGE_SCHEMA = "revit-operator.laboratory-move-preview-lineage.v1";
export const LABORATORY_MOVE_PREVIEW_EFFECT_ID = "revit-operator.certified-move-one.preview.effect.v1";
export const LABORATORY_MOVE_APPLY_EFFECT_ID = "revit-operator.certified-move-one.apply.effect.v1";
export const LABORATORY_MOVE_PREVIEW_EFFECT_HASH = "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b";
export const LABORATORY_MOVE_APPLY_EFFECT_HASH = "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b";

type PreviewLineageDto = Readonly<{
  schema: typeof LABORATORY_MOVE_PREVIEW_LINEAGE_SCHEMA;
  preview_request_instance_hash: string;
  preview_execution_receipt_sha256: string;
  preview_execution_receipt_json: string;
}>;

export type LaboratoryMoveEvidenceAdmissionDto = Readonly<{
  schema: typeof LABORATORY_MOVE_EVIDENCE_ADMISSION_SCHEMA;
  candidate_source_hash: typeof EPIC_0437_CANDIDATE_SOURCE_HASH;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  production_certified: false;
  evidence_run_id: string;
  run_nonce: string;
  request_family_id: typeof CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1;
  request_family_hash: string;
  request_instance_hash: string;
  admission_session_id: string;
  phase: "preview" | "apply";
  effect_id: string;
  effect_hash: string;
  method: "POST";
  path: "/revit/move-elements";
  outbound_body_sha256: string;
  document_fingerprint: string;
  document_session_id: string;
  source_scoped_id: string;
  element_id: number;
  observation_id: string;
  observation_binding_hash: string;
  native_attestation_key_id: string;
  native_attestation_modulus_base64url: string;
  native_attestation_exponent_base64url: string;
  channel: "typed_mcp";
  alias: "revit_move_one_certified";
  preview_lineage: PreviewLineageDto | null;
  laboratory_move_evidence_admission_hash: string;
}>;

export type LaboratoryMoveEvidenceAdmission = Readonly<{
  request: CertifiedMoveOneAdmission;
  evidenceRunId: string;
  outboundBody: CertifiedMoveOneAdmission["outboundBody"];
}>;

const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();
const previewLineageIssued = new WeakSet<object>();
type LaboratoryMoveEvidenceAdmissionBaseDto = Omit<LaboratoryMoveEvidenceAdmissionDto,
  "policy_hash" | "policy_record_hash" | "evidence_record_hash" | "laboratory_move_evidence_admission_hash">;
const baseDtoByAdmission = new WeakMap<object, LaboratoryMoveEvidenceAdmissionBaseDto>();
const dtoByAdmission = new WeakMap<object, LaboratoryMoveEvidenceAdmissionDto>();
const dispatchByAdmission = new WeakMap<object, LaboratoryEvidenceDispatch>();

function requireExactLane(env: NodeJS.ProcessEnv = process.env): void {
  if (env.REVIT_OPERATOR_MODE !== "development"
    || env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1") {
    throw new Error("Move-family evidence admission requires exact protected development/laboratory mode.");
  }
}

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Laboratory move evidence contains a non-JSON value.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Reuses the actual typed validator and emits a distinct, non-production capability. */
export function admitLaboratoryMoveEvidenceRequest(input: {
  evidenceDispatch: LaboratoryEvidenceDispatch;
  request: unknown;
}, env: NodeJS.ProcessEnv = process.env): LaboratoryMoveEvidenceAdmission {
  requireExactLane(env);
  if (Object.keys(input).length !== 2) throw new Error("Laboratory move evidence input contains unknown fields.");
  const dispatch = readLaboratoryEvidenceDispatchBinding(input.evidenceDispatch);
  const request = admitCertifiedMoveOneRequest(input.request);
  const binding = readCertifiedMoveOneTransportBinding(request);
  const lineage = readLaboratoryMovePreviewLineage(request);
  const phase = request.request.phase;
  const previewLineage: PreviewLineageDto | null = lineage ? Object.freeze({
    schema: LABORATORY_MOVE_PREVIEW_LINEAGE_SCHEMA,
    preview_request_instance_hash: lineage.previewRequestInstanceHash,
    preview_execution_receipt_sha256: lineage.previewExecutionReceiptSha256,
    preview_execution_receipt_json: lineage.previewExecutionReceiptJson
  }) : null;
  const payload = Object.freeze({
    schema: LABORATORY_MOVE_EVIDENCE_ADMISSION_SCHEMA,
    candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
    production_certified: false as const,
    evidence_run_id: dispatch.evidenceRunId,
    run_nonce: randomBytes(32).toString("hex"),
    request_family_id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
    request_family_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
    request_instance_hash: request.requestInstanceHash,
    admission_session_id: request.admissionSessionId,
    phase,
    effect_id: phase === "preview" ? LABORATORY_MOVE_PREVIEW_EFFECT_ID : LABORATORY_MOVE_APPLY_EFFECT_ID,
    effect_hash: phase === "preview" ? LABORATORY_MOVE_PREVIEW_EFFECT_HASH : LABORATORY_MOVE_APPLY_EFFECT_HASH,
    method: "POST" as const,
    path: "/revit/move-elements" as const,
    outbound_body_sha256: binding.outbound_body_sha256,
    document_fingerprint: request.request.documentFingerprint,
    document_session_id: request.request.documentSessionId,
    source_scoped_id: request.request.sourceScopedId,
    element_id: request.request.elementId,
    observation_id: request.request.observationId,
    observation_binding_hash: request.request.observationBindingHash,
    native_attestation_key_id: request.request.nativeAttestationKeyId,
    native_attestation_modulus_base64url: request.request.nativeAttestationModulusBase64Url,
    native_attestation_exponent_base64url: request.request.nativeAttestationExponentBase64Url,
    channel: "typed_mcp" as const,
    alias: "revit_move_one_certified" as const,
    preview_lineage: previewLineage
  });
  const admission = Object.freeze({ request, evidenceRunId: dispatch.evidenceRunId, outboundBody: request.outboundBody });
  issued.add(admission);
  baseDtoByAdmission.set(admission, payload);
  dispatchByAdmission.set(admission, input.evidenceDispatch);
  return admission;
}

export function isLaboratoryMoveEvidenceAdmission(value: unknown): value is LaboratoryMoveEvidenceAdmission {
  return !!value && typeof value === "object" && issued.has(value as object) && !consumed.has(value as object);
}

/** One-use wire serialization; exact route/body/channel/alias substitutions fail closed. */
export function consumeLaboratoryMoveEvidenceAdmission(input: {
  admission: LaboratoryMoveEvidenceAdmission;
  method: string;
  path: string;
  bodyJson: string;
  channel: string;
  alias: string;
  policy: LaboratoryPolicyBinding;
}, env: NodeJS.ProcessEnv = process.env): LaboratoryMoveEvidenceAdmissionDto {
  requireExactLane(env);
  if (!isLaboratoryMoveEvidenceAdmission(input.admission)) throw new Error("Move-family evidence admission was not issued by this runtime or was replayed.");
  const baseDto = baseDtoByAdmission.get(input.admission as object);
  const exactBody = canonicalToolExposureJson(input.admission.outboundBody);
  if (!baseDto || input.method !== "POST" || input.path !== "/revit/move-elements"
    || input.channel !== "typed_mcp" || input.alias !== "revit_move_one_certified"
    || input.bodyJson !== exactBody || sha(exactBody) !== baseDto.outbound_body_sha256
    || ![input.policy.policyHash, input.policy.policyRecordHash, input.policy.evidenceRecordHash]
      .every(value => /^sha256:[0-9a-f]{64}$/.test(value))
    || input.policy.effectHash !== baseDto.effect_hash) {
    throw new Error("Move-family evidence admission does not bind the exact typed route, body, channel, and alias.");
  }
  const payload = Object.freeze({
    ...baseDto,
    policy_hash: input.policy.policyHash,
    policy_record_hash: input.policy.policyRecordHash,
    evidence_record_hash: input.policy.evidenceRecordHash
  });
  const dto = Object.freeze({ ...payload, laboratory_move_evidence_admission_hash: sha(canonical(payload)) });
  dtoByAdmission.set(input.admission as object, dto);
  consumed.add(input.admission as object);
  return dto;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} has unknown or missing fields.`);
}

const RECEIPT_KEYS = [
  "schema", "request_id", "dispatch_id", "transport_request_nonce", "transport_server_epoch",
  "transport_issued_at_utc", "laboratory_evidence", "laboratory_evidence_hash", "laboratory_move_evidence",
  "method", "path", "body_present", "raw_body_sha256", "canonical_body_sha256", "phase", "effect_id",
  "effect_hash", "channel", "alias", "document_fingerprint", "document_session_id",
  "native_common_assembly_sha256", "native_logic_assembly_sha256", "native_bridge_assembly_sha256",
  "native_attestation_algorithm", "native_attestation_key_id", "native_attestation_modulus_base64url",
  "native_attestation_exponent_base64url", "result_hash", "outcome", "outcome_unknown", "issued_at_utc",
  "native_attestation_signature"
] as const;
const DISPATCH_KEYS = [
  "schema", "candidate_source_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash", "evidence_run_id", "evidence_step", "transport_kind", "job_id",
  "correlation_id", "workflow", "channel", "alias", "production_certified"
] as const;
const PROJECTION_KEYS = [
  "admission_hash", "run_nonce", "request_family_id", "request_family_hash", "request_instance_hash", "admission_session_id",
  "phase", "effect_id", "effect_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "outbound_body_sha256", "document_fingerprint", "document_session_id",
  "source_scoped_id", "element_id", "observation_id", "observation_binding_hash", "native_attestation_key_id",
  "native_attestation_modulus_base64url", "native_attestation_exponent_base64url", "channel", "alias",
  "preview_lineage_receipt_hash"
] as const;

export function assertLaboratoryMoveExecutionReceipt(
  admission: LaboratoryMoveEvidenceAdmission,
  resultValue: unknown,
  env: NodeJS.ProcessEnv = process.env
): Readonly<Record<string, unknown>> {
  requireExactLane(env);
  if (!issued.has(admission as object)) throw new Error("Laboratory move admission was not issued by this runtime.");
  if (!resultValue || typeof resultValue !== "object" || Array.isArray(resultValue)) throw new Error("Laboratory move result is invalid.");
  const result = resultValue as Record<string, unknown>;
  const phase = admission.request.request.phase;
  if (result.rolledBack !== (phase === "preview") || !Array.isArray(result.movedIds) || result.movedIds.length !== 1
    || result.movedIds[0] !== admission.request.request.elementId || !Array.isArray(result.skipped) || result.skipped.length !== 0) {
    throw new Error("Laboratory move result does not prove the exact one-target phase outcome.");
  }
  const receiptValue = result.laboratory_execution_receipt;
  if (!receiptValue || typeof receiptValue !== "object" || Array.isArray(receiptValue)) throw new Error("Laboratory move omitted its native execution receipt.");
  const receipt = receiptValue as Record<string, unknown>;
  exactKeys(receipt, RECEIPT_KEYS, "laboratory execution receipt");
  const dto = dtoByAdmission.get(admission as object)!;
  const move = receipt.laboratory_move_evidence;
  if (!move || typeof move !== "object" || Array.isArray(move)) throw new Error("Laboratory move receipt omitted its move-family projection.");
  const projection = move as Record<string, unknown>;
  exactKeys(projection, PROJECTION_KEYS, "laboratory move evidence projection");
  const laboratoryEvidence = receipt.laboratory_evidence;
  if (!laboratoryEvidence || typeof laboratoryEvidence !== "object" || Array.isArray(laboratoryEvidence)) throw new Error("Laboratory move receipt omitted dispatch provenance.");
  const dispatch = laboratoryEvidence as Record<string, unknown>;
  exactKeys(dispatch, DISPATCH_KEYS, "laboratory evidence dispatch");
  const localDispatch = dispatchByAdmission.get(admission as object)!;
  const expectedPreviewHash = dto.preview_lineage?.preview_execution_receipt_sha256 ?? null;
  const expected: Array<[unknown, unknown]> = [
    [projection.admission_hash, dto.laboratory_move_evidence_admission_hash],
    [projection.run_nonce, dto.run_nonce],
    [projection.request_family_id, dto.request_family_id], [projection.request_family_hash, dto.request_family_hash],
    [projection.request_instance_hash, dto.request_instance_hash], [projection.admission_session_id, dto.admission_session_id],
    [projection.phase, phase], [projection.effect_id, dto.effect_id], [projection.effect_hash, dto.effect_hash],
    [projection.policy_hash, dto.policy_hash], [projection.policy_record_hash, dto.policy_record_hash],
    [projection.evidence_record_hash, dto.evidence_record_hash],
    [projection.document_fingerprint, dto.document_fingerprint], [projection.document_session_id, dto.document_session_id],
    [projection.source_scoped_id, dto.source_scoped_id], [projection.element_id, dto.element_id],
    [projection.observation_id, dto.observation_id], [projection.observation_binding_hash, dto.observation_binding_hash],
    [projection.outbound_body_sha256, dto.outbound_body_sha256],
    [projection.native_attestation_key_id, dto.native_attestation_key_id],
    [projection.native_attestation_modulus_base64url, dto.native_attestation_modulus_base64url],
    [projection.native_attestation_exponent_base64url, dto.native_attestation_exponent_base64url],
    [projection.channel, dto.channel], [projection.alias, dto.alias], [projection.preview_lineage_receipt_hash, expectedPreviewHash],
    [receipt.schema, "revit-operator.laboratory-execution-receipt.v1"], [receipt.method, dto.method], [receipt.path, dto.path],
    [receipt.body_present, true], [receipt.raw_body_sha256, dto.outbound_body_sha256],
    [receipt.canonical_body_sha256, dto.outbound_body_sha256], [receipt.phase, phase], [receipt.effect_id, dto.effect_id],
    [receipt.effect_hash, dto.effect_hash], [receipt.channel, dto.channel], [receipt.alias, dto.alias],
    [receipt.document_fingerprint, dto.document_fingerprint], [receipt.document_session_id, dto.document_session_id],
    [receipt.outcome, phase === "preview" ? "rolled_back" : "committed"], [receipt.outcome_unknown, false],
    [receipt.native_attestation_algorithm, "RS256"], [receipt.native_attestation_key_id, dto.native_attestation_key_id],
    [receipt.native_attestation_modulus_base64url, dto.native_attestation_modulus_base64url],
    [receipt.native_attestation_exponent_base64url, dto.native_attestation_exponent_base64url],
    [dispatch.schema, "revit-operator.laboratory-evidence-dispatch.v2"],
    [dispatch.candidate_source_hash, EPIC_0437_CANDIDATE_SOURCE_HASH], [dispatch.evidence_run_id, dto.evidence_run_id],
    [dispatch.policy_hash, dto.policy_hash], [dispatch.policy_record_hash, dto.policy_record_hash],
    [dispatch.evidence_record_hash, dto.evidence_record_hash], [dispatch.effect_hash, dto.effect_hash],
    [dispatch.evidence_step, localDispatch.evidenceStep], [dispatch.workflow, localDispatch.workflow],
    [dispatch.channel, dto.channel], [dispatch.alias, dto.alias], [dispatch.production_certified, false]
  ];
  if (expected.some(([actual, wanted]) => actual !== wanted)
    || (dispatch.transport_kind !== "direct" && dispatch.transport_kind !== "courier")
    || (dispatch.transport_kind === "direct" && (dispatch.job_id !== null || dispatch.correlation_id !== null))
    || (dispatch.transport_kind === "courier" && (typeof dispatch.job_id !== "string" || !/^[0-9a-f]{64}$/.test(dispatch.job_id) || dispatch.correlation_id !== dispatch.job_id))
    || receipt.laboratory_evidence_hash !== sha(canonical(dispatch))) {
    throw new Error("Native laboratory move receipt does not bind the exact admitted family request and dispatch.");
  }
  const { laboratory_execution_receipt: _receipt, ...nativeResult } = result;
  if (receipt.result_hash !== sha(canonical(nativeResult))) throw new Error("Native laboratory receipt does not bind the exact handler result.");
  if (typeof receipt.native_attestation_signature !== "string") throw new Error("Native laboratory move receipt signature is missing.");
  const { native_attestation_signature: signature, ...signed } = receipt;
  const key = createPublicKey({
    key: { kty: "RSA", alg: "RS256", n: dto.native_attestation_modulus_base64url, e: dto.native_attestation_exponent_base64url },
    format: "jwk"
  });
  if (!verify("sha256", Buffer.from(canonical(signed), "utf8"), key, Buffer.from(signature as string, "base64url"))) {
    throw new Error("Native laboratory move receipt signature is invalid.");
  }
  return receipt;
}

/** Verifies native rollback before minting the typed validator's one-use token. */
export function issueLaboratoryMovePreviewLineage(
  admission: LaboratoryMoveEvidenceAdmission,
  resultValue: unknown,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (admission.request.request.phase !== "preview") throw new Error("Only a laboratory preview may mint lineage.");
  if (previewLineageIssued.has(admission as object)) throw new Error("Laboratory preview lineage was already issued for this exact admission.");
  const receipt = assertLaboratoryMoveExecutionReceipt(admission, resultValue, env);
  const receiptJson = canonical(receipt);
  previewLineageIssued.add(admission as object);
  return registerLaboratoryMovePreviewLineage(admission.request, receiptJson, sha(receiptJson), env);
}
