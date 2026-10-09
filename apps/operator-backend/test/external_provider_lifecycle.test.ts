import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeExternalProviderCallV2 } from "../src/assignments/external_provider_lifecycle.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { createOpenAiModelCallReceipt } from "../src/model_call_telemetry.js";

test("external provider admission, drain, usage, and pause use the canonical assignment", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-provider-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const goal = createGoal({ title: "Verify PDF", objective: "Inspect the existing PDF.",
      acceptance_criteria: ["Return the requested result."], status: "active", related_session_id: "test-external", created_by: "test-principal",
      work_budget: { requested_effect: "read" } });
    const binding = createAssignmentKernelForGoalV2({ goal, run_id: "external-test" });
    const snapshot = () => getAssignmentKernelSnapshotV2(goal.id)!;
    const receipt = createOpenAiModelCallReceipt({ route: "desktop_computer", requested_model: "gpt-6.1-sol",
      reasoning_effort: "medium", started_at_utc: new Date().toISOString(), duration_ms: 7,
      response: { id: "upstream-receipt", status: "completed", model: "gpt-6.1-sol",
        usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17, input_tokens_details: { cached_tokens: 8 } } } });
    let invokes = 0;
    const options = { binding, model: "gpt-6.1-sol", reasoning_effort: "medium", receipt: () => receipt,
      errorReceipt: () => null, invoke: async () => {
        invokes++;
        assert.equal(snapshot().in_flight_provider_call_ids.length, 1);
        assert.equal(snapshot().quiescent, false);
        await assert.rejects(executeExternalProviderCallV2({ ...options, invoke: async () => { throw Error('must not invoke'); } }), /admission_denied/);
        return "response";
      } };
    assert.equal(await executeExternalProviderCallV2(options), "response");
    assert.equal(invokes, 1);
    assert.equal(snapshot().quiescent, true);
    assert.equal(snapshot().outcome, "active", "usage is not task verification");
    assert.equal(Object.values(snapshot().provider_calls)[0]!.usage!.total_tokens, 17);
    assert.equal(Object.values(snapshot().provider_calls)[0]!.usage!.cached_input_tokens, 8);
    controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
    await assert.rejects(executeExternalProviderCallV2(options), /admission_denied/);
    assert.equal(invokes, 1);
    controlAssignmentExecutionV2({ binding, command_id: "resume", expected_command_id: "pause", action: "resume" });
    const failure = Error("upstream failed without usage");
    await assert.rejects(executeExternalProviderCallV2({ ...options, invoke: async () => { throw failure; } }), error => error === failure);
    assert.equal(snapshot().quiescent, true);
    assert.equal(Object.values(snapshot().provider_calls).filter(call => call.success === false).length, 1);
    assert.equal(Object.values(snapshot().provider_calls).find(call => call.success === false)!.usage, undefined,
      "missing usage must never become zero usage");
    await assert.rejects(executeExternalProviderCallV2({ ...options, binding: { ...binding, generation: 9 } }), /binding_stale/);
    const exhaustedReceipt = createOpenAiModelCallReceipt({ route: "desktop_computer", requested_model: "gpt-6.1-sol",
      reasoning_effort: "medium", started_at_utc: new Date().toISOString(), duration_ms: 8,
      response: { id: "budget-receipt", status: "completed", model: "gpt-6.1-sol",
        usage: { input_tokens: 4_000_000, output_tokens: 1, total_tokens: 4_000_001 } } });
    await executeExternalProviderCallV2({ ...options, invoke: async () => "budget response", receipt: () => exhaustedReceipt });
    await assert.rejects(executeExternalProviderCallV2(options), /admission_denied:blocked/);
    assert.equal(invokes, 1, "exhausted token budget stops the next network call");
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    __testOnlyResetGoalListCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
