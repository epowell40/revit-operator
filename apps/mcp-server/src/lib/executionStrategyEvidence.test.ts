import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_STRATEGY_EVIDENCE_V1,
  recordExecutionStrategyEvidence
} from "./executionStrategyEvidence.js";

test("records bounded model strategy evidence without granting authority", () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const receipt = recordExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "typed_capability_composition",
    reason: "Two exact primitives provide the shortest deterministic path."
  }, (event, data) => events.push({ event, data }), () => new Date("2026-08-09T01:02:03.000Z"), () => "fixed");

  assert.equal(receipt.evidenceId, "strategy_fixed");
  assert.equal(receipt.authority, "telemetry_only");
  assert.equal(receipt.authorization_granted, false);
  assert.deepEqual(events, [{ event: "execution.strategy.selected", data: receipt }]);
});

test("rejects invalid substrate and unbounded reason", () => {
  assert.throws(() => recordExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "invented" as never,
    reason: "No."
  }), /selected_substrate is invalid/);
  assert.throws(() => recordExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "dynamic_revit_program",
    reason: "x".repeat(321)
  }), /1-320 characters/);
});
