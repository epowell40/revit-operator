import assert from "node:assert/strict";
import test from "node:test";
import { ASSIGNMENT_KERNEL_V2_BINDING_META_KEY, runWithAssignmentKernelV2 } from "../lib/assignmentKernelV2.js";
import {
  existingConditionsRegistrationInputSchema,
  handleExistingConditionsRegistration,
  registerExistingConditionsRegistrationTool
} from "./existingConditionsRegistrationTool.js";

const input = {
  interpretationEvidenceId: `ev1_${"a".repeat(32)}`,
  frameObservationId: "observation-frame-1",
  controls: [
    { controlId: "northwest", sourcePageUv: { u: 0.1, v: 0.1 }, candidateViewUv: { u: 0.2, v: 0.2 } },
    { controlId: "northeast", sourcePageUv: { u: 0.9, v: 0.1 }, candidateViewUv: { u: 0.8, v: 0.2 } },
    { controlId: "southwest", sourcePageUv: { u: 0.1, v: 0.9 }, candidateViewUv: { u: 0.2, v: 0.8 } }
  ],
  allowReflection: false,
  maxRmsErrorFt: 0.25,
  maxPointErrorFt: 0.5
};

const bindingMeta = {
  [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: {
    assignment_id: "assignment-1", run_id: "run-1", generation: 3, session_id: "session-1", principal_id: "principal-1"
  }
};

test("existing-conditions registration requires the trusted task binding and forwards bounded landmarks", async () => {
  let received: any;
  const result = await runWithAssignmentKernelV2(bindingMeta, async () => handleExistingConditionsRegistration(input, {
    async registerExistingConditionsInterpretation(value) { received = value; return { native_write_allowed: false, registration: { verified: true } }; }
  }));

  assert.equal(received.assignment_id, "assignment-1");
  assert.equal(received.assignment_run_id, "run-1");
  assert.equal(received.assignment_generation, 3);
  assert.equal(received.session_id, "session-1");
  assert.equal(received.controls.length, 3);
  assert.deepEqual(received.controls[0], { control_id: "northwest", source_page_uv: { u: 0.1, v: 0.1 }, candidate_view_uv: { u: 0.2, v: 0.2 } });
  assert.deepEqual(JSON.parse(result.content[0]!.text), { native_write_allowed: false, registration: { verified: true } });
});

test("registration input rejects paths, writes, and fewer than three controls", () => {
  assert.equal(existingConditionsRegistrationInputSchema.safeParse({ ...input, filePath: "C:/secret.pdf" }).success, false);
  assert.equal(existingConditionsRegistrationInputSchema.safeParse({ ...input, apply: true }).success, false);
  assert.equal(existingConditionsRegistrationInputSchema.safeParse({ ...input, controls: input.controls.slice(0, 2) }).success, false);
});

test("registration tool exposes one explicitly read-only MCP surface", () => {
  let registration: any;
  registerExistingConditionsRegistrationTool((name, description, schema, handler) => { registration = { name, description, schema, handler }; });
  assert.equal(registration.name, "operator_register_existing_conditions_interpretation");
  assert.match(registration.description, /read-only/i);
  assert.match(registration.description, /never creates or changes Revit elements/i);
  assert.equal(registration.schema, existingConditionsRegistrationInputSchema);
});
