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
import {
  __testOnlyIsExistingConditionsReconstructionRequest,
  prepareExistingConditionsSourcePreflight
} from "../src/brains/openai_brain.js";

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
                        body_json: {
                          startX: 1,
                          startY: 2,
                          startZ: 3,
                          endX: 4,
                          endY: 2,
                          endZ: 3,
                          pipeSize: "2 in",
                          systemType: "Sanitary",
                          dryRun: true
                        }
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
    assert.ok(
      requestedBody.generationConfig.responseJsonSchema.properties.actions.items.properties.body_json.type.includes("object")
    );
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

test("Gemini brain retries a malformed structured decision with a bounded repair prompt", async () => {
  const previous = {
    OPERATOR_GEMINI_API_KEY: process.env.OPERATOR_GEMINI_API_KEY,
    OPERATOR_GEMINI_AGENT_MODEL: process.env.OPERATOR_GEMINI_AGENT_MODEL,
    OPERATOR_GEMINI_AGENT_BASE_URL: process.env.OPERATOR_GEMINI_AGENT_BASE_URL,
    OPERATOR_GEMINI_AGENT_DECISION_ATTEMPTS: process.env.OPERATOR_GEMINI_AGENT_DECISION_ATTEMPTS
  };
  process.env.OPERATOR_GEMINI_API_KEY = "test-gemini-key";
  process.env.OPERATOR_GEMINI_AGENT_MODEL = "gemini-test";
  process.env.OPERATOR_GEMINI_AGENT_BASE_URL = "https://gemini.test/v1beta";
  process.env.OPERATOR_GEMINI_AGENT_DECISION_ATTEMPTS = "2";

  const requestedBodies: any[] = [];
  let callCount = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestedBodies.push(JSON.parse(String(init?.body ?? "{}")));
    callCount += 1;
    const decisionText = callCount === 1
      ? '{"assistant_message":"truncated'
      : JSON.stringify({
          assistant_message: "Registration is preserved; take the next new read once.",
          actions: [{
            action_id: "inventory-next",
            method: "POST",
            path: "/revit/export-visible-elements",
            body_json: { viewId: 123, frameId: "frame-1" }
          }]
        });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: decisionText }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const response = await decideGemini(request(), { fetchImpl });
    assert.equal(callCount, 2);
    assert.equal(response.actions.length, 1);
    assert.equal(response.actions[0]?.action_id, "inventory-next");
    assert.match(
      requestedBodies[1].contents[0].parts[0].text,
      /REPAIR THE PREVIOUS PROVIDER DECISION FORMAT/
    );
    assert.equal(requestedBodies[1].generationConfig.temperature, 0);
  } finally {
    restoreEnvironment(previous);
  }
});

test("external provider prompt rehydrates compacted persisted tool receipts", { concurrency: false }, async () => {
  const previous = {
    OPERATOR_WORKSPACE_ROOT: process.env.OPERATOR_WORKSPACE_ROOT,
    OPERATOR_GEMINI_API_KEY: process.env.OPERATOR_GEMINI_API_KEY,
    OPERATOR_GEMINI_AGENT_MODEL: process.env.OPERATOR_GEMINI_AGENT_MODEL,
    OPERATOR_GEMINI_AGENT_BASE_URL: process.env.OPERATOR_GEMINI_AGENT_BASE_URL
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-provider-capsule-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_GEMINI_API_KEY = "test-gemini-key";
  process.env.OPERATOR_GEMINI_AGENT_MODEL = "gemini-test";
  process.env.OPERATOR_GEMINI_AGENT_BASE_URL = "https://gemini.test/v1beta";
  const req = request("Continue the accepted staged reconstruction without repeating discovery.");
  const sessionDir = path.join(root, "runs", "sessions", req.session_id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const persistedRows = [
    {
      ts: new Date().toISOString(),
      kind: "revit.result",
      session_id: req.session_id,
      tool_result: {
        action_id: "list-fixture-types",
        method: "POST",
        path: "/revit/list-element-types",
        status: "done",
        result_json: {
          count: 1,
          types: [{ id: 4242, name: "Fixture Type A", familyName: "Single Fixture" }]
        }
      }
    },
    {
      ts: new Date().toISOString(),
      kind: "revit.result",
      session_id: req.session_id,
      tool_result: {
        action_id: "search-placement-tool",
        method: "POST",
        path: "/revit/tool-search",
        status: "done",
        result_json: {
          query: "create a family instance",
          returned: 1,
          matches: [{
            method: "POST",
            path: "/revit/create-family-instance",
            title: "Create Family Instance",
            risk: "high",
            description: "x".repeat(20_000)
          }]
        }
      }
    },
    {
      ts: new Date().toISOString(),
      kind: "revit.result",
      session_id: req.session_id,
      tool_result: {
        action_id: "describe-placement-tool",
        method: "POST",
        path: "/revit/tool-doc",
        status: "done",
        result_json: {
          method: "POST",
          path: "/revit/create-family-instance",
          required_fields: ["familyName", "typeName", "x", "y", "z"],
          optional_fields: ["levelName", "count", "dryRun"],
          request_schema: { type: "object" }
        }
      }
    }
  ];
  fs.writeFileSync(
    path.join(sessionDir, "tool_outputs.jsonl"),
    `${persistedRows.map(row => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );

  let prompt = "";
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? "");
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify({ assistant_message: "Continue.", actions: [] }) }]
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await decideGemini(req, { fetchImpl });
    assert.match(prompt, /Persisted accepted observations and repair failures/);
    assert.match(prompt, /4242/);
    assert.match(prompt, /Fixture Type A/);
    assert.match(prompt, /"optional_fields"/);
    assert.match(prompt, /\/revit\/create-family-instance/);
    assert.ok(prompt.length < 45_000);
    assert.match(prompt, /Do not repeat a successful type lookup/);
    assert.ok(prompt.startsWith("AUTHORITATIVE CURRENT USER REQUEST"));
    assert.ok(
      prompt.indexOf(req.user_text ?? "") <
      prompt.indexOf("Persisted accepted observations and repair failures")
    );
    assert.match(prompt, /Final authority check/);
    assert.match(prompt, /Do not replay, resume, or narrate a completed earlier action/);
  } finally {
    restoreEnvironment(previous);
  }
});

test("persisted source preflight restores existing-conditions intent and source render paths after restart", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-rehydrate-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const req = request("Resume the next accepted stage without repeating discovery.");
  const sessionDir = path.join(root, "runs", "sessions", req.session_id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const previewPath = "artifacts/redline/source-room/page_0001.png";
  const rows = [
    {
      kind: "mcp.tool_result",
      tool: "workbench.analyze_redline",
      status: "success",
      result: {
        index: 1,
        summary: "Source analyzed.",
        details: {
          file_path: "artifacts/uploads/source-room.pdf",
          page_count: 1,
          primary_sheet_number: "M2.00",
          vision_artifacts: { preview_image_path: previewPath },
          aec_intent_evidence: {
            target: {
              document: { fingerprint: "a".repeat(64) },
              sheet: { number: "M2.00", id: 10 },
              view: { id: 20, name: "LEVEL 1 - MECHANICAL" }
            }
          }
        }
      }
    },
    {
      kind: "mcp.tool_result",
      tool: "workbench.gemini_redline_analyze",
      status: "success",
      result: {
        index: 2,
        summary: "Structured source analysis completed.",
        details: { model: "gemini-test", global_confidence: 0.9, regions: [] }
      }
    }
  ];
  fs.writeFileSync(
    path.join(sessionDir, "request_log.jsonl"),
    `${JSON.stringify({
      kind: "user.turn",
      session_id: req.session_id,
      user_text: "Reconstruct the existing conditions from the attached source drawing."
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(sessionDir, "tool_outputs.jsonl"),
    `${rows.map(row => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );

  try {
    assert.equal(__testOnlyIsExistingConditionsReconstructionRequest(req), true);
    const hydrated = await prepareExistingConditionsSourcePreflight(req);
    const server = (hydrated.context as any)?.__server;
    assert.equal(server?.workbench_source_preflight_complete, true);
    assert.equal(server?.workbench_structured_image_analysis_complete, true);
    assert.deepEqual(server?.workbench_inline_image_paths, [previewPath]);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
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
    const anthropicBodySchema = requestedBody.output_config.format.schema
      .properties.actions.items.properties.body_json;
    assert.deepEqual(anthropicBodySchema.type, ["string", "null"]);
    assert.equal(anthropicBodySchema.additionalProperties, undefined);
    assert.doesNotMatch(JSON.stringify(requestedBody.output_config.format.schema), /"additionalProperties":true/);
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

test("Claude existing-conditions route completes provider-neutral source preflight before native discovery", { concurrency: false }, async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  process.env.OPERATOR_BRAIN = "claude";
  let preflightCalls = 0;
  let providerCalls = 0;
  const req: ChatRequest = {
    ...request(
      "Start a staged Room 210 existing-conditions reconstruction from the attached M2.00 source. For this turn do source observation and registration only. Do not write to Revit yet."
    ),
    user_attachments: [{
      id: "p210",
      relative_path: "artifacts/uploads/M2.00_room_210.pdf",
      filename: "M2.00_room_210.pdf",
      mime: "application/pdf",
      bytes: 1234,
      sha256: "a".repeat(64)
    }]
  };

  try {
    const response = await decide(req, {
      existingConditionsSourcePreflight: async incoming => {
        preflightCalls += 1;
        return {
          ...incoming,
          context: {
            ...(incoming.context as Record<string, unknown> | undefined),
            __server: {
              workbench_source_preflight_complete: true,
              workbench_structured_image_analysis_complete: true,
              workbench_results: "analyze_redline and gemini_redline_analyze succeeded"
            }
          }
        };
      },
      anthropicBrain: async incoming => {
        providerCalls += 1;
        const server = (incoming.context as any)?.__server;
        assert.equal(server?.workbench_source_preflight_complete, true);
        assert.equal(server?.workbench_structured_image_analysis_complete, true);
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: "Source evidence is registered; verifying the requested native room next.",
          actions: [{
            action_id: "verify-room-210",
            method: "POST",
            path: "/revit/linked-room-boundaries",
            body: { roomNumbers: ["210"] }
          }]
        };
      }
    });

    assert.equal(preflightCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(response.actions.length, 1);
    assert.equal(response.actions[0]?.path, "/revit/linked-room-boundaries");
  } finally {
    restoreEnvironment(previous);
  }
});

test("external providers honor deterministic existing-conditions registration decisions before planner calls", { concurrency: false }, async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  process.env.OPERATOR_BRAIN = "gemini";
  const req = request(
    "Continue the existing-conditions reconstruction from the registered source in exact target view 123."
  );
  let providerCalls = 0;
  let gateCalls = 0;
  const gateResponse: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Exporting the exact frame before source-to-view alignment.",
    actions: [{
      action_id: "exact-frame-123",
      method: "POST",
      path: "/revit/export-view-frame",
      body: { viewId: 123, imageSize: 2200, includeMapping: true }
    }]
  };
  const plannerResponse: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "planner",
    actions: []
  };
  const dependencies = {
    existingConditionsSourcePreflight: async (incoming: ChatRequest) => incoming,
    existingConditionsProviderDecision: async () => {
      gateCalls += 1;
      return gateResponse;
    },
    geminiBrain: async () => {
      providerCalls += 1;
      return plannerResponse;
    },
    geminiStreamingBrain: async () => {
      providerCalls += 1;
      return plannerResponse;
    }
  };

  try {
    const nonStreaming = await decide(req, dependencies);
    const streaming = await decideStreaming(
      { ...req, session_id: `${req.session_id}-stream` },
      {},
      dependencies
    );
    assert.equal(gateCalls, 2);
    assert.equal(providerCalls, 0);
    assert.equal(nonStreaming.actions[0]?.path, "/revit/export-view-frame");
    assert.equal(streaming.actions[0]?.path, "/revit/export-view-frame");
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

test("explicit direct existing-conditions routes retain the provider-neutral registration gate", { concurrency: false }, async () => {
  const previous = { OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  process.env.OPERATOR_BRAIN = "gemini";
  const req: ChatRequest = {
    ...request("Draft the existing conditions from this source in exact target view 123."),
    context: { operator_brain_route: "direct" }
  };
  let gateCalls = 0;
  let providerCalls = 0;
  const gateResponse: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Registering the exact frame before provider planning.",
    actions: [{
      action_id: "direct-frame-123",
      method: "POST",
      path: "/revit/export-view-frame",
      body: { viewId: 123 }
    }]
  };
  const dependencies = {
    existingConditionsSourcePreflight: async (incoming: ChatRequest) => incoming,
    existingConditionsProviderDecision: async () => {
      gateCalls += 1;
      return gateResponse;
    },
    geminiBrain: async () => {
      providerCalls += 1;
      return gateResponse;
    },
    geminiStreamingBrain: async () => {
      providerCalls += 1;
      return gateResponse;
    }
  };

  try {
    const nonStreaming = await decide(req, dependencies);
    const streaming = await decideStreaming(
      { ...req, session_id: `${req.session_id}-stream` },
      {},
      dependencies
    );
    assert.equal(gateCalls, 2);
    assert.equal(providerCalls, 0);
    assert.equal(nonStreaming.actions[0]?.action_id, "direct-frame-123");
    assert.equal(streaming.actions[0]?.action_id, "direct-frame-123");
  } finally {
    restoreEnvironment(previous);
  }
});

test("explicit direct existing-conditions registration is provider-neutral for OpenAI and rule routes", { concurrency: false }, async () => {
  const previous = {
    OPERATOR_BRAIN: process.env.OPERATOR_BRAIN,
    OPERATOR_WORKSPACE_ROOT: process.env.OPERATOR_WORKSPACE_ROOT
  };
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-direct-registration-provider-neutral-"));
  const gateResponse: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Registering the exact frame before provider planning.",
    actions: [{
      action_id: "direct-frame-123",
      method: "POST",
      path: "/revit/export-view-frame",
      body: { viewId: 123 }
    }]
  };

  try {
    for (const configured of ["openai", "rule"] as const) {
      process.env.OPERATOR_BRAIN = configured;
      let gateCalls = 0;
      let providerCalls = 0;
      const baseRequest = request("Register the attached existing-conditions plumbing crop to exact target model view 123.");
      const req: ChatRequest = {
        ...baseRequest,
        session_id: `${baseRequest.session_id}-direct-registration-${configured}`,
        context: { operator_brain_route: "direct" }
      };
      const dependencies = {
        existingConditionsSourcePreflight: async (incoming: ChatRequest) => incoming,
        existingConditionsProviderDecision: async () => {
          gateCalls += 1;
          return gateResponse;
        },
        openAiBrain: async () => {
          providerCalls += 1;
          return gateResponse;
        },
        openAiStreamingBrain: async () => {
          providerCalls += 1;
          return gateResponse;
        },
        ruleBrain: async () => {
          providerCalls += 1;
          return gateResponse;
        }
      };

      const nonStreaming = await decide(req, dependencies);
      const streaming = await decideStreaming(
        { ...req, session_id: `${req.session_id}-stream` },
        {},
        dependencies
      );
      assert.equal(gateCalls, 2);
      assert.equal(providerCalls, 0);
      assert.equal(nonStreaming.actions[0]?.action_id, "direct-frame-123");
      assert.equal(streaming.actions[0]?.action_id, "direct-frame-123");
    }
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
