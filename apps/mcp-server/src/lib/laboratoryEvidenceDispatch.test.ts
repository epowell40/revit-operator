import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeLaboratoryEvidenceDispatch as consumeLaboratoryEvidenceDispatchRaw,
  EPIC_0437_CANDIDATE_SOURCE_HASH,
  issueLaboratoryEvidenceDispatch
} from "./laboratoryEvidenceDispatch.js";

const env = {
  REVIT_OPERATOR_MODE: "development",
  OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
  OPERATOR_CERTIFICATION_PROTECTED_LABORATORY: "1"
};
const policy = { policyHash: `sha256:${"1".repeat(64)}`, policyRecordHash: `sha256:${"2".repeat(64)}`, evidenceRecordHash: `sha256:${"3".repeat(64)}`, effectHash: `sha256:${"4".repeat(64)}` };
function consumeLaboratoryEvidenceDispatch(value: Parameters<typeof consumeLaboratoryEvidenceDispatchRaw>[0], transport: Omit<Parameters<typeof consumeLaboratoryEvidenceDispatchRaw>[1], "policy">, environment = env) {
  return consumeLaboratoryEvidenceDispatchRaw(value, { ...transport, policy }, environment);
}

test("laboratory evidence dispatch is exact-lane, locally branded, source-bound, and one-use", () => {
  const capability = issueLaboratoryEvidenceDispatch({
    evidenceRunId: "a".repeat(32), evidenceStep: "move-preview", workflow: "epic-0437-l4-move-preview", transportKind: "direct"
  }, env);
  const dto = consumeLaboratoryEvidenceDispatch(capability, { transportKind: "direct", jobId: null, correlationId: null, channel: "typed_mcp", alias: "revit_observe_model" }, env);
  assert.deepEqual(Object.keys(dto).sort(), [
    "alias", "candidate_source_hash", "channel", "correlation_id", "effect_hash", "evidence_record_hash", "evidence_run_id", "evidence_step", "job_id",
    "policy_hash", "policy_record_hash", "production_certified", "schema", "transport_kind", "workflow"
  ]);
  assert.equal(dto.candidate_source_hash, EPIC_0437_CANDIDATE_SOURCE_HASH);
  assert.equal(dto.production_certified, false);
  assert.throws(() => consumeLaboratoryEvidenceDispatch(capability, { transportKind: "direct", jobId: null, correlationId: null, channel: "typed_mcp", alias: "revit_observe_model" }, env), /replayed|consumed/);
});

test("laboratory evidence dispatch rejects wrong mode/profile/flag and caller-authored objects", () => {
  const input = { evidenceRunId: "b".repeat(32), evidenceStep: "readback", workflow: "epic-0437-l3-readback", transportKind: "direct" as const };
  for (const bad of [
    { ...env, REVIT_OPERATOR_MODE: "production" },
    { ...env, OPERATOR_TOOL_EXPOSURE_PROFILE: "certified" },
    { ...env, OPERATOR_CERTIFICATION_PROTECTED_LABORATORY: "0" }
  ]) assert.throws(() => issueLaboratoryEvidenceDispatch(input, bad), /exact protected/);
  assert.throws(() => consumeLaboratoryEvidenceDispatch({ ...input } as never, { transportKind: "direct", jobId: null, correlationId: null, channel: "typed_mcp", alias: "revit_observe_model" }, env), /not issued/);
});

test("laboratory evidence dispatch rejects transport and courier identity substitution", () => {
  const direct = issueLaboratoryEvidenceDispatch({ evidenceRunId: "c".repeat(32), evidenceStep: "context", workflow: "epic-0437-l3-context", transportKind: "direct" }, env);
  assert.throws(() => consumeLaboratoryEvidenceDispatch(direct, { transportKind: "courier", jobId: "d".repeat(64), correlationId: "d".repeat(64), channel: "typed_mcp", alias: "revit_observe_model" }, env), /substitution/);
  const courier = issueLaboratoryEvidenceDispatch({ evidenceRunId: "c".repeat(32), evidenceStep: "context", workflow: "epic-0437-l4-context", transportKind: "courier" }, env);
  assert.throws(() => consumeLaboratoryEvidenceDispatch(courier, { transportKind: "courier", jobId: "d".repeat(64), correlationId: "e".repeat(64), channel: "typed_mcp", alias: "revit_observe_model" }, env), /exact job/);
});
