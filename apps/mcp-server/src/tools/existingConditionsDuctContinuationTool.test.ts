import assert from "node:assert/strict";
import test from "node:test";
import { ASSIGNMENT_KERNEL_V2_BINDING_META_KEY, runWithAssignmentKernelV2 } from "../lib/assignmentKernelV2.js";
import {
  existingConditionsDuctContinuationInputSchema,
  handleExistingConditionsDuctContinuation,
  registerExistingConditionsDuctContinuationTool
} from "./existingConditionsDuctContinuationTool.js";

const input = {
  registrationEvidenceId: `ev1_${"a".repeat(32)}`,
  primitiveId: "main-403-west",
  connectorObservationId: `obsv2_${"f".repeat(64)}`,
  requiredExistingEndpoint: "start" as const,
  deferredFarEndReason: "Visible main continues into room 404",
  nativeMapping: { levelName: "Level 4", elevationZFt: 42.83,
    systemType: "Supply Air", routeTypeId: 404, shape: "round" as const, size: '8"' }
};
const bindingMeta = { [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: {
  assignment_id: "assignment-1", run_id: "run-1", generation: 3,
  session_id: "session-1", principal_id: "principal-1"
} };

test("Codex MCP planner forwards IDs and native mapping under the trusted Assignment binding", async () => {
  let received: any;
  const result = await runWithAssignmentKernelV2(bindingMeta, async () => handleExistingConditionsDuctContinuation(input, {
    async planExistingConditionsDuctContinuation(value) {
      received = value;
      return { status: "registered_for_staged_dry_run", revit_write_performed: false };
    },
    async planExistingConditionsDuctBranch() { throw new Error("unexpected branch path"); }
  }));
  assert.equal(received.assignment_id, "assignment-1");
  assert.equal(received.assignment_run_id, "run-1");
  assert.equal(received.assignment_generation, 3);
  assert.equal(received.session_id, "session-1");
  assert.equal(received.primitive_id, "main-403-west");
  assert.equal(received.connector_observation_id, input.connectorObservationId);
  assert.equal(received.required_existing_endpoint, "start");
  assert.deepEqual(received.native_mapping, { level_name: "Level 4", elevation_z_ft: 42.83,
    system_type: "Supply Air", route_type_id: 404, shape: "round", size: '8"' });
  assert.equal(JSON.parse(result.content[0]!.text).revit_write_performed, false);
});

test("continuation schema admits source IDs but rejects caller-supplied route coordinates and write flags", () => {
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse(input).success, true);
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse({ ...input, points: [{ x: 1, y: 2 }] }).success, false);
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse({ ...input, apply: true }).success, false);
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse({ ...input, connectorObservationId: input.registrationEvidenceId }).success, false);
});

test("interior tee variant routes registered IDs and native mapping without accepting raw points", async () => {
  const branch = {
    connectionMode: "interior_tee" as const,
    registrationEvidenceId: input.registrationEvidenceId,
    primitiveId: "upper-ra",
    mainConnectorObservationId: input.connectorObservationId,
    deferredFarEndReason: "North end remains unresolved",
    nativeMapping: { mainElementId: 1543280, levelName: "L4", elevationZFt: 40.168061,
      systemType: "Return Air", routeTypeId: 139186, shape: "round" as const, size: '8"' }
  };
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse(branch).success, true);
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse({ ...branch, branchPoints: [{x:1,y:2}] }).success, false);
  assert.equal(existingConditionsDuctContinuationInputSchema.safeParse({ ...branch, dryRun: false }).success, false);
  let received: any;
  await runWithAssignmentKernelV2(bindingMeta, async () => handleExistingConditionsDuctContinuation(branch, {
    async planExistingConditionsDuctContinuation() { throw new Error("unexpected open-end path"); },
    async planExistingConditionsDuctBranch(value) { received = value; return { status: "registered_for_staged_dry_run" }; }
  }));
  assert.equal(received.native_mapping.main_element_id, 1543280);
  assert.equal(received.main_connector_observation_id, branch.mainConnectorObservationId);
  assert.equal(received.primitive_id, "upper-ra");
});

test("continuation tool is an explicitly read-only planning surface", () => {
  let registration: any;
  registerExistingConditionsDuctContinuationTool((name, description, schema, handler) => {
    registration = { name, description, schema, handler };
  });
  assert.equal(registration.name, "operator_plan_existing_conditions_duct_continuation");
  assert.match(registration.description, /does not modify Revit/i);
  assert.match(registration.description, /interior_tee/i);
  assert.match(registration.description, /registered PDF junction/i);
  assert.equal(registration.schema, existingConditionsDuctContinuationInputSchema);
});
