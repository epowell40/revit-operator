import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_STRATEGY_EVIDENCE_V1,
  GENERAL_AGENT_EXECUTION_STRATEGY_LINES,
  normalizeExecutionStrategyEvidence,
  recordExecutionStrategyEvidence
} from "../src/execution_strategy.js";

test("provider-neutral instruction gives the model three representations without text routing", () => {
  const instruction = GENERAL_AGENT_EXECUTION_STRATEGY_LINES.join("\n");
  assert.match(instruction, /one certified typed capability/i);
  assert.match(instruction, /composition of a few certified typed capabilities/i);
  assert.match(instruction, /bounded task-specific Dynamic Revit program/i);
  assert.match(instruction, /loops or branching/i);
  assert.match(instruction, /company\/project\/user-specific rules/i);
  assert.match(instruction, /Do not route by prompt keywords or regexes/i);
  assert.match(instruction, /grants no capability, admission, approval, or authorization/i);
});

test("strategy evidence is bounded, exact, and explicitly non-authorizing", () => {
  const recorded: unknown[] = [];
  const evidence = recordExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "dynamic_revit_program",
    reason: "A bounded geometry loop avoids many repetitive calls."
  }, value => recorded.push(value), () => new Date("2026-08-09T01:02:03.000Z"));

  assert.deepEqual(recorded, [evidence]);
  assert.deepEqual(evidence, {
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "dynamic_revit_program",
    reason: "A bounded geometry loop avoids many repetitive calls.",
    recorded_at_utc: "2026-08-09T01:02:03.000Z",
    authority: "telemetry_only",
    authorization_granted: false
  });
});

test("strategy evidence rejects unbounded prose, invented substrates, and authority fields", () => {
  assert.throws(() => normalizeExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "prompt_keyword_router",
    reason: "bulk"
  }), /selected_substrate is invalid/);
  assert.throws(() => normalizeExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "typed_capability",
    reason: "x".repeat(321)
  }), /1-320 characters/);
  assert.throws(() => normalizeExecutionStrategyEvidence({
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: "typed_capability",
    reason: "Exact primitive exists.",
    authorization_granted: true
  }), /unexpected or missing fields/);
});
