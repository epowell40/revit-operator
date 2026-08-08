
export const EPIC_0437_CANDIDATE_SOURCE_HASH = "sha256:daec4b624b7a0ca07d67fe78bd4f56bf5e5277e7254dfcddf0acc31c344604cc";
export const LABORATORY_EVIDENCE_DISPATCH_SCHEMA = "revit-operator.laboratory-evidence-dispatch.v2";

export type LaboratoryEvidenceTransportKind = "direct" | "courier";

export type LaboratoryEvidenceDispatch = Readonly<{
  evidenceRunId: string;
  evidenceStep: string;
  workflow: string;
  transportKind: LaboratoryEvidenceTransportKind;
}>;

export type LaboratoryEvidenceDispatchDto = Readonly<{
  schema: typeof LABORATORY_EVIDENCE_DISPATCH_SCHEMA;
  candidate_source_hash: typeof EPIC_0437_CANDIDATE_SOURCE_HASH;
  policy_hash: string;
  policy_record_hash: string;
  evidence_record_hash: string;
  effect_hash: string;
  evidence_run_id: string;
  evidence_step: string;
  transport_kind: LaboratoryEvidenceTransportKind;
  job_id: string | null;
  correlation_id: string | null;
  workflow: string;
  channel: "typed_mcp";
  alias: string;
  production_certified: false;
}>;

export type LaboratoryPolicyBinding = Readonly<{
  policyHash: string;
  policyRecordHash: string;
  evidenceRecordHash: string;
  effectHash: string;
}>;

const RUN_ID = /^[0-9a-f]{32}$/;
const COURIER_ID = /^[0-9a-f]{64}$/;
const STEP = /^[a-z][a-z0-9-]{0,79}$/;
const WORKFLOW = /^[a-z][a-z0-9-]{0,119}$/;
const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

function requireExactLane(env: NodeJS.ProcessEnv): void {
  if (env.REVIT_OPERATOR_MODE !== "development"
    || env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1") {
    throw new Error("Laboratory evidence dispatch requires exact protected development/laboratory mode.");
  }
}

/** Mints an opaque local capability. Callers never author the wire DTO. */
export function issueLaboratoryEvidenceDispatch(input: {
  evidenceRunId: string;
  evidenceStep: string;
  workflow: string;
  transportKind: LaboratoryEvidenceTransportKind;
}, env: NodeJS.ProcessEnv = process.env): LaboratoryEvidenceDispatch {
  requireExactLane(env);
  if (Object.keys(input).length !== 4
    || !RUN_ID.test(input.evidenceRunId)
    || !STEP.test(input.evidenceStep)
    || !WORKFLOW.test(input.workflow)
    || (input.transportKind !== "direct" && input.transportKind !== "courier")) {
    throw new Error("Laboratory evidence dispatch input is malformed or contains unknown fields.");
  }
  const capability = Object.freeze({ ...input });
  issued.add(capability);
  return capability;
}

export function isLaboratoryEvidenceDispatch(value: unknown): value is LaboratoryEvidenceDispatch {
  return !!value && typeof value === "object" && issued.has(value as object) && !consumed.has(value as object);
}

/** Read-only local binding for composing another opaque evidence capability. */
export function readLaboratoryEvidenceDispatchBinding(value: LaboratoryEvidenceDispatch): LaboratoryEvidenceDispatch {
  if (!isLaboratoryEvidenceDispatch(value)) throw new Error("Laboratory evidence dispatch was not issued by this runtime or was already consumed.");
  return value;
}

/** Final one-use serialization at the direct/courier publication boundary. */
export function consumeLaboratoryEvidenceDispatch(
  value: LaboratoryEvidenceDispatch,
  transport: { transportKind: LaboratoryEvidenceTransportKind; jobId: string | null; correlationId: string | null; channel: string; alias: string; policy: LaboratoryPolicyBinding },
  env: NodeJS.ProcessEnv = process.env
): LaboratoryEvidenceDispatchDto {
  requireExactLane(env);
  const binding = readLaboratoryEvidenceDispatchBinding(value);
  if (transport.transportKind !== binding.transportKind) throw new Error("Laboratory evidence transport kind substitution is forbidden.");
  if (transport.transportKind === "direct") {
    if (transport.jobId !== null || transport.correlationId !== null) throw new Error("Direct laboratory evidence cannot carry courier identity.");
  } else if (!COURIER_ID.test(transport.jobId ?? "") || transport.correlationId !== transport.jobId) {
    throw new Error("Courier laboratory evidence requires its exact job/correlation identity.");
  }
  if (transport.channel !== "typed_mcp" || !/^[a-z][a-z0-9_]*$/.test(transport.alias) || transport.alias === "revit_call_tool") {
    throw new Error("Laboratory evidence dispatch requires an exact locally evaluated typed MCP alias.");
  }
  if (![transport.policy.policyHash, transport.policy.policyRecordHash, transport.policy.evidenceRecordHash, transport.policy.effectHash]
    .every(value => /^sha256:[0-9a-f]{64}$/.test(value))) {
    throw new Error("Laboratory evidence dispatch requires exact current policy, record, and evidence hashes.");
  }
  const payload = Object.freeze({
    schema: LABORATORY_EVIDENCE_DISPATCH_SCHEMA,
    candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
    policy_hash: transport.policy.policyHash,
    policy_record_hash: transport.policy.policyRecordHash,
    evidence_record_hash: transport.policy.evidenceRecordHash,
    effect_hash: transport.policy.effectHash,
    evidence_run_id: binding.evidenceRunId,
    evidence_step: binding.evidenceStep,
    transport_kind: binding.transportKind,
    job_id: transport.jobId,
    correlation_id: transport.correlationId,
    workflow: binding.workflow,
    channel: "typed_mcp" as const,
    alias: transport.alias,
    production_certified: false as const
  });
  consumed.add(value);
  return payload;
}
