import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexTurnNotificationObserver } from "../src/brains/codex_turn_notification_observer.js";
import { decideStreaming } from "../src/brain.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

async function isolated(fn: () => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-tool-progress-"));
  const prior = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_BRAIN];
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_BRAIN = "codex";
  try { await fn(); } finally {
    __closeForTests();
    for (const [i, name] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_BRAIN"].entries()) {
      if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("current tool stages replace stale commentary without fabricating completion or accepting foreign events", () => isolated(() => {
  const progress: string[] = [], deltas: string[] = [];
  const observer = createCodexTurnNotificationObserver({ sessionId: "progress", threadId: "thread", turnId: "turn",
    modelTelemetry: { observe() {} }, assignmentObserver: { observe() {} }, freshEvidenceRequirement: { required: false } as any,
    webEvidenceRequirement: { required: false } as any, mcpRuntime: null, onProgress: text => progress.push(text), onDelta: text => deltas.push(text) });
  const emit = (method: string, item: any, turnId = "turn", threadId = "thread") => observer.observe({ method, threadId, params: { turnId, item } } as any);
  emit("item/completed", { type: "agentMessage", phase: "commentary", id: "initial", text: "I will check the spaces." });
  for (const [tool, expected] of [
    ["operator_discover_capabilities", "Finding the right tool…"], ["revit_list_rooms", "Reading model information…"],
    ["operator_retrieve_evidence", "Reviewing the collected information…"],
    ["operator_run_dynamic_revit_program", "Working through the next step…"], ["operator_evaluate_assignment_criteria", "Checking the result…"],
    ["operator_request_assignment_input", "Preparing a question…"]
  ]) {
    for (const type of ["dynamicToolCall", "mcpToolCall"]) {
      emit("item/started", { type, id: tool, tool });
      assert.equal(progress.at(-1), expected);
    }
  }
  for (const [path, expected] of [["/revit/get-parameters", "Reading model information…"],
    ["/revit/export-elements-xlsx", "Preparing the workbook…"], ["/revit/inspect-exported-files", "Checking the exported file…"],
    ["/revit/capture-sheet-region", "Capturing the view…"]]) {
    for (const type of ["dynamicToolCall", "mcpToolCall"]) for (const argumentsValue of [{ path, body: { confidential: "Do not display" } }, JSON.stringify({ path })]) {
      emit("item/started", { type, tool: "revit_call_tool", arguments: argumentsValue });
      assert.equal(progress.at(-1), expected);
    }
  }
  for (const argumentsValue of ["bad JSON", " ".repeat(16_385), { path: "/revit/export-elements-xlsx?secret=value" }, { path: "../export-elements-xlsx" }]) {
    emit("item/started", { type: "dynamicToolCall", tool: "revit_call_tool", arguments: argumentsValue });
    assert.equal(progress.at(-1), "Working through the next step…");
  }
  const count = progress.length;
  emit("item/started", { type: "dynamicToolCall", tool: "write_excel" }, "old-turn");
  emit("item/started", { type: "mcpToolCall", tool: "write_excel" }, "turn", "other-thread");
  assert.equal(progress.length, count);
  emit("item/completed", { type: "dynamicToolCall", id: "failed", tool: "revit_get_parameters", success: false, contentItems: [] });
  assert.equal(progress.at(-1), "Reviewing a tool issue…");
  emit("item/completed", { type: "mcpToolCall", id: "failed-mcp", tool: "revit_get_parameters", status: "failed" });
  assert.equal(progress.at(-1), "Reviewing a tool issue…");
  emit("item/completed", { type: "dynamicToolCall", id: "read", tool: "revit_get_parameters", success: true, contentItems: [] });
  assert.equal(progress.at(-1), "Reviewing the result…");
  assert.deepEqual(deltas, []);
  emit("item/completed", { type: "agentMessage", id: "final", phase: "final_answer", text: "67 spaces were reviewed." });
  assert.equal(observer.snapshot().assistantText, "67 spaces were reviewed.");
  assert.deepEqual(deltas, ["67 spaces were reviewed."]);
}));

test("streaming brain forwards tool progress through both read and buffered mutation callbacks", () => isolated(async () => {
  for (const user_text of ["Review the room parameters for a load workbook. Do not change the model.", "Rename the selected view to HVAC TEST."]) {
    const progress: string[] = [], deltas: string[] = [];
    let called = false;
    await decideStreaming({ version: "operator.backend.v1", session_id: "progress-gate", message_id: user_text, user_text } as any,
      { onProgress: text => progress.push(text), onDelta: text => deltas.push(text) }, {
        codexStreamingBrain: async (_req, callbacks) => {
          called = true;
          const observer = createCodexTurnNotificationObserver({ sessionId: "progress-gate", threadId: "thread", turnId: "turn",
            modelTelemetry: { observe() {} }, assignmentObserver: { observe() {} }, freshEvidenceRequirement: { required: false } as any,
            webEvidenceRequirement: { required: false } as any, mcpRuntime: null, onProgress: callbacks.onProgress, onDelta: callbacks.onDelta });
          observer.observe({ method: "item/started", threadId: "thread", params: { turnId: "turn", item: { type: "dynamicToolCall", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/get-parameters", body: { elementIds: [42] } } } } } as any);
          return { version: "operator.backend.v1", assistant_message: "The requested work needs further verification.", actions: [] } as any;
        }
      });
    assert.equal(called, true); assert.deepEqual(progress, ["Reading model information…"]);
    assert.ok(deltas.every(text => !text.includes("Reading model information")));
  }
}));

test("compaction progress is current-turn descriptive output, deduplicated and owned by the latest real activity", () => isolated(() => {
  const progress: string[] = [], deltas: string[] = [], observations: unknown[] = [];
  const observer = createCodexTurnNotificationObserver({ sessionId: "compaction-progress", threadId: "thread", turnId: "turn",
    modelTelemetry: { observe() {} }, assignmentObserver: { observe(value) { observations.push(value); } },
    freshEvidenceRequirement: { required: true } as any, webEvidenceRequirement: { required: true } as any,
    mcpRuntime: null, onProgress: text => progress.push(text), onDelta: text => deltas.push(text) });
  const emit = (method: string, id: unknown, turnId = "turn", threadId = "thread") => observer.observe({ method, threadId,
    params: { turnId, item: { type: "contextCompaction", id } } } as any);
  const before = observer.snapshot();
  emit("item/started", "foreign", "old"); emit("item/started", "foreign", "turn", "other");
  emit("item/started", ""); emit("item/started", " "); emit("item/started", null);
  emit("item/completed", "completion-only"); emit("item/started", "completion-only");
  assert.deepEqual(progress, []);
  emit("item/started", "a"); emit("item/started", "a");
  assert.deepEqual(progress, ["Organizing task notes…"]);
  emit("item/completed", "a", "old"); emit("item/completed", "unmatched");
  assert.equal(progress.length, 1);
  emit("item/completed", "a"); emit("item/completed", "a"); emit("item/started", "a");
  assert.deepEqual(progress, ["Organizing task notes…", "Continuing the task…"]);
  emit("item/started", "b");
  observer.observe({ method: "item/started", threadId: "thread", params: { turnId: "turn", item: { type: "dynamicToolCall", id: "read", tool: "revit_get_parameters" } } } as any);
  const afterTool = progress.length; emit("item/completed", "b");
  assert.equal(progress.length, afterTool); assert.equal(progress.at(-1), "Reading model information…");
  emit("item/started", "c");
  observer.observe({ method: "item/completed", threadId: "thread", params: { turnId: "turn", item: { type: "agentMessage", id: "comment", phase: "commentary", text: "Checking the remaining details." } } } as any);
  const afterCommentary = progress.length; emit("item/completed", "c");
  assert.equal(progress.length, afterCommentary); assert.equal(progress.at(-1), "Checking the remaining details.");
  emit("item/started", "d"); emit("item/started", "e");
  const afterNewer = progress.length; emit("item/completed", "d");
  assert.equal(progress.length, afterNewer); emit("item/completed", "e");
  assert.equal(progress.at(-1), "Continuing the task…");
  assert.deepEqual(observations, []); assert.deepEqual(deltas, []); assert.deepEqual(observer.snapshot(), before);
}));

test("streaming brain forwards real compaction lifecycle text through read and buffered mutation progress callbacks", () => isolated(async () => {
  for (const user_text of ["Review the room parameters. Do not change the model.", "Rename the selected view to HVAC TEST."]) {
    const progress: string[] = [], deltas: string[] = [];
    const controller = new AbortController();
    await decideStreaming({ version: "operator.backend.v1", session_id: "compaction-delivery", message_id: user_text, user_text } as any,
      { abortSignal: controller.signal, onProgress: text => progress.push(text), onDelta: text => deltas.push(text) }, {
        codexStreamingBrain: async (_req, callbacks) => {
          assert.equal(callbacks.abortSignal, controller.signal);
          const observer = createCodexTurnNotificationObserver({ sessionId: "compaction-delivery", threadId: "thread", turnId: "turn",
            modelTelemetry: { observe() {} }, assignmentObserver: { observe() { assert.fail("Compaction is not native evidence"); } },
            freshEvidenceRequirement: { required: false } as any, webEvidenceRequirement: { required: false } as any,
            mcpRuntime: null, onProgress: callbacks.onProgress, onDelta: callbacks.onDelta });
          for (const method of ["item/started", "item/completed"]) observer.observe({ method, threadId: "thread", params: { turnId: "turn", item: { type: "contextCompaction", id: "compact" } } } as any);
          assert.equal(controller.signal.aborted, false);
          return { version: "operator.backend.v1", assistant_message: "The requested work needs further verification.", actions: [] } as any;
        }
      });
    assert.deepEqual(progress, ["Organizing task notes…", "Continuing the task…"]);
    assert.ok(deltas.every(text => !/Organizing task notes|Continuing the task/.test(text)));
  }
}));
