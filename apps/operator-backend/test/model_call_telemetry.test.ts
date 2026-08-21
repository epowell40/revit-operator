import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAiModelCallReceipt,
  extractOpenAiTokenUsage,
  openAiUsageNotificationsEnabled,
  recordOpenAiModelCallReceipt,
  recordOpenAiUsageTelemetry
} from "../src/model_call_telemetry.js";

test("OpenAI token usage retains cached and reasoning detail without inference", () => {
  assert.deepEqual(extractOpenAiTokenUsage({
    input_tokens: 120,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens: 45,
    output_tokens_details: { reasoning_tokens: 30 },
    total_tokens: 165
  }), {
    input_tokens: 120,
    cached_input_tokens: 80,
    output_tokens: 45,
    reasoning_output_tokens: 30,
    total_tokens: 165
  });

  assert.deepEqual(extractOpenAiTokenUsage({ input_tokens: 12 }), {
    input_tokens: 12,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null
  });
});

test("model call receipts contain bounded metadata and never provider content", () => {
  const receipt = createOpenAiModelCallReceipt({
    route: "executor",
    requested_model: "gpt-5.6-luna",
    reasoning_effort: "max",
    started_at_utc: "2026-08-21T12:00:00.000Z",
    duration_ms: 42.9,
    response: {
      id: "resp_telemetry_1",
      status: "completed",
      model: "gpt-5.6-luna",
      output_text: "must not be copied",
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 60 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 14 },
        total_tokens: 120
      }
    }
  });

  assert.equal(receipt.call_id, "resp_telemetry_1");
  assert.equal(receipt.requested_model, "gpt-5.6-luna");
  assert.equal(receipt.model, "gpt-5.6-luna");
  assert.equal(receipt.reasoning_effort, "max");
  assert.equal(receipt.duration_ms, 42);
  assert.equal(receipt.success, true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /must not be copied/);
  assert.doesNotMatch(serialized, /output_text|prompt|instructions/);
});

test("failed model calls receive separate ids with null provider usage", () => {
  const first = createOpenAiModelCallReceipt({
    route: "planner",
    requested_model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    started_at_utc: "2026-08-21T12:00:00.000Z",
    duration_ms: 5,
    error: Object.assign(new Error("secret provider message"), { status: 400 })
  });
  const second = createOpenAiModelCallReceipt({
    route: "planner",
    requested_model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    started_at_utc: "2026-08-21T12:00:01.000Z",
    duration_ms: 7,
    error: new Error("another secret provider message")
  });

  assert.equal(first.success, false);
  assert.equal(first.error_code, "http_400");
  assert.notEqual(first.call_id, second.call_id);
  assert.deepEqual(first.tokens, {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null
  });
  assert.doesNotMatch(JSON.stringify([first, second]), /secret provider message/);
});

test("recorded receipts remain authoritative when persistence fails", () => {
  const receipts: ReturnType<typeof createOpenAiModelCallReceipt>[] = [];
  const receipt = recordOpenAiModelCallReceipt({
    receipts,
    receipt_input: {
      route: "planner",
      requested_model: "gpt-5.6-sol",
      reasoning_effort: "high",
      started_at_utc: "2026-08-21T12:00:00.000Z",
      duration_ms: 19,
      response: { id: "resp_persistence_failure", status: "completed", usage: { total_tokens: 9 } }
    },
    append_receipt: () => { throw new Error("storage unavailable"); }
  });

  assert.equal(receipt.call_id, "resp_persistence_failure");
  assert.deepEqual(receipts, [receipt]);
});

test("usage telemetry preserves bounded provider metrics and timing payloads", () => {
  const receipt = createOpenAiModelCallReceipt({
    route: "executor",
    requested_model: "gpt-5.6-luna",
    reasoning_effort: "max",
    started_at_utc: "2026-08-21T12:00:00.000Z",
    duration_ms: 42,
    response: {
      id: "resp_usage",
      status: "completed",
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 60 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 14 },
        total_tokens: 120
      }
    }
  });
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const notifications: Array<{ type: string; message: string; payload: Record<string, unknown> }> = [];

  recordOpenAiUsageTelemetry({
    receipt,
    route: "executor",
    route_reason: "known direct command",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    prompt_build_ms: 7,
    model_latency_ms: 42,
    input_chars: 800,
    usage_notifications_enabled: true,
    append_event: (type, payload) => events.push({ type, payload }),
    append_notification: (type, message, payload) => notifications.push({ type, message, payload })
  });

  assert.deepEqual(notifications, [{
    type: "openai.usage",
    message: "OpenAI usage: model=gpt-5.6-luna, in=100, out=20, total=120",
    payload: {
      model: "gpt-5.6-luna",
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 20,
      reasoning_output_tokens: 14,
      total_tokens: 120
    }
  }]);
  assert.deepEqual(events.map(event => event.type), ["openai.usage", "speed.timing"]);
  assert.deepEqual(events[1]?.payload, {
    route: "executor",
    reason: "known direct command",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    call_id: "resp_usage",
    success: true,
    prompt_build_ms: 7,
    model_latency_ms: 42,
    input_chars: 800,
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    reasoning_output_tokens: 14,
    total_tokens: 120
  });
});

test("usage notification environment aliases remain compatible", { concurrency: false }, () => {
  const previous = process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS;
  try {
    for (const enabled of ["1", "true", "yes", "on"]) {
      process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS = enabled;
      assert.equal(openAiUsageNotificationsEnabled(), true);
    }
    process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS = "0";
    assert.equal(openAiUsageNotificationsEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS;
    else process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS = previous;
  }
});
