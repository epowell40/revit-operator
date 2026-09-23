import assert from "node:assert/strict";
import test from "node:test";
import { loadRegisteredRouteSourceEvidenceV1 } from "../src/existing_conditions/registered_route_evidence.js";

const evidenceId = `ev1_${"a".repeat(32)}`;
const binding = { session_id: "session-1", assignment_id: "assignment-1", run_id: "run-1", generation: 2 };
const ref = {
  evidence_id: evidenceId, source: "existing_conditions_registered_interpretation",
  trust_level: "host_observed", content_hash: `sha256:${"b".repeat(64)}`,
  ...binding, attempt_id: "registration-1"
};
const interpretation = { schema_version: 1, package_id: "sheet-1", native_write_allowed: false };

test("loads the exact registered source under the active Assignment scope", () => {
  let readScope: unknown;
  const result = loadRegisteredRouteSourceEvidenceV1(binding, evidenceId, {
    read_ref: () => ref as any,
    read_payload: (_ref, scope) => {
      readScope = scope;
      return Buffer.from(JSON.stringify(interpretation));
    }
  });
  assert.deepEqual(result.interpretation, interpretation);
  assert.equal(result.sha256, "b".repeat(64));
  assert.deepEqual(readScope, { ...binding, attempt_id: "registration-1" });
});

test("rejects a registered route source from a different run, source, or trust level", () => {
  for (const tampered of [
    { ...ref, run_id: "run-older" },
    { ...ref, source: "existing_conditions_structured_interpretation" },
    { ...ref, trust_level: "agent_claimed" },
    { ...ref, evidence_id: `ev1_${"c".repeat(32)}` }
  ]) {
    assert.throws(() => loadRegisteredRouteSourceEvidenceV1(binding, evidenceId, {
      read_ref: () => tampered as any,
      read_payload: () => { throw new Error("should_not_read_payload"); }
    }), /registration_evidence_scope_invalid/);
  }
});

test("requires a current Assignment binding and a valid registration evidence id", () => {
  assert.throws(() => loadRegisteredRouteSourceEvidenceV1({ ...binding, generation: 0 }, evidenceId),
    /assignment_binding_required/);
  assert.throws(() => loadRegisteredRouteSourceEvidenceV1(binding, "unbound-reference"),
    /registration_evidence_id_required/);
});
