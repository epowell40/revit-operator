import assert from "node:assert/strict";
import test from "node:test";
import { resolveRegisteredStageBody } from "./resolveRegisteredStageBody.js";

test("C110 registered stage reference passes only host-resolved exact body to native authorization", async () => {
  const binding = { assignment_id: "assignment", run_id: "run", generation: 1, session_id: "session" };
  const exact = { stageKey: "operation:registered-route:sa8main", dryRun: false,
    operations: [{ action_key: "registered-route:sa8main", apply_body: { points: [[1, 2, 3], [4, 5, 6]] } }] };
  const calls: unknown[] = [];
  const resolver = { async resolveRegisteredExistingConditionsStage(input: unknown) {
    calls.push(input);
    return { stage_key: "operation:registered-route:sa8main", phase: "apply", native_body: exact };
  } };
  const ref = { registered_stage_key: exact.stageKey, stage_phase: "apply", dryRun: false };
  assert.deepEqual(await resolveRegisteredStageBody(ref, binding, resolver), exact);
  assert.deepEqual(calls, [{ assignment_id: "assignment", assignment_run_id: "run",
    assignment_generation: 1, session_id: "session", registered_stage_key: exact.stageKey,
    stage_phase: "apply" }]);
  await assert.rejects(resolveRegisteredStageBody({ ...ref, operations: exact.operations }, binding, resolver), /reference_invalid/);
  await assert.rejects(resolveRegisteredStageBody({ ...ref, dryRun: true }, binding, resolver), /reference_invalid/);
  await assert.rejects(resolveRegisteredStageBody(ref, null, resolver), /binding_required/);
  await assert.rejects(resolveRegisteredStageBody(ref, binding, { async resolveRegisteredExistingConditionsStage() {
    return { stage_key: exact.stageKey, phase: "dry_run", native_body: exact };
  } }), /response_mismatch/);
});

test("C112 identical compact retry follows the corrected registered body without stale native bytes", async () => {
  const binding = { assignment_id: "assignment", run_id: "run", generation: 1, session_id: "session" };
  const ref = { registered_stage_key: "operation:registered-route:return8west", stage_phase: "dry_run", dryRun: true };
  let exact = { inputFingerprintSha256: "f".repeat(64), dryRun: true,
    operations: [{ apply_body: { systemType: "ReturnAir" } }] };
  const resolver = { async resolveRegisteredExistingConditionsStage() {
    return { stage_key: ref.registered_stage_key, phase: "dry_run", native_body: exact };
  } };
  const first = await resolveRegisteredStageBody(ref, binding, resolver);
  exact = { inputFingerprintSha256: "b".repeat(64), dryRun: true,
    operations: [{ apply_body: { systemType: "Return Air" } }] };
  const corrected = await resolveRegisteredStageBody(ref, binding, resolver);
  assert.notDeepEqual(first, corrected);
  assert.equal((corrected as typeof exact).operations[0]!.apply_body.systemType, "Return Air");
});
