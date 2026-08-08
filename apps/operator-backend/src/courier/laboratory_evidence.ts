import { canonicalJson, type JsonValue } from "../capabilities/tool_certification.js";
import { loadTrustedToolExposurePolicy } from "../capabilities/trusted_tool_exposure_policy.js";

export const EPIC_0437_CANDIDATE_SOURCE_HASH = "sha256:daec4b624b7a0ca07d67fe78bd4f56bf5e5277e7254dfcddf0acc31c344604cc";
export const LABORATORY_EVIDENCE_DISPATCH_SCHEMA = "revit-operator.laboratory-evidence-dispatch.v2";

export type LaboratoryEvidenceDispatch = {
  schema: typeof LABORATORY_EVIDENCE_DISPATCH_SCHEMA;
  candidate_source_hash: typeof EPIC_0437_CANDIDATE_SOURCE_HASH;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  effect_hash: string;
  evidence_run_id: string;
  evidence_step: string;
  transport_kind: "direct" | "courier";
  job_id: string | null;
  correlation_id: string | null;
  workflow: string;
  channel: "typed_mcp";
  alias: string;
  production_certified: false;
};

const EXACT_FIELDS = [
  "schema", "candidate_source_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash", "evidence_run_id", "evidence_step", "transport_kind",
  "job_id", "correlation_id", "workflow", "production_certified"
  , "channel", "alias"
] as const;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STEP = /^[a-z][a-z0-9-]{0,79}$/;
const WORKFLOW = /^[a-z][a-z0-9-]{0,119}$/;

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, fields: readonly string[], location: string): void {
  const actual = Object.keys(record);
  if (actual.length !== fields.length || actual.some(field => !fields.includes(field))) {
    throw new Error(`${location} has missing or unknown fields.`);
  }
}

export function parseLaboratoryEvidenceDispatch(value: unknown): LaboratoryEvidenceDispatch {
  const raw = object(value, "laboratory_evidence");
  exact(raw, EXACT_FIELDS, "laboratory_evidence");
  if (raw.schema !== LABORATORY_EVIDENCE_DISPATCH_SCHEMA
    || raw.candidate_source_hash !== EPIC_0437_CANDIDATE_SOURCE_HASH
    || ![raw.policy_hash, raw.policy_record_hash, raw.evidence_record_hash, raw.effect_hash]
      .every(value => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value))
    || raw.production_certified !== false
    || typeof raw.evidence_run_id !== "string" || !HEX32.test(raw.evidence_run_id)
    || typeof raw.evidence_step !== "string" || !STEP.test(raw.evidence_step) || raw.evidence_step !== raw.evidence_step.normalize("NFC")
    || typeof raw.workflow !== "string" || !WORKFLOW.test(raw.workflow) || raw.workflow !== raw.workflow.normalize("NFC")
    || raw.channel !== "typed_mcp"
    || typeof raw.alias !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(raw.alias)
    || (raw.transport_kind !== "direct" && raw.transport_kind !== "courier")) {
    throw new Error("laboratory_evidence is malformed or not bound to the reviewed EPIC-0437 candidate source.");
  }
  if (raw.transport_kind === "direct") {
    if (raw.job_id !== null || raw.correlation_id !== null) throw new Error("Direct laboratory evidence cannot carry courier identity.");
  } else if (typeof raw.job_id !== "string" || !HEX64.test(raw.job_id) || raw.correlation_id !== raw.job_id) {
    throw new Error("Courier laboratory evidence requires its exact job/correlation identity.");
  }
  // Reparse the canonical projection to return a detached plain JSON object.
  return JSON.parse(canonicalJson(raw as JsonValue)) as LaboratoryEvidenceDispatch;
}

export function requireCourierLaboratoryEvidenceJobBinding(job: {
  id: string;
  correlation_id: string;
  laboratory_evidence?: unknown;
  turn_token?: string | null;
  turn_token_sha256?: string | null;
  method: string;
  path: string;
}): LaboratoryEvidenceDispatch | null {
  if (job.laboratory_evidence === undefined) return null;
  if (process.env.REVIT_OPERATOR_MODE !== "development" || process.env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1") {
    throw new Error("Courier laboratory evidence requires the exact protected development/laboratory lane.");
  }
  const evidence = parseLaboratoryEvidenceDispatch(job.laboratory_evidence);
  if (evidence.transport_kind !== "courier" || evidence.job_id !== job.id || evidence.correlation_id !== job.correlation_id) {
    throw new Error("Courier laboratory evidence is not bound to the exact durable job identity.");
  }
  if (Object.prototype.hasOwnProperty.call(job, "turn_token") || typeof job.turn_token_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(job.turn_token_sha256)) {
    throw new Error("Courier laboratory evidence must never persist a raw bearer token and must retain only its digest.");
  }
  const { policy } = loadTrustedToolExposurePolicy(process.env);
  const record = policy.records.find(candidate => candidate.policy_record_hash === evidence.policy_record_hash);
  if (policy.policy_hash !== evidence.policy_hash || !record
    || record.evidence_record_hash !== evidence.evidence_record_hash || record.effect_hash !== evidence.effect_hash
    || record.method !== job.method || record.path !== job.path || !record.typed_mcp_aliases.includes(evidence.alias)) {
    throw new Error("Courier laboratory evidence is not bound to the exact current trusted policy record/effect/alias.");
  }
  return evidence;
}
