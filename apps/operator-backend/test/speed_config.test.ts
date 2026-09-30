import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentModelSettings, resolveSpeedSettings, selectSpeedRoute } from "../src/speed_config.js";
import type { ChatRequest } from "../src/contracts.js";

function req(user_text: string): ChatRequest {
  return { version: "operator.backend.v1", session_id: "s1", message_id: "m1", user_text } as ChatRequest;
}

test("one explicit agent setting controls every legacy compatibility route", () => {
  const context = { ui: { speed_settings: {
    speed_mode: true,
    agent_model: "gpt-5.6-luna",
    agent_reasoning_effort: "max"
  } } };
  const settings = resolveSpeedSettings(context);
  const route = selectSpeedRoute(req("select the walls on level 2"), settings, {
    model: "gpt-5.6-sol", reasoning_effort: "medium"
  });
  assert.deepEqual(resolveAgentModelSettings(context), { model: "gpt-5.6-luna", reasoning_effort: "max" });
  assert.equal(settings.split_planner_executor, false);
  assert.equal(settings.planner_model, "gpt-5.6-luna");
  assert.equal(settings.executor_model, "gpt-5.6-luna");
  assert.equal(route.route, "classic");
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.reasoning_effort, "max");
});

test("request settings override deployment defaults for benchmark reproducibility", { concurrency: false }, () => {
  const priorModel = process.env.OPERATOR_AGENT_MODEL;
  const priorEffort = process.env.OPERATOR_AGENT_REASONING_EFFORT;
  process.env.OPERATOR_AGENT_MODEL = "gpt-5.6-sol";
  process.env.OPERATOR_AGENT_REASONING_EFFORT = "medium";
  try {
    assert.deepEqual(resolveAgentModelSettings({ ui: { speed_settings: {
      agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max"
    } } }), { model: "gpt-5.6-luna", reasoning_effort: "max" });
  } finally {
    if (priorModel === undefined) delete process.env.OPERATOR_AGENT_MODEL;
    else process.env.OPERATOR_AGENT_MODEL = priorModel;
    if (priorEffort === undefined) delete process.env.OPERATOR_AGENT_REASONING_EFFORT;
    else process.env.OPERATOR_AGENT_REASONING_EFFORT = priorEffort;
  }
});

test("unified agent defaults are Sol medium and unsafe ids fail closed", () => {
  assert.deepEqual(resolveAgentModelSettings({}), { model: "gpt-5.6-sol", reasoning_effort: "medium" });
  assert.deepEqual(resolveAgentModelSettings({ ui: { speed_settings: {
    agent_model: "../../unsafe model", agent_reasoning_effort: "impossible"
  } } }), { model: "gpt-5.6-sol", reasoning_effort: "medium" });
});

test("provider defaults survive unrelated Codex defaults and retain explicit agent overrides", () => {
  const prior = { model: process.env.OPERATOR_CODEX_MODEL, effort: process.env.OPERATOR_CODEX_REASONING_EFFORT };
  process.env.OPERATOR_CODEX_MODEL = "gpt-6-astra";
  process.env.OPERATOR_CODEX_REASONING_EFFORT = "high";
  try {
    const apiDefaults = { model: "gpt-6.1-sol", reasoning_effort: "medium" as const };
    assert.deepEqual(resolveAgentModelSettings({}, apiDefaults), apiDefaults);
    assert.deepEqual(resolveAgentModelSettings({ ui: { speed_settings: {
      agent_model: "gpt-5.6-luna", agent_reasoning_effort: "max"
    } } }, apiDefaults), { model: "gpt-5.6-luna", reasoning_effort: "max" });
    assert.deepEqual(resolveAgentModelSettings({}), { model: "gpt-6-astra", reasoning_effort: "high" });
  } finally {
    if (prior.model === undefined) delete process.env.OPERATOR_CODEX_MODEL;
    else process.env.OPERATOR_CODEX_MODEL = prior.model;
    if (prior.effort === undefined) delete process.env.OPERATOR_CODEX_REASONING_EFFORT;
    else process.env.OPERATOR_CODEX_REASONING_EFFORT = prior.effort;
  }
});

test("GPT-6.1 Sol keeps the requested model and rejects unsupported no-reasoning requests", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.deepEqual(resolveAgentModelSettings({ ui: { speed_settings: {
      agent_model: "gpt-6.1-sol", agent_reasoning_effort: effort
    } } }), { model: "gpt-6.1-sol", reasoning_effort: effort });
  }
  assert.throws(() => resolveAgentModelSettings({ ui: { speed_settings: {
    agent_model: "gpt-6.1-sol", agent_reasoning_effort: "none"
  } } }), /gpt-6.1-sol.*low.*medium.*high.*xhigh.*max/);
  assert.equal(resolveAgentModelSettings({ ui: { speed_settings: {
    agent_model: "gpt-5.6-sol", agent_reasoning_effort: "none"
  } } }).reasoning_effort, "none");
});
