import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpeedSettings, selectSpeedRoute } from "../src/speed_config.js";
import type { ChatRequest } from "../src/contracts.js";

function req(user_text: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    version: "test",
    session_id: "s1",
    message_id: "m1",
    user_text,
    ...extra
  } as ChatRequest;
}

test("speed mode routes direct commands to executor", () => {
  const settings = resolveSpeedSettings({
    ui: {
      speed_settings: {
        speed_mode: true,
        context_diet: true
      }
    }
  });

  const route = selectSpeedRoute(req("select the walls on level 2"), settings, { model: "gpt-5.6-sol", reasoning_effort: "medium" });
  assert.equal(route.route, "executor");
  assert.equal(route.model, "gpt-5.6-terra");
  assert.equal(route.reasoning_effort, "medium");
});

test("speed mode defaults to executor split with context diet", () => {
  const settings = resolveSpeedSettings({});
  const route = selectSpeedRoute(req("change panel P105 MCB Rating to 400"), settings, { model: "gpt-5.6-sol", reasoning_effort: "medium" });

  assert.equal(settings.speed_mode, true);
  assert.equal(settings.context_diet, true);
  assert.equal(route.route, "executor");
  assert.equal(settings.planner_model, "gpt-5.6-sol");
  assert.equal(settings.planner_reasoning_effort, "medium");
  assert.equal(route.model, "gpt-5.6-terra");
  assert.equal(route.reasoning_effort, "medium");
});

test("speed mode routes failed tool continuations to planner", () => {
  const settings = resolveSpeedSettings({
    ui: {
      speed_settings: {
        speed_mode: true,
        planner_model: "gpt-5.6-sol",
        executor_model: "gpt-5.6-terra"
      }
    }
  });

  const route = selectSpeedRoute(
    req("", {
      tool_results: [
        {
          action_id: "a1",
          method: "POST",
          path: "/revit/select",
          status: "failed",
          error: "not found"
        }
      ]
    }),
    settings,
    { model: "gpt-5.6-sol", reasoning_effort: "medium" }
  );

  assert.equal(route.route, "planner");
  assert.equal(route.model, "gpt-5.6-sol");
});

test("speed mode off preserves classic model defaults", () => {
  const settings = resolveSpeedSettings({ ui: { speed_settings: { speed_mode: false } } });
  const route = selectSpeedRoute(req("select a door"), settings, { model: "gpt-5.6-sol", reasoning_effort: "high" });

  assert.equal(route.route, "classic");
  assert.equal(route.model, "gpt-5.6-sol");
  assert.equal(route.reasoning_effort, "high");
});

test("deployment routing overrides stale pane model settings", () => {
  const previous = {
    plannerModel: process.env.OPERATOR_PLANNER_MODEL,
    plannerEffort: process.env.OPERATOR_PLANNER_REASONING_EFFORT,
    executorModel: process.env.OPERATOR_EXECUTOR_MODEL,
    executorEffort: process.env.OPERATOR_EXECUTOR_REASONING_EFFORT
  };
  process.env.OPERATOR_PLANNER_MODEL = "gpt-5.6-sol";
  process.env.OPERATOR_PLANNER_REASONING_EFFORT = "medium";
  process.env.OPERATOR_EXECUTOR_MODEL = "gpt-5.6-terra";
  process.env.OPERATOR_EXECUTOR_REASONING_EFFORT = "medium";
  try {
    const settings = resolveSpeedSettings({
      ui: {
        speed_settings: {
          planner_model: "gpt-5.5",
          planner_reasoning_effort: "high",
          executor_model: "gpt-5.4-mini",
          executor_reasoning_effort: "low"
        }
      }
    });
    assert.equal(settings.planner_model, "gpt-5.6-sol");
    assert.equal(settings.planner_reasoning_effort, "medium");
    assert.equal(settings.executor_model, "gpt-5.6-terra");
    assert.equal(settings.executor_reasoning_effort, "medium");
  } finally {
    for (const [key, value] of Object.entries({
      OPERATOR_PLANNER_MODEL: previous.plannerModel,
      OPERATOR_PLANNER_REASONING_EFFORT: previous.plannerEffort,
      OPERATOR_EXECUTOR_MODEL: previous.executorModel,
      OPERATOR_EXECUTOR_REASONING_EFFORT: previous.executorEffort
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("literal max and Luna pass through the executor route", { concurrency: false }, () => {
  const previous = {
    model: process.env.OPERATOR_EXECUTOR_MODEL,
    effort: process.env.OPERATOR_EXECUTOR_REASONING_EFFORT
  };
  delete process.env.OPERATOR_EXECUTOR_MODEL;
  delete process.env.OPERATOR_EXECUTOR_REASONING_EFFORT;
  try {
    const settings = resolveSpeedSettings({
      ui: {
        speed_settings: {
          speed_mode: true,
          executor_model: "gpt-5.6-luna",
          executor_reasoning_effort: "max"
        }
      }
    });
    const route = selectSpeedRoute(req("select the walls on level 2"), settings, {
      model: "gpt-5.6-sol",
      reasoning_effort: "medium"
    });

    assert.equal(route.route, "executor");
    assert.equal(route.model, "gpt-5.6-luna");
    assert.equal(route.reasoning_effort, "max");
  } finally {
    if (previous.model === undefined) delete process.env.OPERATOR_EXECUTOR_MODEL;
    else process.env.OPERATOR_EXECUTOR_MODEL = previous.model;
    if (previous.effort === undefined) delete process.env.OPERATOR_EXECUTOR_REASONING_EFFORT;
    else process.env.OPERATOR_EXECUTOR_REASONING_EFFORT = previous.effort;
  }
});

test("unsafe or oversized model ids fail closed to bounded defaults", { concurrency: false }, () => {
  const previous = {
    planner: process.env.OPERATOR_PLANNER_MODEL,
    executor: process.env.OPERATOR_EXECUTOR_MODEL
  };
  process.env.OPERATOR_PLANNER_MODEL = "../../unsafe model";
  process.env.OPERATOR_EXECUTOR_MODEL = "x".repeat(129);
  try {
    const settings = resolveSpeedSettings({
      ui: {
        speed_settings: {
          planner_model: "gpt-5.6-sol",
          executor_model: "gpt-5.6-luna"
        }
      }
    });
    assert.equal(settings.planner_model, "gpt-5.6-sol");
    assert.equal(settings.executor_model, "gpt-5.6-luna");
  } finally {
    if (previous.planner === undefined) delete process.env.OPERATOR_PLANNER_MODEL;
    else process.env.OPERATOR_PLANNER_MODEL = previous.planner;
    if (previous.executor === undefined) delete process.env.OPERATOR_EXECUTOR_MODEL;
    else process.env.OPERATOR_EXECUTOR_MODEL = previous.executor;
  }
});
