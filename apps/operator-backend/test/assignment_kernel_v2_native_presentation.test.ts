import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { nativeResultPresentationV2 } from "../src/assignments/assignment_kernel_v2_native_presentation.js";
import { renderTerminalResultV2 } from "../src/assignments/assignment_kernel_v2_terminal_result.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-native-presentation-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const binding = { assignment_id: "assignment", run_id: "run", generation: 1,
    session_id: "session", principal_id: "principal", document_fingerprint: "sample" };
  const snapshot: any = { current_binding: binding, observations: {}, operations: {},
    criteria: {}, spec: { requested_effect: "apply" }, terminal: true, outcome: "complete",
    assignment_version: 1 };
  const add = (id: string, payload: unknown, pathName: string, effect: "applied" | "none", observedAt: string) => {
    const stored = storeEvidence({ scope: { session_id: binding.session_id, assignment_id: binding.assignment_id,
      run_id: binding.run_id, generation: binding.generation, attempt_id: id },
      source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw: payload });
    snapshot.operations[id] = { operation_id: id, binding, capability_id: `native:POST:${pathName}`,
      requested_effect: effect === "applied" ? "apply" : "read", persistent_effect: effect,
      purpose: effect === "applied" ? "task" : "verification", settlement_state: "settled",
      result: { status: "succeeded", persistent_effect: effect, native_transaction_state: effect === "applied" ? "committed" : "not_applicable",
        completed_at: observedAt }, observation_ids: [id] };
    snapshot.observations[id] = { observation_id: id, operation_id: id, binding,
      authority: "native-host", evidence_class: effect === "applied" ? "task_result" : "verification",
      raw_payload_ref: `evidence:${stored.ref.evidence_id}`, raw_payload_hash: payloadDigestV2(payload).digest,
      observed_at: observedAt, facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }] };
    snapshot.criteria[id] = { status: "pass", supporting_facts: [{ observation_id: id }] };
    return stored.ref;
  };
  const cleanup = () => { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); };
  return { snapshot, add, cleanup };
}

const applied = { status: "AppliedVisualVerificationReady", transaction: { status: "committed", committed: true },
  applyResult: { status: "CreatedWithOpenConnectors", kind: "duct", rolledBack: false,
    createdElementIds: [1542945], chosenSize: { applied: "8 in", diameterFt: 2 / 3 },
    selected: { level: { id: 1362791, name: "L4" } } } };
const connector = { status: "Ok", failedElementCount: 0, connectorScanTruncatedElementCount: 0,
  results: [{ id: 1542945, ok: true, category: "OST_DuctCurves", connectorCount: 2, returnedConnectorCount: 2,
    connectorScanTruncated: false, openPhysicalConnectorCount: 2,
    connectors: [0, 1].map(() => ({ connectorType: "End", physicalConnectionCount: 0,
      isPhysicallyConnected: false, physicalConnectedTo: [] })) }],
  verificationParameters: { schema: "revit-operator.duct-verification-parameters/v1", items: [{ id: 1542945,
    parameterDetails: [{ name: "Reference Level", value: "1362791", valueString: "L4" },
      { name: "Diameter", value: "0.66666666666666663", valueString: '8"' }] }] } };

test("committed MEP route plus later full native connector readback presents created duct result", () => {
  const f = fixture();
  try {
    f.add("apply", applied, "/revit/mep-route-workflow", "applied", "2026-09-24T00:23:35Z");
    f.add("readback", connector, "/revit/get-connectors", "none", "2026-09-24T00:23:57Z");
    assert.equal(renderTerminalResultV2(f.snapshot), "Created 1 duct segment (8 in) on L4. Verified 2 open physical end connectors.");
  } finally { f.cleanup(); }
});

test("preview, foreign, stale, and mismatched native evidence cannot certify a route", () => {
  const f = fixture();
  try {
    f.add("apply", { ...applied, transaction: { status: "rolled_back", committed: false } },
      "/revit/mep-route-workflow", "applied", "2026-09-24T00:23:35Z");
    f.add("readback", connector, "/revit/get-connectors", "none", "2026-09-24T00:23:57Z");
    assert.equal(nativeResultPresentationV2(f.snapshot, ["apply", "readback"]), null);
    f.snapshot.operations.apply.result.native_transaction_state = "committed";
    f.snapshot.observations.readback.binding = { ...f.snapshot.current_binding, generation: 2 };
    assert.equal(nativeResultPresentationV2(f.snapshot, ["apply", "readback"]), null);
    f.snapshot.observations.readback.binding = f.snapshot.current_binding;
    f.snapshot.observations.readback.observed_at = "2026-09-24T00:23:00Z";
    assert.equal(nativeResultPresentationV2(f.snapshot, ["apply", "readback"]), null);
    f.snapshot.observations.readback.observed_at = "2026-09-24T00:23:57Z";
    f.snapshot.observations.readback.raw_payload_hash = "sha256:tampered";
    assert.equal(nativeResultPresentationV2(f.snapshot, ["apply", "readback"]), null);
  } finally { f.cleanup(); }
});

test("incomplete connector or parameter evidence does not overstate connection, size, or level", () => {
  const f = fixture();
  try {
    f.add("apply", applied, "/revit/mep-route-workflow", "applied", "2026-09-24T00:23:35Z");
    f.add("readback", { ...connector, results: [{ ...connector.results[0], connectorScanTruncated: true }],
      verificationParameters: { ...connector.verificationParameters, items: [{ id: 1542945, parameterDetails: [] }] } },
      "/revit/get-connectors", "none", "2026-09-24T00:23:57Z");
    const result = nativeResultPresentationV2(f.snapshot, ["apply", "readback"]);
    assert.equal(result, "Created 1 duct segment.");
  } finally { f.cleanup(); }
});

test("verified registered interior tee reports the bounded edit and its open end", () => {
  const f = fixture();
  try {
    const branch = { schema: "operator.existing_conditions_mep_draft_workflow.v1", status: "Applied", dryRun: false,
      transactionGroupRolledBack: false, atomic: true, operationCount: 1,
      createdElementIds: [11, 12, 13, 14, 15, 16, 17],
      operations: [{ path: "/revit/connect-mep-branch", createdElementIds: [11, 12, 13, 14, 15, 16, 17],
        response: { status: "CreatedWithSplitTee", kind: "duct", rolledBack: false,
          splitMainSegmentIds: [10, 11], createdBranchElementIds: [12, 13, 14],
          createdFittingIds: [15, 16, 17], openConnectorCount: 1,
          connectionAttempts: [
            { connection: "split_main_to_branch_tee", connected: true, method: "new_tee_fitting", fittingId: 15 },
            { connection: "branch_internal", connected: true, method: "new_elbow_fitting", fittingId: 16 },
            { connection: "branch_internal", connected: true, method: "new_elbow_fitting", fittingId: 17 }],
          selected: { system: { name: "Supply Air" }, size: '8"', level: { name: "L4" } } } }] };
    f.add("apply", branch, "/revit/existing-conditions-mep-draft-workflow", "applied", "2026-09-25T16:45:31Z");
    f.add("verify", { status: "Ok" }, "/revit/get-connectors", "none", "2026-09-25T16:45:44Z");
    f.snapshot.operations.apply.verification_operation_ids = ["verify"];
    f.snapshot.operations.verify.verification_of_operation_id = "apply";
    f.snapshot.operations.verify.purpose = "verification";
    f.snapshot.observations.verify.facts = [{ fact_id: "verification.postcondition_satisfied", fact_class: "verification", value: true }];
    assert.equal(renderTerminalResultV2(f.snapshot),
      "Added and verified an 8-inch Supply Air branch on L4: 3 duct segments, a tee, and 2 elbows. One branch end remains open.");
    for (const change of [
      (x: any) => { x.operations.apply.persistent_effect = "none"; },
      (x: any) => { x.observations.verify.facts[0].value = false; },
      (x: any) => { x.observations.apply.raw_payload_hash = "tampered"; },
      (x: any) => { x.observations.apply.binding = { ...x.current_binding, generation: 2 }; }
    ]) {
      const changed = structuredClone(f.snapshot); change(changed);
      assert.equal(nativeResultPresentationV2(changed, ["apply", "verify"]), null);
    }
  } finally { f.cleanup(); }
});

test("C142 verified two-segment registered tee reports the actual branch instead of generic completion", () => {
  const f = fixture();
  try {
    const branch = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/c142-registered-tee-apply.json"), "utf8"));
    f.add("apply", branch, "/revit/existing-conditions-mep-draft-workflow", "applied", "2026-09-25T18:23:38Z");
    f.add("verify", { status: "Ok" }, "/revit/get-connectors", "none", "2026-09-25T18:24:28Z");
    f.snapshot.operations.apply.verification_operation_ids = ["verify"];
    f.snapshot.operations.verify.verification_of_operation_id = "apply";
    f.snapshot.operations.verify.purpose = "verification";
    f.snapshot.observations.verify.facts = [{ fact_id: "verification.postcondition_satisfied", fact_class: "verification", value: true }];
    assert.equal(renderTerminalResultV2(f.snapshot),
      "Added and verified an 8-inch Supply Air branch on L4: 2 duct segments, a tee, and 1 elbow. One branch end remains open.");
    for (const change of [
      (x: any) => { x.operations.apply.persistent_effect = "none"; },
      (x: any) => { x.observations.verify.facts[0].value = false; },
      (x: any) => { x.observations.apply.raw_payload_hash = "tampered"; },
      (x: any) => { x.observations.apply.binding = { ...x.current_binding, generation: 2 }; },
      (x: any) => { x.observations.apply.raw_payload_ref = "evidence:missing"; }
    ]) { const changed = structuredClone(f.snapshot); change(changed);
      assert.equal(nativeResultPresentationV2(changed, ["apply", "verify"]), null); }
  } finally { f.cleanup(); }
});

test("C142 presentation rejects fitting, identity, rollback and open-end tampering", () => {
  for (const mutate of [
    (x: any) => { x.operations[0].response.connectionAttempts[1].method = "new_transition_fitting"; },
    (x: any) => { x.operations[0].response.connectionAttempts[1].fittingId = 1543999; },
    (x: any) => { x.operations[0].response.createdBranchElementIds[1] = 1543999; },
    (x: any) => { x.operations[0].response.openConnectorCount = 0; },
    (x: any) => { x.transactionGroupRolledBack = true; }
  ]) {
    const f = fixture();
    try {
      const branch = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/c142-registered-tee-apply.json"), "utf8"));
      mutate(branch);
      f.add("apply", branch, "/revit/existing-conditions-mep-draft-workflow", "applied", "2026-09-25T18:23:38Z");
      f.add("verify", { status: "Ok" }, "/revit/get-connectors", "none", "2026-09-25T18:24:28Z");
      f.snapshot.operations.apply.verification_operation_ids = ["verify"];
      f.snapshot.operations.verify.verification_of_operation_id = "apply";
      f.snapshot.operations.verify.purpose = "verification";
      f.snapshot.observations.verify.facts = [{ fact_id: "verification.postcondition_satisfied", fact_class: "verification", value: true }];
      assert.equal(nativeResultPresentationV2(f.snapshot, ["apply", "verify"]), null);
    } finally { f.cleanup(); }
  }
});
