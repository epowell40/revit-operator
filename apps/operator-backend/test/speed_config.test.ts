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

  const route = selectSpeedRoute(req("select the walls on level 2"), settings, { model: "gpt-5.5", reasoning_effort: "medium" });
  assert.equal(route.route, "executor");
  assert.equal(route.model, "gpt-5.4-mini");
  assert.equal(route.reasoning_effort, "low");
});

test("speed mode defaults to executor split with context diet", () => {
  const settings = resolveSpeedSettings({});
  const route = selectSpeedRoute(req("change panel P105 MCB Rating to 400"), settings, { model: "gpt-5.5", reasoning_effort: "medium" });

  assert.equal(settings.speed_mode, true);
  assert.equal(settings.context_diet, true);
  assert.equal(route.route, "executor");
  assert.equal(route.model, "gpt-5.4-mini");
});

test("speed mode routes failed tool continuations to planner", () => {
  const settings = resolveSpeedSettings({
    ui: {
      speed_settings: {
        speed_mode: true,
        planner_model: "gpt-5.5",
        executor_model: "gpt-5.4-mini"
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
    { model: "gpt-5.5", reasoning_effort: "medium" }
  );

  assert.equal(route.route, "planner");
  assert.equal(route.model, "gpt-5.5");
});

test("speed mode off preserves classic model defaults", () => {
  const settings = resolveSpeedSettings({ ui: { speed_settings: { speed_mode: false } } });
  const route = selectSpeedRoute(req("select a door"), settings, { model: "gpt-5.5", reasoning_effort: "high" });

  assert.equal(route.route, "classic");
  assert.equal(route.model, "gpt-5.5");
  assert.equal(route.reasoning_effort, "high");
});
