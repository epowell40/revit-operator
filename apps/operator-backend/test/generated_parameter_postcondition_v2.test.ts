import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { generatedParameterPostconditionInputV2, generatedParameterPostconditionSatisfiedV2 } from "../src/verification/generated_parameter_postcondition_v2.js";
import { postconditionSatisfiedByPayloadV2 } from "../src/postcondition_verification_v2.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { generatedParameterPayload, generatedParameterSource } from "./generated_parameter_postcondition.fixtures.js";

function workspace(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-postcondition-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally { __closeForTests(); if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior; fs.rmSync(root, { recursive: true, force: true }); }
}
function fixture(change?: (payload: any) => void): any {
  const binding = { assignment_id: "assignment", run_id: "run", session_id: "session", generation: 1, principal_id: "local:pilot", document_fingerprint: "c".repeat(64) };
  const payload = generatedParameterPayload(binding.document_fingerprint, [42, 43]); change?.(payload);
  const rawHash = payloadDigestV2(payload).digest;
  const ref = storeEvidence({ scope: { ...binding, attempt_id: "apply" }, source: "dynamic-native", media_type: "application/json", trust_level: "host_observed", raw: payload }).ref;
  const subject = { operation_id: "apply", binding, capability_id: "operator_run_dynamic_revit_program", requested_effect: "apply", persistent_effect: "applied", settlement_state: "settled",
    input: { source: generatedParameterSource, mode: "apply" }, observation_ids: ["obs"], result: { binding, authority: "dynamic-runtime", status: "succeeded", native_transaction_state: "committed",
      result_schema_id: "operator-dynamic-runtime/mcp-program/v2", raw_payload_hash: rawHash } };
  const snapshot = { current_binding: binding, observations: { obs: { operation_id: "apply", binding, authority: "dynamic-runtime", evidence_class: "task_result", raw_payload_hash: rawHash, raw_payload_ref: `evidence:${ref.evidence_id}` } } };
  const read = { binding, authority: "native-host", status: "succeeded", dispatch_state: "dispatched", persistent_effect: "none",
    request_identity: { method: "POST", path: "/revit/get-parameters" } };
  return { snapshot, subject, read };
}
const derive = (f: any) => generatedParameterPostconditionInputV2(f.snapshot, f.subject, f.read);

test("retained generated parameter graph requires exact current native readback for every direct target", () => workspace(() => {
  const f = fixture(), input = derive(f);
  const verified = (payload: unknown) => generatedParameterPostconditionSatisfiedV2(f.snapshot, f.subject, f.read, payload);
  assert.deepEqual(input, { changes: [{ elementId: 42, parameterName: "Comments", value: "PILOT-42" }, { elementId: 43, parameterName: "Comments", value: "PILOT-43" }] });
  const read = { items: [{ id: 42, parameters: { Comments: "PILOT-42" } }, { id: 43, parameters: { Comments: "PILOT-43" } }] };
  assert.equal(verified(read), true);
  assert.equal(verified({ items: read.items.slice(0, 1) }), false);
  assert.equal(verified({ items: [{ id: 42, parameters: { Comments: "PILOT-43" } }, { id: 43, parameters: { Comments: "PILOT-42" } }] }), false);
  assert.equal(verified({ report: read, verified: true }), false);
  assert.equal(verified({ items: [...read.items, read.items[0]] }), false);
  f.read.request_identity.path = "/revit/other-report";
  assert.equal(verified(read), false);
  assert.equal(postconditionSatisfiedByPayloadV2(null, read), false);
}));

test("source, binding, authority and retained payload hashes cannot be substituted", () => workspace(() => {
  const cases: Array<[string, (f: any) => void]> = [
    ["source", f => f.subject.input.source += " changed"],
    ["old subject generation", f => f.subject.binding = { ...f.subject.binding, generation: 0 }],
    ["old observation generation", f => f.snapshot.observations.obs.binding = { ...f.subject.binding, generation: 0 }],
    ["foreign observation", f => f.snapshot.observations.obs.operation_id = "another"],
    ["altered observation hash", f => f.snapshot.observations.obs.raw_payload_hash = "0".repeat(64)],
    ["altered matching hashes", f => { f.snapshot.observations.obs.raw_payload_hash = "0".repeat(64); f.subject.result.raw_payload_hash = "0".repeat(64); }],
    ["unknown effect", f => f.subject.persistent_effect = "unknown"],
    ["preview", f => f.subject.input.mode = "preview"],
    ["model report read", f => f.read.authority = "dynamic-runtime"],
    ["foreign read", f => f.read.binding = { ...f.read.binding, assignment_id: "foreign" }],
    ["read failure", f => f.read.status = "failed_after_dispatch"]
  ];
  for (const [name, change] of cases) { const f = fixture(); change(f); assert.equal(derive(f), null, name); }
}));

test("native receipt or graph gaps and unsupported mixed operations never partially verify a program", () => workspace(() => {
  const editReceipt = (p: any, fn: (r: any) => void) => { const r = JSON.parse(p.evidence.applyReceipt); fn(r); p.evidence.applyReceipt = JSON.stringify(r); };
  const cases: Array<[string, (p: any) => void]> = [
    ["unknown receipt", p => editReceipt(p, r => r.outcome = "unknown")],
    ["other graph", p => editReceipt(p, r => r.graph_hash = "sha256:" + "d".repeat(64))],
    ["other native session", p => editReceipt(p, r => r.document_session_id = "another")],
    ["other document", p => editReceipt(p, r => r.document_fingerprint = "sha256:" + "e".repeat(64))],
    ["wrong after value", p => editReceipt(p, r => r.operation_results[0].after = "WRONG")],
    ["missing native operation", p => editReceipt(p, r => r.operation_results.pop())],
    ["missing changed target", p => editReceipt(p, r => r.changed_element_ids = [99])],
    ["missing host authentication", p => p.evidence.hostAuthenticationReceipts = []],
    ["wrong snapshot input", p => p.evidence.workerOutput.graph.inputHash = "sha256:" + "f".repeat(64)],
    ["unsupported graph", p => p.evidence.workerOutput.graph.schema = "dynamic-revit-mep-graph/v1"],
    ["mixed move operation", p => p.evidence.workerOutput.graph.operations[1].kind = "move_element"],
    ["duplicate operation", p => p.evidence.workerOutput.graph.operations[1] = p.evidence.workerOutput.graph.operations[0]],
    ["malformed receipt", p => p.evidence.applyReceipt = "{}"],
    ["program reports cannot replace native proof", p => { p.report = { verified: true }; p.evidence.applyReceipt = ""; }]
  ];
  for (const [name, change] of cases) assert.equal(derive(fixture(change)), null, name);
}));
