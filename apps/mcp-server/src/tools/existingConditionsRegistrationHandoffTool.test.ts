import assert from "node:assert/strict";
import test from "node:test";
import { ASSIGNMENT_KERNEL_V2_BINDING_META_KEY, runWithAssignmentKernelV2 } from "../lib/assignmentKernelV2.js";
import {
  existingConditionsRegistrationHandoffInputSchema,
  handleExistingConditionsRegistrationHandoff,
  registerExistingConditionsRegistrationHandoffTool
} from "./existingConditionsRegistrationHandoffTool.js";

const input = {
  originRegistrationEvidenceId: `ev1_${"a".repeat(32)}`,
  currentLandmarkObservationId: `obsv2_${"b".repeat(64)}`
};
const bindingMeta = { [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: {
  assignment_id: "follow-up-assignment", run_id: "follow-up-run", generation: 1,
  session_id: "same-conversation", principal_id: "principal-1"
} };

test("r7 follow-up sends prior PDF evidence and fresh grid observation under host Assignment binding", async () => {
  let received: any;
  const result = await runWithAssignmentKernelV2(bindingMeta, async () => handleExistingConditionsRegistrationHandoff(input, {
    async resumeExistingConditionsRegistration(value) {
      received = value;
      return { status: "registered_for_current_assignment", native_write_allowed: false };
    }
  }));
  assert.deepEqual(received, {
    assignment_id: "follow-up-assignment", assignment_run_id: "follow-up-run",
    assignment_generation: 1, session_id: "same-conversation",
    origin_registration_evidence_id: input.originRegistrationEvidenceId,
    current_landmark_observation_id: input.currentLandmarkObservationId
  });
  assert.equal(JSON.parse(result.content[0]!.text).native_write_allowed, false);
});

test("handoff schema allows references only, and tool declares fresh native check and read-only scope", () => {
  assert.equal(existingConditionsRegistrationHandoffInputSchema.safeParse(input).success, true);
  assert.equal(existingConditionsRegistrationHandoffInputSchema.safeParse({ ...input, apply: true }).success, false);
  assert.equal(existingConditionsRegistrationHandoffInputSchema.safeParse({ ...input, currentLandmarkObservationId: input.originRegistrationEvidenceId }).success, false);
  let registered: any;
  registerExistingConditionsRegistrationHandoffTool((name, description, schema) => { registered = { name, description, schema }; });
  assert.equal(registered.name, "operator_resume_existing_conditions_registration");
  assert.match(registered.description, /fresh.*native/i);
  assert.match(registered.description, /read-only/i);
  assert.equal(registered.schema, existingConditionsRegistrationHandoffInputSchema);
});
