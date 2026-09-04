import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";

for (const [effect, prompt, facts] of [
  ["read", "Count all air devices in the project and break the total down by family and type. Do not change the model.", ["inventory.complete", "inventory.total", "inventory.group"]],
  ["preview", "Run a rollback preview moving the selected device one foot east. Do not commit.", ["task.preview_valid"]],
  ["apply", "Replace the selected note text with the exact literal 'Issued for Construction'.", ["task.result_available"]]
] as const) {
  test(`normal chat admits ${effect} auto-goals with a native evidence contract under V2`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-auto-admission-"));
    const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
    const previousV2 = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
    __testOnlyResetGoalListCache();
    try {
      runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, () => {
        // Same admission edge as /chat and /chat/stream; no hand-made Goal or
        // benchmark-only acceptance criteria bypass the normal UI producer.
        const prepared = prepareAssignmentTurn({
          sessionId: "normal-ui-session", messageId: "normal-ui-message",
          userText: prompt, toolResults: [], source: "chat", createdBy: null,
          requestContext: { revit: { document: { projectIdentity: { fingerprint: "test-model" } } } }
        });
        assert.equal(prepared?.kernelVersion, 2);
        const snapshot = getAssignmentKernelSnapshotV2(prepared!.assignmentId)!;
        assert.equal(snapshot.spec.requested_effect, effect);
        assert.equal(snapshot.current_binding.principal_id, "local:shared-token");
        assert.equal(snapshot.current_binding.document_fingerprint, "test-model");
        assert.equal(snapshot.spec.source_user_request, prompt);
        assert.equal(snapshot.spec.criteria.length, 1);
        assert.deepEqual(snapshot.spec.criteria[0]!.semantic_fact_requirements, facts);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_native_dispatch, true);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_current_generation, true);
        assert.equal(snapshot.terminal, false, "admission must not certify completion");
        assert.deepEqual(snapshot.criteria, {}, "no criterion passes before native evidence");
      });
    } finally {
      if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
      else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
      if (previousV2 === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
      else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previousV2;
      __testOnlyResetGoalListCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
