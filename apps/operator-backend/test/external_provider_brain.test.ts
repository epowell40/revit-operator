import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAnthropic,
  decideGemini
} from "../src/brains/external_provider_brain.js";
import { decide } from "../src/brain.js";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse
} from "../src/contracts.js";

function request(text = "Inspect the active view and take the next smallest safe action."): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: `external-provider-${Date.now()}-${Math.random()}`,
    message_id: "message-1",
    user_text: text
  };
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("Gemini brain uses structured output and normalizes action body_json", async () => {
  const previous = {
    OPERATOR_GEMINI_API_KEY: process.env.OPERATOR_GEMINI_API_KEY,
    OPERATOR_GEMINI_AGENT_MODEL: process.env.OPERATOR_GEMINI_AGENT_MODEL,
    OPERATOR_GEMINI_AGENT_BASE_URL: process.env.OPERATOR_GEMINI_AGENT_BASE_URL
  };
  process.env.OPERATOR_GEMINI_API_KEY = "test-gemini-key";
  process.env.OPERATOR_GEMINI_AGENT_MODEL = "gemini-test";
  process.env.OPERATOR_GEMINI_AGENT_BASE_URL = "https://gemini.test/v1beta";

  let requestedUrl = "";
  let requestedBody: any = null;
  let requestedHeaders: Record<string, string> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body ?? "{}"));
    requestedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    assistant_message: "I will dry-run one explicit pipe segment.",
                    actions: [
                      {
                        action_id: "pipe-1",
                        method: "POST",
                        path: "/revit/create-pipe",
                        body_json: JSON.stringify({
                          startX: 1,
                          startY: 2,
                          startZ: 3,
                          endX: 4,
                          endY: 2,
                          endZ: 3,
                          pipeSize: "2 in",
                          systemType: "Sanitary",
                          dryRun: true
                        })
                      }
                    ]
                  })
                }
              ]
            }
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const response = await decideGemini(request(), { fetchImpl });
    assert.equal(requestedUrl, "https://gemini.test/v1beta/models/gemini-test:generateContent");
    assert.equal(requestedHeaders["x-goog-api-key"], "test-gemini-key");
    assert.equal(requestedBody.generationConfig.responseMimeType, "application/json");
    assert.equal(requestedBody.generationConfig.responseJsonSchema.properties.actions.type, "array");
    assert.equal(response.actions.length, 1);
    assert.equal(response.actions[0]?.path, "/revit/create-pipe");
    assert.deepEqual(response.actions[0]?.body, {
      startX: 1,
      startY: 2,
      startZ: 3,
      endX: 4,
      endY: 2,
      endZ: 3,
      pipeSize: "2 in",
      systemType: "Sanitary",
      dryRun: true
    });
  } finally {
    restoreEnvironment(previous);
  }
});

test("Anthropic brain calls Messages API with Claude Opus 4.8 structured output", async () => {
  const previous = {
    OPERATOR_ANTHROPIC_API_KEY: process.env.OPERATOR_ANTHROPIC_API_KEY,
    OPERATOR_ANTHROPIC_MODEL: process.env.OPERATOR_ANTHROPIC_MODEL,
    OPERATOR_ANTHROPIC_BASE_URL: process.env.OPERATOR_ANTHROPIC_BASE_URL,
    OPERATOR_ANTHROPIC_EFFORT: process.env.OPERATOR_ANTHROPIC_EFFORT
  };
  process.env.OPERATOR_ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.OPERATOR_ANTHROPIC_MODEL = "claude-opus-4-8";
  process.env.OPERATOR_ANTHROPIC_BASE_URL = "https://anthropic.test";
  process.env.OPERATOR_ANTHROPIC_EFFORT = "xhigh";

  let requestedUrl = "";
  let requestedBody: any = null;
  let requestedHeaders: Record<string, string> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body ?? "{}"));
    requestedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              assistant_message: "I will inspect connector state first.",
              actions: [
                {
                  action_id: "inspect-1",
                  method: "POST",
                  path: "/revit/get-mep-connectors",
                  body_json: JSON.stringify({ elementIds: [101, 102] })
                }
              ]
            })
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const response = await decideAnthropic(request(), { fetchImpl });
    assert.equal(requestedUrl, "https://anthropic.test/v1/messages");
    assert.equal(requestedHeaders["x-api-key"], "test-anthropic-key");
    assert.equal(requestedHeaders["anthropic-version"], "2023-06-01");
    assert.equal(requestedBody.model, "claude-opus-4-8");
    assert.deepEqual(requestedBody.thinking, { type: "adaptive" });
    assert.equal(requestedBody.output_config.effort, "xhigh");
    assert.equal(requestedBody.output_config.format.type, "json_schema");
    assert.equal(response.actions[0]?.path, "/revit/get-mep-connectors");
    assert.deepEqual(response.actions[0]?.body, { elementIds: [101, 102] });
  } finally {
    restoreEnvironment(previous);
  }
});

test("OPERATOR_BRAIN=gemini routes to the Gemini brain even when OpenAI is configured", async () => {
  const previous = {
    OPERATOR_BRAIN: process.env.OPERATOR_BRAIN,
    OPERATOR_OPENAI_API_KEY: process.env.OPERATOR_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  process.env.OPERATOR_BRAIN = "gemini";
  process.env.OPERATOR_OPENAI_API_KEY = "test-openai-key";
  let calls = 0;
  const expected: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Gemini selected.",
    actions: []
  };

  try {
    const response = await decide(request("Hello, please respond."), {
      geminiBrain: async () => {
        calls += 1;
        return expected;
      }
    });
    assert.equal(calls, 1);
    assert.equal(response.assistant_message, "Gemini selected.");
  } finally {
    restoreEnvironment(previous);
  }
});

test("OPERATOR_BRAIN=claude is an alias for the Anthropic brain", async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  process.env.OPERATOR_BRAIN = "claude";
  let calls = 0;

  try {
    const response = await decide(request("Hello, please respond."), {
      anthropicBrain: async () => {
        calls += 1;
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: "Anthropic selected.",
          actions: []
        };
      }
    });
    assert.equal(calls, 1);
    assert.equal(response.assistant_message, "Anthropic selected.");
  } finally {
    restoreEnvironment(previous);
  }
});
