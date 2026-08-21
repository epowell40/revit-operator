import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { decideOpenAi } from "../src/brains/openai_brain.js";
import { __testOnlyFinalizeDecision } from "../src/brain.js";

const ENV_KEYS = [
  "OPERATOR_OPENAI_API_KEY",
  "OPERATOR_OPENAI_BASE_URL",
  "OPERATOR_OPENAI_CONTINUATION_ROUNDS",
  "OPERATOR_SPEED_MODE",
  "OPERATOR_PLANNER_MODEL",
  "OPERATOR_PLANNER_REASONING_EFFORT",
  "OPERATOR_EXECUTOR_MODEL",
  "OPERATOR_EXECUTOR_REASONING_EFFORT"
] as const;

function request(sessionId: string): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `${sessionId}:message`,
    user_text: "select the walls on level 2"
  };
}

function saveEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureProvider(port: number): void {
  process.env.OPERATOR_OPENAI_API_KEY = "test-key";
  process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPERATOR_OPENAI_CONTINUATION_ROUNDS = "0";
  process.env.OPERATOR_SPEED_MODE = "1";
  process.env.OPERATOR_PLANNER_MODEL = "gpt-5.6-sol";
  process.env.OPERATOR_PLANNER_REASONING_EFFORT = "medium";
  process.env.OPERATOR_EXECUTOR_MODEL = "gpt-5.6-luna";
  process.env.OPERATOR_EXECUTOR_REASONING_EFFORT = "max";
}

test("OpenAI brain returns provider usage and actual Luna/max route on successful decisions", { concurrency: false }, async () => {
  let requestBody: any = null;
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const decision = {
        assistant_message: "provider output must not enter the receipt",
        execution_strategy: null,
        dynamic_program: null,
        actions: [],
        web_requests: [],
        dev_actions: [],
        workbench_actions: []
      };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        id: "resp_brain_luna",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [{
          id: "msg_brain_luna",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(decision), annotations: [] }]
        }],
        usage: {
          input_tokens: 500,
          input_tokens_details: { cached_tokens: 350 },
          output_tokens: 80,
          output_tokens_details: { reasoning_tokens: 50 },
          total_tokens: 580
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = saveEnvironment();
  try {
    configureProvider(address.port);
    const result = await decideOpenAi(request("model-call-receipt-success"));

    assert.equal(requestBody.model, "gpt-5.6-luna");
    assert.equal(requestBody.reasoning.effort, "max");
    assert.equal(result.model_call_receipts?.length, 1);
    const receipt = result.model_call_receipts?.[0];
    assert.equal(receipt?.call_id, "resp_brain_luna");
    assert.equal(receipt?.route, "executor");
    assert.equal(receipt?.requested_model, "gpt-5.6-luna");
    assert.equal(receipt?.model, "gpt-5.6-luna");
    assert.equal(receipt?.reasoning_effort, "max");
    assert.equal(receipt?.success, true);
    assert.equal(receipt?.tokens.cached_input_tokens, 350);
    assert.equal(receipt?.tokens.reasoning_output_tokens, 50);
    assert.doesNotMatch(JSON.stringify(receipt), /provider output must not enter the receipt/);
  } finally {
    restoreEnvironment(previous);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("OpenAI brain returns a content-free receipt when the provider call fails", { concurrency: false }, async () => {
  const server = http.createServer((_incoming, outgoing) => {
    outgoing.writeHead(400, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({
      error: {
        message: "sensitive provider failure detail",
        type: "invalid_request_error",
        code: "bad_request"
      }
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = saveEnvironment();
  try {
    configureProvider(address.port);
    const result = await decideOpenAi(request("model-call-receipt-error"));

    assert.equal(result.model_call_receipts?.length, 1);
    const receipt = result.model_call_receipts?.[0];
    assert.equal(receipt?.route, "executor");
    assert.equal(receipt?.success, false);
    assert.equal(receipt?.tokens.input_tokens, null);
    assert.ok(receipt?.error_code);
    assert.doesNotMatch(JSON.stringify(receipt), /sensitive provider failure detail/);
  } finally {
    restoreEnvironment(previous);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("bounded continuation calls remain separate receipts", { concurrency: false }, async () => {
  let callCount = 0;
  const server = http.createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => {
      callCount += 1;
      const decision = callCount === 1
        ? {
            assistant_message: "Inspecting bounded workspace state.",
            execution_strategy: null,
            dynamic_program: null,
            actions: [],
            web_requests: [],
            dev_actions: [],
            workbench_actions: [{ type: "list_files", dir_path: "artifacts", recursive: false, max_items: 2 }]
          }
        : {
            assistant_message: "Answer: bounded inspection complete.",
            execution_strategy: null,
            dynamic_program: null,
            actions: [],
            web_requests: [],
            dev_actions: [],
            workbench_actions: []
          };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        id: `resp_continuation_${callCount}`,
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [{
          id: `msg_continuation_${callCount}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(decision), annotations: [] }]
        }],
        usage: {
          input_tokens: 100 * callCount,
          output_tokens: 10 * callCount,
          total_tokens: 110 * callCount
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = saveEnvironment();
  try {
    configureProvider(address.port);
    process.env.OPERATOR_OPENAI_CONTINUATION_ROUNDS = "1";
    const result = await decideOpenAi(request("model-call-receipt-continuation"));

    assert.equal(callCount, 2);
    assert.deepEqual(result.model_call_receipts?.map(receipt => receipt.call_id), [
      "resp_continuation_1",
      "resp_continuation_2"
    ]);
    assert.deepEqual(result.model_call_receipts?.map(receipt => receipt.tokens.total_tokens), [110, 220]);
  } finally {
    restoreEnvironment(previous);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("shared brain fallback preserves receipts when a provider returns a blank no-op", () => {
  const result = __testOnlyFinalizeDecision(request("model-call-receipt-fallback"), {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "",
    actions: [],
    model_call_receipts: [{
      schema: "revit-operator.model-call-receipt.v1",
      call_id: "resp_blank_noop",
      provider: "openai",
      route: "executor",
      requested_model: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      started_at_utc: "2026-08-21T12:00:00.000Z",
      duration_ms: 10,
      success: true,
      response_status: "completed",
      error_code: null,
      tokens: {
        input_tokens: 10,
        cached_input_tokens: 5,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 10
      }
    }]
  });

  assert.equal(result.model_call_receipts?.[0]?.call_id, "resp_blank_noop");
  assert.match(result.assistant_message, /internal fallback response/i);
});
