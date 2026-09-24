import assert from "node:assert/strict";
import test from "node:test";
import { nativeChildProjectionReferencesV2 } from "../src/assignments/assignment_kernel_v2_child_projection.js";

test("typed context parent projects only its exact native child evidence", () => {
  const binding = { assignment_id: "a", run_id: "sidecar:r", generation: 1, session_id: "s" };
  const snapshot = { operations: {
    parent: { operation_id: "parent", binding, requested_effect: "read",
      result: { operation_id: "parent", observation_required: false } },
    child: { operation_id: "child", binding, operation_role: "child", parent_operation_id: "parent",
      root_operation_id: "parent", capability_id: "native:GET:/revit/context",
      requested_effect: "read", request_identity: { capability_id: "native:GET:/revit/context", method: "GET", path: "/revit/context" },
      result: { operation_id: "child", observation_required: true,
        request_identity: { capability_id: "native:GET:/revit/context", method: "GET", path: "/revit/context" } },
      observation_ids: ["obs"] }
  }, observations: { obs: { operation_id: "child", raw_payload_ref: "evidence:ev1_child" } } };
  const response = { structuredContent: { operation_result_v2: { operation_id: "parent" },
    child_operation_results_v2: [{ operation_id: "child", parent_operation_id: "parent",
      request_identity: { capability_id: "native:GET:/revit/context", method: "GET", path: "/revit/context" },
      evidence_projections: [{ evidence_id: "ev1_child", source: "assignment_kernel_v2:native:GET:/revit/context",
        attempt_id: "child", assignment_id: "a", run_id: "sidecar:r", generation: 1 }] }] } };
  const references = (s: unknown, r: unknown) => nativeChildProjectionReferencesV2(s as never, "parent", r);
  assert.deepEqual(references(snapshot, response), [{ operation_id: "child", evidence_id: "ev1_child" }]);
  const wrongParent = structuredClone(snapshot);
  wrongParent.operations.child.parent_operation_id = "other";
  assert.deepEqual(references(wrongParent, response), []);
  const wrongSession = structuredClone(snapshot);
  wrongSession.operations.child.binding = { ...wrongSession.operations.child.binding, session_id: "other" };
  assert.deepEqual(references(wrongSession, response), []);
  const wrongEvidence = structuredClone(response);
  wrongEvidence.structuredContent.child_operation_results_v2[0]!.evidence_projections[0]!.evidence_id = "ev1_foreign";
  assert.deepEqual(references(snapshot, wrongEvidence), []);
  const wrongRoute = structuredClone(snapshot);
  wrongRoute.operations.child.request_identity.path = "/revit/views";
  assert.deepEqual(references(wrongRoute, response), []);
  const wrongEffect = structuredClone(snapshot);
  wrongEffect.operations.child.requested_effect = "apply";
  assert.deepEqual(references(wrongEffect, response), []);
  const duplicateChild = structuredClone(response);
  duplicateChild.structuredContent.child_operation_results_v2.push(structuredClone(duplicateChild.structuredContent.child_operation_results_v2[0]!));
  assert.deepEqual(references(snapshot, duplicateChild), []);
});
