import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { deriveTerminalResultV2 } from "../src/assignments/assignment_kernel_v2_terminal_result.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";

test("C142 retained five-element apply produces a specific terminal artifact only with verified readback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-c142-terminal-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const binding = { assignment_id: "c142", run_id: "run", generation: 1,
      session_id: "session", principal_id: "principal", document_fingerprint: "sample" };
    const snapshot: any = { current_binding: binding, observations: {}, operations: {}, criteria: {},
      spec: { requested_effect: "apply" }, terminal: true, outcome: "complete", assignment_version: 7 };
    const add = (id: string, payload: unknown, pathName: string, effect: "applied" | "none") => {
      const stored = storeEvidence({ scope: { session_id: binding.session_id, assignment_id: binding.assignment_id,
        run_id: binding.run_id, generation: binding.generation, attempt_id: id },
        source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw: payload });
      snapshot.operations[id] = { operation_id: id, binding, capability_id: `native:POST:${pathName}`,
        requested_effect: effect === "applied" ? "apply" : "read", persistent_effect: effect,
        purpose: effect === "applied" ? "task" : "verification", settlement_state: "settled",
        result: { status: "succeeded", persistent_effect: effect,
          native_transaction_state: effect === "applied" ? "committed" : "not_applicable" }, observation_ids: [id] };
      snapshot.observations[id] = { observation_id: id, operation_id: id, binding,
        authority: "native-host", evidence_class: effect === "applied" ? "task_result" : "verification",
        raw_payload_ref: `evidence:${stored.ref.evidence_id}`, raw_payload_hash: payloadDigestV2(payload).digest,
        observed_at: effect === "applied" ? "2026-09-25T18:23:38Z" : "2026-09-25T18:24:28Z",
        facts: effect === "applied"
          ? [{ fact_id: "task.result_available", fact_class: "domain", value: true }]
          : [{ fact_id: "verification.postcondition_satisfied", fact_class: "verification", value: true }] };
      snapshot.criteria[id] = { status: "pass", supporting_facts: [{ observation_id: id }] };
    };
    const branch = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/c142-registered-tee-apply.json"), "utf8"));
    add("apply", branch, "/revit/existing-conditions-mep-draft-workflow", "applied");
    add("verify", { status: "Ok" }, "/revit/get-connectors", "none");
    snapshot.operations.apply.verification_operation_ids = ["verify"];
    snapshot.operations.verify.verification_of_operation_id = "apply";
    const result = deriveTerminalResultV2(snapshot);
    assert.equal(result.result_summary,
      "Added and verified an 8-inch Supply Air branch on L4: 2 duct segments, a tee, and 1 elbow. One branch end remains open.");
    assert.deepEqual(result.supporting_observation_ids, ["apply", "verify"]);
    assert.equal(result.evidence_refs.length, 2);
    snapshot.observations.verify.facts[0].value = false;
    assert.notEqual(deriveTerminalResultV2(snapshot).result_summary, result.result_summary);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
