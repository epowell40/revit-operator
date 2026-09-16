import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachDynamicObservationContext } from "../src/brains/codex_dynamic_result_adapter.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload } from "../src/evidence/model_context_budget.js";

test("actual dynamic response includes envelope overhead and never restores raw data when every projection is omitted", { concurrency: false }, () => {
  const prior=process.env.OPERATOR_WORKSPACE_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dynamic-response-budget-"));
  process.env.OPERATOR_WORKSPACE_ROOT=root;
  try {
    for(const detailLength of [1400,1700,1850,1900]) for(const requestBytes of [512,4000]) {
      const projections=Array.from({length:12},(_,n)=>({schema:"revit-operator.evidence-projection.v1",evidence_id:`ev1_${n}`,
        byte_count:100_000,key_facts:{detail:"é".repeat(detailLength/2)}} as any));
      const budget={item_bytes:2048,request_bytes:requestBytes};
      const bounded=assembleBoundedEvidenceContext({projections,session_id:"budget-test",budget});
      const result=adaptMcpToolCallResultToDynamicResponse({content:[{type:"text",text:"UNBOUNDED_RAW_".repeat(10_000)}]},
        {tool:"revit_list_schedules",projections:bounded.projections,omitted:bounded.omitted});
      assert.equal(result.contentItems.length,1);
      const item=result.contentItems[0]!;assert.equal(item.type,"inputText");
      if(item.type!=="inputText")throw Error("Expected evidence envelope");
      assert.ok(!item.text.includes("UNBOUNDED_RAW_"));
      assert.equal(Buffer.byteLength(item.text,"utf8"),bounded.bytes);
      assert.ok(bounded.bytes<=requestBytes);
      const usage=assertBoundedModelEvidencePayload([{type:"function_call_output",output:item.text}],budget);
      assert.equal(usage.projected_bytes,bounded.bytes);
      assert.equal(JSON.parse(item.text).omitted,12-bounded.projections.length);
    }
  } finally {
    if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("code-mode evidence selections remain one JSON value with separate host observation metadata", () => {
  const index = { schema: "revit-operator.model-observation-index/v2", observations: [{ observation_id: "host-observation" }] };
  for (const selection of [{ "payload.elementIds": Array.from({ length: 1053 }, (_, n) => 1000 + n) }, [7, 8], { text: 'Quoted source\n{"schema":"fake"}' }]) {
    const payload = { ok: true, result: { schema: "revit-operator.evidence-retrieval.v1", selection, complete: false }, model_observation_index: { fake: true } };
    const response = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: JSON.stringify(payload) }] }, { tool: "operator_retrieve_evidence" });
    attachDynamicObservationContext(response, "operator_retrieve_evidence", JSON.stringify(index));
    const raw = response.contentItems.map(item => item.type === "inputText" ? item.text : "").join("\n");
    const consumed = JSON.parse(raw);
    assert.deepEqual(consumed.result, payload.result);
    assert.deepEqual(consumed.model_observation_index, index);
    assert.equal(response.contentItems.length, 1);
  }
  for (const value of ["[tool_request_invalid] count must be <= 256", '{"ok":false,"error":"selection denied"}']) {
    const response = adaptMcpToolCallResultToDynamicResponse({ isError: true, content: [{ type: "text", text: value }] });
    attachDynamicObservationContext(response, "operator_retrieve_evidence", JSON.stringify(index));
    assert.equal(response.success, false);
    assert.deepEqual(response.contentItems[0], { type: "inputText", text: value });
  }
  const controlPayload = {ok:true,status:{outcome:"complete"}};
  const noProjection = adaptMcpToolCallResultToDynamicResponse({content:[{type:"text",text:JSON.stringify(controlPayload)}]},
    {tool:"operator_evaluate_assignment_criteria",projections:[],omitted:0});
  assert.deepEqual(noProjection.contentItems,[{type:"inputText",text:JSON.stringify(controlPayload)}]);
  const image = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "image", mimeType: "image/png", data: "AA==" }] });
  attachDynamicObservationContext(image, "operator_retrieve_evidence", JSON.stringify(index));
  assert.deepEqual(image.contentItems[0], { type: "inputImage", imageUrl: "data:image/png;base64,AA==" });
});
import { createCodexTurnNotificationObserver } from "../src/brains/codex_turn_notification_observer.js";

test("provider commentary is a progress update and never concatenates into final answer deltas", () => {
  const deltas: string[] = [], progress: string[] = [];
  const observer = createCodexTurnNotificationObserver({sessionId:"phase-test",threadId:"thread",turnId:"turn",
    modelTelemetry:{observe(){}},assignmentObserver:{observe(){}},freshEvidenceRequirement:{required:false,kind:"none"} as any,
    webEvidenceRequirement:{required:false} as any,mcpRuntime:null,onDelta:text=>deltas.push(text),onProgress:text=>progress.push(text)});
  const emit = (method:string,params:any) => observer.observe({method,threadId:"thread",params:{turnId:"turn",...params}} as any);
  emit("item/started",{item:{type:"agentMessage",id:"progress",phase:"commentary"}});
  emit("item/agentMessage/delta",{itemId:"progress",delta:"Reviewing the remaining pages."});
  emit("item/completed",{item:{type:"agentMessage",id:"progress",phase:"commentary",text:"Reviewing the remaining pages."}});
  assert.deepEqual(deltas,[]);assert.deepEqual(progress,["Reviewing the remaining pages."]);
  emit("item/started",{item:{type:"agentMessage",id:"answer",phase:"final_answer"}});
  emit("item/agentMessage/delta",{itemId:"answer",delta:"## Findings\n"});
  emit("item/agentMessage/delta",{turnId:"other",itemId:"answer",delta:"Wrong turn"});
  emit("item/agentMessage/delta",{itemId:"answer",delta:"- Red marks on page 3."});
  emit("item/completed",{item:{type:"agentMessage",id:"answer",phase:"final_answer",text:"## Findings\n- Red marks on page 3."}});
  assert.equal(deltas.join(""),"## Findings\n- Red marks on page 3.");
  assert.equal(observer.snapshot().assistantText,deltas.join(""));
  assert.equal(observer.snapshot().assistantDeltas,deltas.join(""));
});

test("unknown-phase messages wait for authoritative completion and deferred final output stays buffered", () => {
  for(const deferAssistantOutput of [false,true]) {
    const deltas:string[]=[];
    const observer=createCodexTurnNotificationObserver({sessionId:"phase-fallback",threadId:"thread",turnId:"turn",deferAssistantOutput,
      modelTelemetry:{observe(){}},assignmentObserver:{observe(){}},freshEvidenceRequirement:{required:false} as any,webEvidenceRequirement:{required:false} as any,mcpRuntime:null,onDelta:t=>deltas.push(t)});
    observer.observe({method:"item/agentMessage/delta",threadId:"thread",params:{turnId:"turn",itemId:"old",delta:"Old partial"}} as any);
    assert.deepEqual(deltas,[]);
    observer.observe({method:"item/completed",threadId:"thread",params:{turnId:"turn",item:{type:"agentMessage",id:"old",text:"Complete answer"}}} as any);
    assert.deepEqual(deltas,deferAssistantOutput?[]:["Complete answer"]);
    assert.equal(observer.snapshot().assistantText,"Complete answer");
  }
});
import { recordRevitToolOutcome, formatRevitToolContractMemoryForPrompt } from "../src/codex/revit_tool_contract_memory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { __testOnlyResetCodexVersionProbeCache, probeCodexVersion } from "../src/codex/app_server.js";
import { CODEX_APP_SERVER_COMPATIBILITY, evaluateCodexCliVersion, parseCodexCliVersion, resolveCodexExecutable } from "../src/codex/app_server_compatibility.js";
import { adaptDynamicToolCompletedItem, adaptMcpToolCallResultToDynamicResponse, getFreshRevitEvidenceRequirement, getOperatorAgentBaseInstructions, isMissingCodexThreadError, isSuccessfulFreshRevitEvidence } from "../src/brains/codex_brain.js";

test("navigation guidance verifies active state without promoting control receipts to model evidence", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /`revit_activate_view` \(returned ID\), then `revit_get_context` \(verify\)/);
  assert.match(instructions, /Context is control evidence; resultItems require task_result Observations/);
  assert.match(instructions, /For visual review use `revit_capture_sheet_region`; present the name\/number, not internal IDs or raw paths/);
});
import {
  extractCitedHttpUrls,
  fetchCitedAuthoritativeWebEvidence,
  formatAuthoritativeWebEvidenceAppendix,
  getAuthoritativeWebEvidenceRequirement,
  isSuccessfulAuthoritativeWebEvidenceCall
} from "../src/brains/authoritative_web_evidence.js";
import { CodexMcpToolRuntime, EAGER_OPERATOR_MCP_TOOLS, resolveOperatorMcpServerSpec } from "../src/codex/mcp_tool_runtime.js";
import { canonicalizeProtocolJson, resolveOperatorBackendRoot, sortProtocolFiles } from "../src/tools/verify_codex_app_server_protocol.js";

test("dynamic tool enum rejection and successful correction produce reusable redacted guidance", { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-enum-memory-"));
  const previous = process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
  process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = path.join(root, "memory.json");
  try {
    for (const success of [false, true]) {
      const item = adaptDynamicToolCompletedItem({ type: "dynamicToolCall", tool: "revit_call_tool", success,
        arguments: { method: "POST", path: "/revit/create-view", body: { action: "create_floor_plan",
          name: "Confidential project sheet", planType: success ? "engineering" : "private-invalid-value" } },
        contentItems: [{ type: "inputText", text: success ? '{"transaction":{"status":"committed"}}'
          : '{"code":"mcp_request_validation_failed","validation_issues":[{"field_path":"body.planType","expected_type":"enum","expected_constraint":{"allowed_values":["floor","ceiling","engineering","structural"]}}]}' }] });
      assert.ok(item);
      recordRevitToolOutcome({ sessionId: "enum-session", threadId: "enum-thread", tool: item.tool,
        arguments: item.arguments, success: item.success, error: item.error });
    }
    const guidance = formatRevitToolContractMemoryForPrompt();
    assert.match(guidance, /"planType":"engineering"/);
    assert.doesNotMatch(guidance, /Confidential project|private-invalid-value/);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
    else process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical assignment defers provider success deltas until the authoritative final handoff", () => {
  for (const deferAssistantOutput of [false, true]) {
    const deltas: string[] = [];
    const observer = createCodexTurnNotificationObserver({ sessionId: "deferred-output", threadId: "thread", turnId: "turn",
      modelTelemetry: { observe: () => {} }, assignmentObserver: { observe: () => {} }, mcpRuntime: null,
      freshEvidenceRequirement: { required: false } as any, webEvidenceRequirement: { required: false } as any,
      deferAssistantOutput, onDelta: text => deltas.push(text) });
    observer.observe({ threadId: "thread", method: "item/started", params: {
      turnId: "turn", item: { type: "agentMessage", id: "answer", phase: "final_answer" }
    } } as any);
    observer.observe({ threadId: "thread", method: "item/agentMessage/delta", params: {
      turnId: "turn", itemId: "answer", delta: "Created M-COORDINATION COPY."
    } } as any);
    assert.equal(observer.snapshot().assistantDeltas, "Created M-COORDINATION COPY.");
    assert.deepEqual(deltas, deferAssistantOutput ? [] : ["Created M-COORDINATION COPY."]);
  }
});

test("Codex app-server compatibility pins the generated protocol version", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.149.0\n"), "0.149.0");
  const receipt = evaluateCodexCliVersion("codex-cli 0.149.0", {});
  assert.equal(receipt.compatible, true);
  assert.equal(receipt.actual_version, CODEX_APP_SERVER_COMPATIBILITY.codex_cli_version);
  assert.equal(CODEX_APP_SERVER_COMPATIBILITY.generated_typescript.file_count, 781);
  assert.equal(CODEX_APP_SERVER_COMPATIBILITY.generated_json_schema.file_count, 401);
});

test("Codex app-server compatibility rejects drift unless explicitly overridden", () => {
  assert.throws(() => evaluateCodexCliVersion("codex-cli 0.148.0", {}), /pinned to 0\.149\.0/);
  const receipt = evaluateCodexCliVersion("codex-cli 0.148.0", { OPERATOR_CODEX_ALLOW_UNPINNED: "1" });
  assert.equal(receipt.compatible, false);
  assert.equal(receipt.override_used, true);
});

test("Codex protocol receipts use platform-independent ordinal path ordering", () => {
  const root = path.resolve("protocol-root");
  const files = [path.join(root, "a.json"), path.join(root, "B.json"), path.join(root, "nested", "c.json")];
  assert.deepEqual(sortProtocolFiles(root, files).map(file => path.relative(root, file).replace(/\\/g, "/")), [
    "B.json",
    "a.json",
    "nested/c.json"
  ]);
});

test("Codex protocol receipts canonicalize JSON object order without changing array order", () => {
  assert.equal(JSON.stringify(canonicalizeProtocolJson({ z: 1, a: { d: 2, b: 3 }, list: [{ y: 2, x: 1 }] })),
    '{"a":{"b":3,"d":2},"list":[{"x":1,"y":2}],"z":1}');
});

test("Codex protocol snapshot resolves the backend root from source and compiled layouts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-backend-root-"));
  const backendRoot = path.join(root, "operator-backend");
  try {
    fs.mkdirSync(path.join(backendRoot, "src", "codex"), { recursive: true });
    fs.writeFileSync(path.join(backendRoot, "package.json"), "{}\n", "utf8");
    assert.equal(resolveOperatorBackendRoot(path.join(backendRoot, "src", "tools")), backendRoot);
    assert.equal(resolveOperatorBackendRoot(path.join(backendRoot, "dist", "src", "tools")), backendRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex executable resolution preserves explicit non-shim binaries", () => {
  assert.equal(resolveCodexExecutable("/opt/revitoperator/bin/codex", "linux", {}), "/opt/revitoperator/bin/codex");
  assert.equal(resolveCodexExecutable("C:\\tools\\codex-custom.exe", "win32", {}), "C:\\tools\\codex-custom.exe");
});

test("backend restart recovery recognizes a stale Codex app-server thread", () => {
  assert.equal(isMissingCodexThreadError(new Error("thread not found: thread_123")), true);
  assert.equal(isMissingCodexThreadError(new Error("transport closed")), false);
  assert.equal(isMissingCodexThreadError(new Error("unknown thread thread_456")), true);
  assert.equal(isMissingCodexThreadError(new Error("no rollout found for thread_789")), true);
});

test("Codex executable resolution supports npm's hoisted Windows platform package", () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "operator-codex-appdata-"));
  try {
    const native = path.join(appData, "npm", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, "fixture");
    assert.equal(resolveCodexExecutable("codex", "win32", { APPDATA: appData }), native);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("Codex app-server launch uses the configured binary, strict config, and an observable receipt", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src", "codex", "app_server.ts"), "utf8");
  assert.match(source, /OPERATOR_CODEX_BIN/);
  assert.match(source, /"app-server", "--strict-config"/);
  assert.match(source, /getCompatibilityReceipt/);
  assert.match(source, /probeCodexVersion/);
  assert.match(source, /notify\("initialized"/);
  assert.match(source, /handleServerRequest/);
});

test("Codex version probing retries a timed-out cold start and caches the successful result", async () => {
  __testOnlyResetCodexVersionProbeCache();
  let spawnCount = 0;
  const spawnProcess = (() => {
    spawnCount += 1;
    const proc = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      queueMicrotask(() => proc.emit("exit", null, "SIGKILL"));
      return true;
    };
    if (spawnCount > 1) {
      queueMicrotask(() => {
        proc.stdout.write("codex-cli 0.149.0\n");
        proc.emit("exit", 0, null);
      });
    }
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;

  const options = { timeoutMs: 100, retryDelayMs: 0, maxAttempts: 2, spawnProcess };
  assert.equal(await probeCodexVersion("codex-test", "/workspace", { PATH: "/fixture" }, options), "codex-cli 0.149.0");
  assert.equal(spawnCount, 2);
  assert.equal(await probeCodexVersion("codex-test", "/workspace", { PATH: "/fixture" }, options), "codex-cli 0.149.0");
  assert.equal(spawnCount, 2);
  __testOnlyResetCodexVersionProbeCache();
});

test("MCP results adapt to app-server dynamic tool responses without losing errors or images", () => {
  assert.deepEqual(adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: "ok" }] }), {
    contentItems: [{ type: "inputText", text: "ok" }],
    success: true
  });
  assert.deepEqual(adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "image", mimeType: "image/png", data: "AA==" }], isError: true }), {
    contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,AA==" }],
    success: false
  });
  const boundedVisuals = adaptMcpToolCallResultToDynamicResponse({
    content: Array.from({ length: 5 }, (_, index) => ({ type: "image", mimeType: "image/png", data: Buffer.from(`${index}`).toString("base64") }))
  });
  assert.equal(boundedVisuals.contentItems.filter(item => item.type === "inputImage").length, 3);
  const projected = adaptMcpToolCallResultToDynamicResponse({
    content: [{ type: "resource", raw: "x".repeat(100_000) }, { type: "image", mimeType: "image/png", data: "AA==" }]
  }, {
    projections: [{ schema: "revit-operator.evidence-projection.v1", evidence_id: "ev1_fixture", content_hash: "sha256:fixture", byte_count: 100_000 } as any]
  });
  assert.equal(projected.contentItems.length, 2);
  assert.equal(JSON.stringify(projected.contentItems).includes("x".repeat(100)), false);
});

test("focused evidence retrieval returns its bounded selection instead of another evidence projection", () => {
  const selected = {
    schema: "revit-operator.evidence-retrieval.v1",
    evidence_ref: { evidence_id: "ev1_source" },
    selection: {
      "payload.items": [{ elementId: 1421361, text: "***An Autodesk Revit sample project***\r" }]
    },
    returned_bytes: 128,
    complete: false
  };
  const response = adaptMcpToolCallResultToDynamicResponse({
    content: [{ type: "text", text: JSON.stringify(selected) }]
  }, {
    tool: "operator_retrieve_evidence",
    arguments: { evidenceId: "ev1_source", fields: ["payload.items"], maxBytes: 8_192 },
    projections: [{
      schema: "revit-operator.evidence-projection.v1",
      evidence_id: "ev1_retrieval_result",
      content_hash: "sha256:retrieval-result",
      byte_count: 512
    } as any]
  });

  assert.equal(response.success, true);
  assert.equal(response.contentItems.length, 1);
  assert.deepEqual(JSON.parse((response.contentItems[0] as { text: string }).text), selected);
  assert.equal((response.contentItems[0] as { text: string }).text.includes("ev1_retrieval_result"), false);
});

test("app-server dynamic Revit parameter reads are compacted before returning to Codex", () => {
  const items = Array.from({ length: 500 }, (_, index) => ({
    id: 4000 + index,
    name: `Panel ${index}`,
    category: "Electrical Equipment",
    parameterDetails: [{ name: "Panel Name", value: `B2-G-${index}`, storageType: "String", isReadOnly: false }]
  }));
  const response = adaptMcpToolCallResultToDynamicResponse(
    { content: [{ type: "text", text: JSON.stringify({
      selector: "allModelInstances",
      valueContains: "-G-",
      caseSensitive: true,
      totalScanned: 368985,
      totalMatched: 1734,
      returnedCount: 500,
      offset: 0,
      hasMore: true,
      nextOffset: 500,
      items
    }) }] },
    { tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/get-parameters", body: { valueContains: "-G-" } } }
  );
  const compacted = JSON.parse((response.contentItems[0] as { text: string }).text);
  assert.equal(compacted._compacted, true);
  assert.equal(compacted.compaction, "parameter-evidence-summary");
  assert.equal(compacted.totalMatched, 1734);
  assert.equal(compacted.hasMore, true);
  assert.equal(compacted.nextOffset, 500);
  assert.equal(compacted.matchingElementIds.length, 64);
  assert.equal(compacted.matchingElementIdsOmitted, 436);
  assert.equal(compacted.evidenceSample.length, 16);
  assert.equal((response.contentItems[0] as { text: string }).text.includes("Panel 499"), false);
});

test("parameter read rejection keeps its correction contract even beside evidence projections", () => {
  for (const error of [
    { error: "invalid_tool_input", issues: [{ path: "body.elementId", expected: "number", actual: "missing" }] },
    { code: "tool_input_schema_invalid", required: ["elementId"], rejected: ["elementIds", "parameterNames"] }
  ]) {
    const response = adaptMcpToolCallResultToDynamicResponse({ isError: true,
      content: [{ type: "text", text: JSON.stringify(error) }] }, {
      tool: "revit_call_tool", arguments: { path: "/revit/get-parameters", body: { elementIds: [1380354], parameterNames: ["Comments"] } },
      projections: [{ evidence_id: "ev1_error_projection" } as any]
    });
    assert.equal(response.success, false);
    assert.ok(response.contentItems.some(item => item.type === "inputText" && item.text === JSON.stringify(error)));
    assert.equal(JSON.stringify(response).includes("parameter-evidence-summary"), false);
    const structured = adaptMcpToolCallResultToDynamicResponse({ isError: true, structuredContent: error },
      { tool: "revit_call_tool", arguments: { path: "/revit/get-parameters" } });
    assert.deepEqual(JSON.parse((structured.contentItems[0] as { text: string }).text), error);
  }
});

test("app-server preserves bounded explicit sheet parameter evidence in one compact response", () => {
  const elementIds = Array.from({ length: 17 }, (_, index) => 1400000 + index);
  const names = ["Sheet Number", "Sheet Group", "Discipline", "Drawn By", "Checked By"];
  const response = adaptMcpToolCallResultToDynamicResponse(
    { content: [{ type: "text", text: JSON.stringify({
      selector: "elementIds",
      totalMatched: 17,
      returnedCount: 17,
      hasMore: false,
      items: elementIds.map((id, index) => ({
        id,
        name: `M${String(index).padStart(3, "0")}`,
        category: "Sheets",
        parameterDetails: names.map((name) => ({
          name,
          value: name === "Checked By" && index === 16 ? "" : `${name}-${index}`,
          storageType: "String",
          isReadOnly: false
        }))
      }))
    }) }] },
    { tool: "revit_call_tool", arguments: {
      method: "POST",
      path: "/revit/get-parameters",
      body: { elementIds, names, includeEmpty: true }
    } }
  );
  const compacted = JSON.parse((response.contentItems[0] as { text: string }).text);
  assert.deepEqual(compacted.requestedParameterNames, names);
  assert.equal(compacted.evidenceSample.length, 85);
  assert.equal(compacted.evidenceOmitted, 0);
  assert.equal(compacted.evidenceSample.at(-1).elementId, elementIds.at(-1));
  assert.equal(compacted.evidenceSample.at(-1).parameterName, "Checked By");
  assert.equal(compacted.evidenceSample.at(-1).value, "");
});

test("completed dynamic tool items retain exact tool arguments, output, and failures for journaling", () => {
  assert.deepEqual(adaptDynamicToolCompletedItem({
    type: "dynamicToolCall",
    namespace: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count" },
    status: "completed",
    contentItems: [{ type: "inputText", text: "{\"totalSheets\":345}" }],
    success: true,
    durationMs: 42
  }), {
    server: "revit_operator",
    tool: "revit_list_sheets",
    status: "completed",
    arguments: { action: "count" },
    duration_ms: 42,
    result: [{ type: "inputText", text: "{\"totalSheets\":345}" }],
    error: null,
    success: true
  });
  assert.equal(adaptDynamicToolCompletedItem({
    type: "dynamicToolCall",
    tool: "revit_ping",
    status: "failed",
    contentItems: [{ type: "inputText", text: "bridge unavailable" }],
    success: false
  })?.error, "bridge unavailable");
});

test("Codex instructions route exact sheet totals through the typed sheet counter", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Sheet-count rule/);
  assert.match(instructions, /revit_list_sheets/);
  assert.match(instructions, /action:\"count\"/);
  assert.match(instructions, /Do not infer sheet totals/);
  assert.match(instructions, /Schedule-row edit rule/);
  assert.match(instructions, /revit_update_schedule_cell/);
});

test("Codex PDF instructions keep default output under the Operator workspace without blind export retries", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /perform the authorized export or driver print with dryRun=false/);
  assert.match(instructions, /user's destination or the default workspace-relative artifacts\/prints folder/);
  assert.match(instructions, /never invent an OS temp\/test-run directory/);
  assert.match(instructions, /Do not re-export to verify or retry a failed print\/export with unknown effects/);
  assert.match(instructions, /inspect and reconcile the existing attempt first/);
});

test("Codex instructions diagnose cross-floor visibility beyond view depth", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /View-visibility diagnosis rule/);
  assert.match(instructions, /exact PlanViewRange planes/);
  assert.match(instructions, /Underlay base\/top\/orientation/);
  assert.match(instructions, /applied view template/);
  assert.match(instructions, /Never attribute below-floor visibility to View Depth alone/);
});

test("Codex instructions use bounded bulk sheet parameter readback and target-aware exception verification", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Sheet\/titleblock parameter reads and verification must preserve sheet identity/);
  assert.match(instructions, /For one sheet, call `revit_verify_parameter_on_sheet` directly/);
  assert.match(instructions, /For two or more sheets[\s\S]*one bounded `revit_get_parameters` call/);
  assert.match(instructions, /do not fan out one call per sheet or parameter/);
  assert.match(instructions, /only for bulk rows that are missing or ambiguous/);
});

test("core Revit lifecycle recovery is available before deferred capability discovery", () => {
  assert.equal(EAGER_OPERATOR_MCP_TOOLS.has("revit_open_model"), true);
});

test("common sheet navigation exposes the complete typed sequence before discovery", () => {
  const instructions = getOperatorAgentBaseInstructions();
  for (const tool of ["revit_list_sheets", "revit_activate_view", "revit_get_context", "revit_capture_sheet_region"]) {
    assert.equal(EAGER_OPERATOR_MCP_TOOLS.has(tool), true, tool);
    assert.ok(instructions.includes(`\`${tool}\``), tool);
  }
  assert.equal(EAGER_OPERATOR_MCP_TOOLS.has("revit_delete_elements"), false);
  assert.match(instructions, /Do not search or record a separate strategy/);
  assert.match(instructions, /then `revit_get_context` \(verify\)/);
  assert.match(instructions, /For visual review use `revit_capture_sheet_region`/);
});

test("MCP namespace presents navigation schemas eagerly and leaves unrelated tools deferred", async () => {
  const names = ["revit_list_sheets", "revit_activate_view", "revit_get_context", "revit_capture_sheet_region", "revit_delete_elements"];
  const tools = names.map(name => ({name, description: `Native contract for ${name}`,
    inputSchema: {type: "object", properties: {target: {type: "string"}}, additionalProperties: false}}));
  let listings = 0;
  const runtime = new CodexMcpToolRuntime({backendCwd: process.cwd(), workspaceRoot: process.cwd(), codexHome: process.cwd(), spawnEnv: {}});
  (runtime as any).client = {listTools: async () => {listings += 1; return {tools};}, close: async () => {}};
  try {
    const namespace = await runtime.getDynamicToolNamespace();
    for (const source of tools) {
      const delivered = namespace.tools.find((tool: any) => tool.name === source.name);
      assert.deepEqual(delivered.inputSchema, source.inputSchema);
      assert.equal(delivered.description, source.description);
      assert.equal(delivered.deferLoading, source.name === "revit_delete_elements");
    }
    assert.equal(await runtime.getDynamicToolNamespace(), namespace);
    assert.equal(listings, 1);
  } finally {runtime.stop();}
});

test("Codex file delivery instructions match artifact authority and allow supporting verification recovery", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Read-only retained-evidence retrieval, tool search, or documentation may support that verification/);
  assert.match(instructions, /those helpers cannot verify the edit themselves/);
  assert.match(instructions, /separate POST \/revit\/inspect-exported-files/);
  assert.match(instructions, /print_settings_restored=true/);
  assert.match(instructions, /byte sizes and SHA256 hashes/);
  assert.match(instructions, /Do not re-export to verify or retry a failed print\/export with unknown effects/);
  assert.doesNotMatch(instructions, /verify the returned `verification\.exists`/);
  assert.doesNotMatch(instructions, /Do not search for tools, request tool docs/);
});

test("Codex instructions reuse known primitives before capability discovery", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /reuse an exact primitive/i);
  assert.match(instructions, /Call `operator_discover_capabilities` only when/i);
  assert.match(instructions, /session-cached/i);
  assert.match(instructions, /document\/model results are never satisfied from that cache/i);
  assert.match(instructions, /very next Revit action must be a target-bound readback/i);
  assert.match(instructions, /do not repeat synonymous searches/i);
  assert.match(instructions, /Authoritative complete inventory: cite counts, evaluate the bound criteria from retained observations, and do not recount/i);
  assert.doesNotMatch(instructions, /call `operator_discover_capabilities` first/i);
});

test("Codex instructions keep negative searches scoped and require physical MEP serving connections", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Negative-result scope rule/);
  assert.match(instructions, /category-agnostic identity discovery/);
  assert.match(instructions, /no `category`\/`categories`/);
  assert.match(instructions, /MEP serving-connection precondition/);
  assert.match(instructions, /nearest pipe\/duct is not the serving system/);
  assert.match(instructions, /Do not request a write grant until connectivity/);
});

test("Codex instructions investigate duplicates with spatial and network evidence", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Duplicate-element investigation rule/);
  assert.match(instructions, /do not rule duplicates out when those checks return zero/);
  assert.match(instructions, /generic noun such as `device`, `equipment`, or `object` does not ground one Revit category/);
  assert.match(instructions, /HVAC device discovery normally considers Air Terminals, Mechanical Equipment, and Duct Accessories before Duct Fittings/);
  assert.match(instructions, /project-scope `\/revit\/find-elements` inventory/);
  assert.match(instructions, /`includeGeometry:true`/);
  assert.match(instructions, /Every document-scope `\/revit\/find-elements` request must include a real/);
  assert.match(instructions, /`limit` alone is not a bounded predicate/);
  assert.match(instructions, /never send placeholder or sentinel values such as `__none__`/);
  assert.match(instructions, /omit the category field and use real `identityTerms`/);
  assert.match(instructions, /user-facing aliases such as `air terminals` are accepted/);
  assert.match(instructions, /Honor `itemsComplete`, `hasMore`, continuation\/offset, and truncation metadata/);
  assert.match(instructions, /do not export every view before trying this complete inventory/);
  assert.match(instructions, /`spatialDuplicateCandidates`/);
  assert.match(instructions, /unique Marks are not duplicate-instance proof/);
  assert.match(instructions, /creation-adjacency triage signal, never as duplicate proof/);
  assert.match(instructions, /same-category and same-family\/type instances/);
  assert.match(instructions, /overlapping bounding-box footprints or insertion-point\/center separation relative to element size/);
  assert.match(instructions, /Compare host, level, facing\/hand orientation, parameters, and connector\/network relationships/);
  assert.match(instructions, /opposite-facing peers on different connector ports may be intentional/);
  assert.match(instructions, /Immediate `\/revit\/get-connectors` references establish only one-hop edges/);
  assert.match(instructions, /trace the highest-ranked pair's connected system with `\/revit\/trace-connected-network`/);
  assert.match(instructions, /resolve room or space context with a bounded element, placement, or room read/);
  assert.match(instructions, /label the highest-ranked defensible pair as plausible rather than certain/);
  assert.match(instructions, /predicted post-delete network count/);
  assert.match(instructions, /rollback\/dry-run delete/);
});

test("Codex instructions require an executable create operation for a new-view preview", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /New-view preview truth/);
  assert.match(instructions, /resolving a source view, rooms, crop bounds, or geometry is discovery only/);
  assert.match(instructions, /`\/revit\/transaction-plan` with `duplicateView` or `createDependentView`/);
  assert.match(instructions, /crop-computation or MEP-workflow receipt alone does not preview/);
});

test("fresh Revit evidence contracts reject stale or unrelated sheet-count claims", () => {
  const requirement = getFreshRevitEvidenceRequirement("How many sheets are in the model?");
  assert.equal(requirement.kind, "sheet_count");
  assert.match(requirement.prompt, /Do not answer from memory/);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_tool_registry",
    arguments: {},
    success: true,
    status: "completed"
  }), false);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count", exact: true },
    success: true,
    status: "completed"
  }), true);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit-operator",
    tool: "revit_call_tool",
    arguments: { path: "/revit/sheets", body: { action: "count", exact: true } },
    status: "success"
  }), true);
  assert.equal(isSuccessfulFreshRevitEvidence(requirement, {
    server: "revit_operator",
    tool: "revit_list_sheets",
    arguments: { action: "count" },
    success: false,
    status: "failed",
    error: "bridge unavailable"
  }), false);
});

test("fresh Revit evidence is required for live-model work but not conceptual help", () => {
  assert.equal(getFreshRevitEvidenceRequirement("List the equipment in the active model").kind, "revit_tool");
  const topology = getFreshRevitEvidenceRequirement(
    "Identify one clearly missing unit branch and the analogous neighboring branch, then preview copying its topology, system, level, size, and fittings to the target. Do not create anything."
  );
  assert.equal(topology.required, true);
  assert.equal(topology.kind, "revit_tool");
  assert.equal(getFreshRevitEvidenceRequirement("What is a Revit sheet?").required, false);
});

test("authoritative external research is host-gated on successful fetched evidence", async () => {
  const requirement = getAuthoritativeWebEvidenceRequirement(
    "Research the authoritative Revit 2026 API change and use the current official documentation."
  );
  assert.equal(requirement.required, true);
  assert.match(requirement.prompt, /remembered citation is not evidence/i);
  assert.equal(getAuthoritativeWebEvidenceRequirement("Count the air terminals in this model.").required, false);
  assert.deepEqual(extractCitedHttpUrls(
    "See [official docs](https://help.autodesk.com/cloudhelp/2026/example.htm). Duplicate https://help.autodesk.com/cloudhelp/2026/example.htm"
  ), ["https://help.autodesk.com/cloudhelp/2026/example.htm"]);
  assert.equal(isSuccessfulAuthoritativeWebEvidenceCall({
    tool: "web_fetch_evidence",
    status: "completed"
  }), true);
  assert.equal(isSuccessfulAuthoritativeWebEvidenceCall({
    tool: "revit_call_tool",
    status: "completed"
  }), false);

  const calls: Array<{ tool: string; args: unknown }> = [];
  const attempts = await fetchCitedAuthoritativeWebEvidence({
    async callTool(tool, args) {
      calls.push({ tool, args });
      return {
        content: [{
          type: "text",
          text: "Source: Autodesk Revit 2026 API\nURL: https://help.autodesk.com/cloudhelp/2026/example.htm\nEvidence folder: evidence/web/2026-08-20/id\nExtracted text: evidence/web/2026-08-20/id/extracted.txt"
        }]
      };
    }
  }, "Use https://help.autodesk.com/cloudhelp/2026/example.htm for the migration.");
  assert.deepEqual(calls, [{
    tool: "web_fetch_evidence",
    args: { url: "https://help.autodesk.com/cloudhelp/2026/example.htm" }
  }]);
  assert.equal(attempts[0]?.success, true);
  assert.match(formatAuthoritativeWebEvidenceAppendix(attempts), /Preserved primary-source evidence/);
  assert.match(formatAuthoritativeWebEvidenceAppendix(attempts), /extracted\.txt/);
});

test("Codex instructions require exhaustive live connector and topology evidence", () => {
  const instructions = getOperatorAgentBaseInstructions();
  assert.match(instructions, /Exhaustive MEP connector rule/);
  assert.match(instructions, /at most 5,000 IDs per call/);
  assert.match(instructions, /scan every returned element ID.*not a sample/);
  assert.match(instructions, /onlyOpenPhysicalConnectors:true/);
  assert.match(instructions, /Reconcile inventory\/requested\/scanned totals/);
  assert.match(instructions, /zero failed or truncated rows/);
  assert.match(instructions, /Live topology truth rule/);
  assert.match(instructions, /successful same-turn Revit reads over a bounded complete cohort/);
});

test("backend MCP adapter resolves the sibling built server", () => {
  const spec = resolveOperatorMcpServerSpec(process.cwd());
  assert.equal(path.basename(spec.serverJs), "server.js");
  assert.equal(fs.existsSync(spec.serverJs), true);
});

test("V2 turn-stop requests survive handler registration order and clear at the turn boundary", () => {
  const runtime = new CodexMcpToolRuntime({
    backendCwd: process.cwd(),
    workspaceRoot: process.cwd(),
    codexHome: process.cwd(),
    spawnEnv: {}
  });
  const reasons: string[] = [];
  runtime.requestAssignmentKernelV2TurnStop("turn-before-bind", "criteria_complete");
  runtime.bindAssignmentKernelV2TurnStop("turn-before-bind", reason => reasons.push(reason));
  assert.deepEqual(reasons, ["criteria_complete"]);
  runtime.clearAssignmentKernelV2TurnStop("turn-before-bind");
  runtime.requestAssignmentKernelV2TurnStop("turn-before-bind", "stale");
  assert.deepEqual(reasons, ["criteria_complete"]);
  runtime.stop();
});

test("V2 terminal stop waits until the completed dynamic tool result is observable", () => {
  const runtime = new CodexMcpToolRuntime({
    backendCwd: process.cwd(),
    workspaceRoot: process.cwd(),
    codexHome: process.cwd(),
    spawnEnv: {}
  });
  const reasons: string[] = [];
  runtime.bindAssignmentKernelV2TurnStop("terminal-tool-turn", reason => reasons.push(reason));
  runtime.queueAssignmentKernelV2TurnStop("terminal-tool-turn", "criterion_observations_evaluated");
  assert.deepEqual(reasons, [], "settlement must not interrupt before Codex records the successful tool result");
  runtime.flushAssignmentKernelV2TurnStop("terminal-tool-turn");
  assert.deepEqual(reasons, ["criterion_observations_evaluated"]);
  runtime.flushAssignmentKernelV2TurnStop("terminal-tool-turn");
  assert.deepEqual(reasons, ["criterion_observations_evaluated"], "duplicate completion notifications are idempotent");
  runtime.clearAssignmentKernelV2TurnStop("terminal-tool-turn");

  const lateReasons: string[] = [];
  runtime.queueAssignmentKernelV2TurnStop("queued-before-bind", "criterion_observations_evaluated");
  runtime.bindAssignmentKernelV2TurnStop("queued-before-bind", reason => lateReasons.push(reason));
  assert.deepEqual(lateReasons, [],
    "handler registration must not bypass the completed-tool boundary");
  runtime.flushAssignmentKernelV2TurnStop("queued-before-bind");
  assert.deepEqual(lateReasons, ["criterion_observations_evaluated"]);
  runtime.clearAssignmentKernelV2TurnStop("queued-before-bind");
  runtime.stop();
});
