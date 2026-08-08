import { createHash } from "node:crypto";
import {
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  isCertifiedMoveOneAdmission,
  readCertifiedMoveOneTransportBinding,
  type CertifiedMoveOneAdmission,
  type CertifiedMoveOneTransportBinding
} from "./certifiedMoveOneRequestFamily.js";
import {
  canonicalToolExposureJson,
  TOOL_EXPOSURE_CANONICALIZATION,
  type ToolExposureChannel,
  type ToolExposureDecision
} from "./toolExposurePolicy.js";

export const CERTIFICATION_ENVELOPE_SCHEMA_V1 = "revit-operator.revit-tool-certification-envelope.v1";
export const CERTIFICATION_ENVELOPE_SCHEMA_V2 = "revit-operator.revit-tool-certification-envelope.v2";
export const REQUEST_FAMILY_ADMISSION_SCHEMA_V1 = "revit-operator.certified-request-family-admission.v1";

export type RequestFamilyAdmissionEnvelope = CertifiedMoveOneTransportBinding;

type CertificationEnvelopeBase = Readonly<{
  canonicalization: typeof TOOL_EXPOSURE_CANONICALIZATION;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  request_hash: string;
  effect_hash: string;
  method: string;
  path: string;
  body_present: boolean;
  body_sha256: string;
  channel: ToolExposureChannel;
  alias: string;
  workflow?: string;
  runtime_mode: string;
  exposure_profile: "certified";
  policy_trust_source: "bundled" | "deployment";
  envelope_hash: string;
}>;

export type ExactCertificationEnvelope = CertificationEnvelopeBase & Readonly<{
  schema: typeof CERTIFICATION_ENVELOPE_SCHEMA_V1;
  version: 1;
}>;

export type FamilyCertificationEnvelope = CertificationEnvelopeBase & Readonly<{
  schema: typeof CERTIFICATION_ENVELOPE_SCHEMA_V2;
  version: 2;
  request_family_admission: RequestFamilyAdmissionEnvelope;
}>;

export type CertificationEnvelope = ExactCertificationEnvelope | FamilyCertificationEnvelope;
const issuedFamilyEnvelopes = new WeakSet<object>();

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function createFamilyAdmission(
  admission: CertifiedMoveOneAdmission,
  decision: ToolExposureDecision,
  bodyJson: string
): RequestFamilyAdmissionEnvelope {
  if (!isCertifiedMoveOneAdmission(admission)) {
    throw new Error("Certified request-family serialization requires a local validator-issued admission capability.");
  }
  if (decision.requestFamily?.schema !== "revit-operator.certified-request-family.v1"
    || decision.requestFamily.id !== admission.familyId
    || decision.requestFamily.validator_hash !== admission.familyHash
    || decision.requestInstanceHash !== admission.requestInstanceHash
    || decision.requestHash !== admission.requestInstanceHash) {
    throw new Error("Certified request-family serialization does not match the exact policy admission decision.");
  }
  if (admission.familyId !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1
    || admission.familyHash !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH) {
    throw new Error("Certified request-family serialization rejected an unknown validator identity.");
  }
  try { JSON.parse(bodyJson); } catch (error) {
    throw new Error("Certified request-family serialization requires strict JSON body bytes.", { cause: error });
  }
  if (bodyJson !== canonicalToolExposureJson(admission.outboundBody)) {
    throw new Error("Certified request-family serialization rejected body bytes that do not match the validator output.");
  }
  const binding = readCertifiedMoveOneTransportBinding(admission);
  if (binding.schema !== REQUEST_FAMILY_ADMISSION_SCHEMA_V1
    || binding.family_id !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1
    || binding.family_hash !== CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH
    || binding.request_instance_hash !== admission.requestInstanceHash
    || binding.outbound_body_sha256 !== sha256(bodyJson)) {
    throw new Error("Certified request-family transport binding does not match the exact admitted request bytes.");
  }
  return binding;
}

/** Builds the one canonical authorization object used by direct and courier execution. */
export function createCertificationEnvelope(input: {
  decision: ToolExposureDecision;
  bodyPresent: boolean;
  bodyJson: string;
  certifiedMoveOneAdmission?: CertifiedMoveOneAdmission;
}): CertificationEnvelope {
  const { decision } = input;
  if (decision.allowed !== true || decision.mode !== "certified"
    || !decision.policyHash || !decision.policyRecordHash || !decision.evidenceRecordHash
    || !decision.policyTrustSource || !decision.alias) {
    throw new Error("Certification envelope requires a complete allowed certified policy decision.");
  }
  const base = {
    canonicalization: TOOL_EXPOSURE_CANONICALIZATION as typeof TOOL_EXPOSURE_CANONICALIZATION,
    policy_hash: decision.policyHash,
    policy_record_hash: decision.policyRecordHash,
    evidence_record_hash: decision.evidenceRecordHash,
    request_hash: decision.requestHash,
    effect_hash: decision.effectHash,
    method: decision.method,
    path: decision.path,
    body_present: input.bodyPresent,
    body_sha256: sha256(input.bodyJson),
    channel: decision.channel,
    alias: decision.alias,
    ...(decision.workflow === undefined ? {} : { workflow: decision.workflow }),
    runtime_mode: decision.runtimeMode,
    exposure_profile: "certified" as const,
    policy_trust_source: decision.policyTrustSource
  };
  const payload = input.certifiedMoveOneAdmission
    ? {
      schema: CERTIFICATION_ENVELOPE_SCHEMA_V2,
      version: 2 as const,
      ...base,
      request_family_admission: createFamilyAdmission(input.certifiedMoveOneAdmission, decision, input.bodyJson)
    }
    : { schema: CERTIFICATION_ENVELOPE_SCHEMA_V1, version: 1 as const, ...base };
  const envelope = Object.freeze({ ...payload, envelope_hash: sha256(canonicalToolExposureJson(payload)) }) as CertificationEnvelope;
  if (envelope.version === 2) issuedFamilyEnvelopes.add(envelope);
  return envelope;
}

/** Rechecks the opaque in-process envelope immediately before protected serialization. */
export function assertIssuedFamilyEnvelopeForDispatch(input: {
  envelope: unknown;
  method: string;
  path: string;
  bodyJson?: string;
  channel?: ToolExposureChannel;
  alias?: string;
}): FamilyCertificationEnvelope {
  const envelope = input.envelope;
  if (!envelope || typeof envelope !== "object" || !issuedFamilyEnvelopes.has(envelope as object)) {
    throw new Error("Protected family dispatch requires a locally issued certification envelope.");
  }
  const value = envelope as FamilyCertificationEnvelope;
  const bodyPresent = input.bodyJson !== undefined;
  if (value.schema !== CERTIFICATION_ENVELOPE_SCHEMA_V2 || value.version !== 2
    || value.method !== input.method || value.path !== input.path
    || value.body_present !== bodyPresent || value.body_sha256 !== sha256(input.bodyJson ?? "")
    || value.request_family_admission.outbound_body_sha256 !== value.body_sha256
    || value.channel !== (input.channel ?? "generic_call")
    || value.alias !== (input.alias ?? "revit_call_tool")) {
    throw new Error("Protected family dispatch certification envelope does not bind the exact request boundary.");
  }
  const { envelope_hash: _ignored, ...payload } = value;
  if (value.envelope_hash !== sha256(canonicalToolExposureJson(payload))) {
    throw new Error("Protected family dispatch certification envelope hash is invalid.");
  }
  return value;
}
