import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideAnthropic,
  decideGemini
} from "../src/brains/external_provider_brain.js";
import {
  decide,
  decideStreaming,
  isDirectBrainRouteRequest,
  resolveOperatorBrainRoute
} from "../src/brain.js";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse
} from "../src/contracts.js";
import { formatCodexRequestEnvelope } from "../src/brains/codex_brain.js";

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

test("Codex request envelope carries current context and exact attachment metadata", () => {
  const envelope = formatCodexRequestEnvelope({
    ...request(),
    context: {
      expectedModelPath: "C:\\benchmarks\\synthetic_fixture_frozen.rvt",
      nextAction: "isolate exact connector pair"
    },
    user_attachments: [
      {
        id: "source-image",
        relative_path: "artifacts/provider_trials/source_fixture_plan.png",
        filename: "source_fixture_plan.png",
        mime: "image/png",
        bytes: 1234,
        sha256: "abc123"
      }
    ]
  });

  assert.match(envelope, /CURRENT REVIT\/SERVER CONTEXT/);
  assert.match(envelope, /synthetic_fixture_frozen\.rvt/);
  assert.match(envelope, /isolate exact connector pair/);
  assert.match(envelope, /USER ATTACHMENTS/);
  assert.match(envelope, /artifacts\/provider_trials\/source_fixture_plan\.png/);
  assert.match(envelope, /abc123/);
});

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

test("streaming and non-streaming dispatch resolve the same configured brain", async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  const routes = [
    { configured: "rule", resolved: "rule" },
    { configured: "openai", resolved: "openai" },
    { configured: "codex", resolved: "codex" },
    { configured: "gemini", resolved: "gemini" },
    { configured: "claude", resolved: "anthropic" }
  ] as const;

  try {
    for (const route of routes) {
      process.env.OPERATOR_BRAIN = route.configured;
      assert.equal(resolveOperatorBrainRoute(), route.resolved);
      const calls: string[] = [];
      const responseFor = (lane: string): ChatResponse => ({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `${route.resolved}:${lane}`,
        actions: []
      });
      const dependencies = {
        ruleBrain: async () => {
          calls.push("rule:nonstream");
          return responseFor("nonstream");
        },
        openAiBrain: async () => {
          calls.push("openai:nonstream");
          return responseFor("nonstream");
        },
        openAiStreamingBrain: async () => {
          calls.push("openai:stream");
          return responseFor("stream");
        },
        codexBrain: async () => {
          calls.push("codex:nonstream");
          return responseFor("nonstream");
        },
        codexStreamingBrain: async () => {
          calls.push("codex:stream");
          return responseFor("stream");
        },
        geminiBrain: async () => {
          calls.push("gemini:nonstream");
          return responseFor("nonstream");
        },
        geminiStreamingBrain: async () => {
          calls.push("gemini:stream");
          return responseFor("stream");
        },
        anthropicBrain: async () => {
          calls.push("anthropic:nonstream");
          return responseFor("nonstream");
        },
        anthropicStreamingBrain: async () => {
          calls.push("anthropic:stream");
          return responseFor("stream");
        }
      };

      const nonStreaming = await decide(
        request(`Continue existing conditions reconstruction via ${route.configured} non-streaming.`),
        dependencies
      );
      const streaming = await decideStreaming(
        request(`Continue existing conditions reconstruction via ${route.configured} streaming.`),
        {},
        dependencies
      );

      assert.equal(nonStreaming.assistant_message, `${route.resolved}:nonstream`);
      assert.equal(
        streaming.assistant_message,
        route.resolved === "rule" ? `${route.resolved}:nonstream` : `${route.resolved}:stream`
      );
      assert.deepEqual(
        calls,
        route.resolved === "rule"
          ? ["rule:nonstream", "rule:nonstream"]
          : [`${route.resolved}:nonstream`, `${route.resolved}:stream`]
      );
    }
  } finally {
    restoreEnvironment(previous);
  }
});

test("explicit direct route bypasses deterministic prehandlers in both chat modes and retains shared finalization", async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  process.env.OPERATOR_BRAIN = "gemini";
  const directRequest: ChatRequest = {
    ...request("Repair this MEP route."),
    context: { operator_brain_route: "direct" }
  };
  let prehandlerCalls = 0;
  let selectedBrainCalls = 0;
  const emptyResponse: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "",
    actions: []
  };

  try {
    assert.equal(isDirectBrainRouteRequest(directRequest), true);
    assert.equal(isDirectBrainRouteRequest({ context: { operator_brain_route: "DIRECT" } }), false);

    const dependencies = {
      mepRouteRedline: async () => {
        prehandlerCalls += 1;
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: "Deterministic route intercepted.",
          actions: []
        } satisfies ChatResponse;
      },
      geminiBrain: async () => {
        selectedBrainCalls += 1;
        return emptyResponse;
      },
      geminiStreamingBrain: async () => {
        selectedBrainCalls += 1;
        return emptyResponse;
      }
    };

    const nonStreaming = await decide(directRequest, dependencies);
    const streaming = await decideStreaming(directRequest, {}, dependencies);

    assert.equal(prehandlerCalls, 0);
    assert.equal(selectedBrainCalls, 2);
    assert.match(nonStreaming.assistant_message, /internal fallback response/);
    assert.match(streaming.assistant_message, /internal fallback response/);
    assert.deepEqual(nonStreaming.actions, []);
    assert.deepEqual(streaming.actions, []);
  } finally {
    restoreEnvironment(previous);
  }
});

test("persisted existing-conditions stages advance without another provider call", { concurrency: false }, async () => {
  const previous = {
    OPERATOR_BRAIN: process.env.OPERATOR_BRAIN,
    OPERATOR_WORKSPACE_ROOT: process.env.OPERATOR_WORKSPACE_ROOT
  };
  process.env.OPERATOR_BRAIN = "claude";
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(
    path.join(os.tmpdir(), "operator-direct-stage-continuation-")
  );
  const sessionId = `direct-stage-${Date.now()}-${Math.random()}`;
  const fingerprint = "9".repeat(64);
  const directRequest = (
    toolResults: ChatRequest["tool_results"] = []
  ): ChatRequest => ({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `message-${Date.now()}-${Math.random()}`,
    user_text: "Continue the existing conditions reconstruction one stage at a time.",
    context: { operator_brain_route: "direct" },
    tool_results: toolResults
  });
  let providerCalls = 0;
  const dependencies = {
    anthropicBrain: async (): Promise<ChatResponse> => {
      providerCalls += 1;
      if (providerCalls > 1) {
        throw new Error("provider_must_not_run_for_deterministic_stage_continuation");
      }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "Move the retained tag by one reversible increment.",
        actions: [{
          action_id: "provider-proposal",
          method: "POST",
          path: "/revit/existing-conditions-mep-draft-workflow",
          body: {
            inputFingerprintSha256: fingerprint,
            targetViewId: 123,
            operations: [{
              action_key: "repair:move-retained-tag",
              observation_ids: ["retained-tag"],
              path: "/revit/move-elements",
              depends_on: [],
              expected_created_min: 0,
              expected_created_max: 0,
              apply_body: {
                ids: [901],
                mode: "vector",
                vectorX: 0.25,
                vectorY: 0,
                vectorZ: 0,
                moveTogether: true
              }
            }],
            provisionalObservationIds: [],
            dryRun: true,
            verify: true,
            maximumCreatedElements: 1
          }
        }]
      };
    },
    anthropicStreamingBrain: async (): Promise<ChatResponse> => {
      providerCalls += 1;
      throw new Error("provider_must_not_run_for_deterministic_stage_continuation");
    }
  };

  try {
    const dryRun = await decide(directRequest(), dependencies);
    assert.equal(providerCalls, 1);
    assert.equal(dryRun.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
    assert.equal((dryRun.actions[0]?.body as Record<string, unknown>)?.dryRun, true);

    const apply = await decide(directRequest([{
      action_id: dryRun.actions[0]!.action_id,
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:repair:move-retained-tag",
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        operationOutputs: [{
          action_key: "repair:move-retained-tag",
          created_element_ids: [],
          affected_element_ids: [901]
        }]
      }
    }]), dependencies);
    assert.equal(providerCalls, 1);
    assert.equal((apply.actions[0]?.body as Record<string, unknown>)?.dryRun, false);

    const streamed: string[] = [];
    const readback = await decideStreaming(directRequest([{
      action_id: apply.actions[0]!.action_id,
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:repair:move-retained-tag",
        status: "Applied",
        dryRun: false,
        atomic: true,
        operationOutputs: [{
          action_key: "repair:move-retained-tag",
          created_element_ids: [],
          affected_element_ids: [901]
        }]
      }
    }]), {
      onDelta: value => streamed.push(value),
      onDone: value => streamed.push(value)
    }, dependencies);
    assert.equal(providerCalls, 1);
    assert.equal(readback.actions[0]?.path, "/revit/get-element-summary");
    assert.deepEqual(
      (readback.actions[0]?.body as Record<string, unknown>)?.elementIds,
      [901]
    );
    assert.ok(streamed.some(value => /reading back every created or affected native ID/i.test(value)));

    const visual = await decide(directRequest([{
      action_id: readback.actions[0]!.action_id,
      method: "POST",
      path: "/revit/get-element-summary",
      status: "done",
      result_json: [{ id: 901, found: true }]
    }]), dependencies);
    assert.equal(providerCalls, 1);
    assert.equal(visual.actions[0]?.path, "/revit/highlight-and-export");

    const checkpoint = await decide(directRequest([{
      action_id: visual.actions[0]!.action_id,
      method: "POST",
      path: "/revit/highlight-and-export",
      status: "done",
      result_json: {
        path: "C:\\evidence\\focused-stage.jpg",
        focusCrop: { requested: true, applied: true },
        elementVisibility: {
          requestedElementIds: [901],
          visibleElementIds: [901],
          notVisibleElementIds: [],
          allRequestedElementsVisible: true
        }
      }
    }]), dependencies);
    assert.equal(providerCalls, 1);
    assert.equal(checkpoint.actions[0]?.path, "/revit/save-as");
  } finally {
    restoreEnvironment(previous);
  }
});
