import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCodexServerRequest } from "../src/brains/codex_brain.js";
import { RevitToolParallelGuard } from "../src/codex/revit_tool_parallel_guard.js";
import { setRevitToolQuarantine } from "../src/codex/revit_tool_contract_memory.js";

const call = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  turnId: "turn-1",
  tool: "revit_call_tool",
  arguments: { method: "POST", path: "/revit/tag-elements", body: { elementIds: [1], dryRun: true } },
  ...overrides
});

test("blocks a duplicate Revit method/path while the first call is active", () => {
  const guard = new RevitToolParallelGuard();
  const first = guard.tryAcquire(call());
  const duplicate = guard.tryAcquire(call({ arguments: JSON.stringify({ method: "post", path: "/REVIT/TAG-ELEMENTS", body: { elementIds: [2] } }) }));

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.match(duplicate.message ?? "", /parallel_revit_call_blocked/);
  first.release();
});

test("permits independent paths and later retries after release", () => {
  const guard = new RevitToolParallelGuard();
  const first = guard.tryAcquire(call());
  const independent = guard.tryAcquire(call({ arguments: { method: "POST", path: "/revit/context" } }));

  assert.equal(independent.accepted, true);
  independent.release();
  first.release();
  assert.equal(guard.tryAcquire(call()).accepted, true);
});

test("scopes active calls by turn and ignores other tools", () => {
  const guard = new RevitToolParallelGuard();
  const first = guard.tryAcquire(call());

  assert.equal(guard.tryAcquire(call({ turnId: "turn-2" })).accepted, true);
  assert.equal(guard.tryAcquire(call({ tool: "revit_list_sheets" })).accepted, true);
  assert.equal(guard.tryAcquire(call({ arguments: { method: "POST", path: "/tools/search" } })).accepted, true);
  first.release();
});

test("app-server handler rejects a duplicate before dispatching it to the MCP runtime", async () => {
  let resolveFirst!: (value: unknown) => void;
  let runtimeCalls = 0;
  const firstResult = new Promise<unknown>(resolve => { resolveFirst = resolve; });
  const runtime = {
    callTool: async () => {
      runtimeCalls += 1;
      return await firstResult;
    }
  };
  const request = {
    method: "item/tool/call",
    params: { namespace: "revit_operator", ...call() }
  };

  const first = handleCodexServerRequest(runtime as any, request as any);
  await Promise.resolve();
  const duplicate = await handleCodexServerRequest(runtime as any, request as any) as any;

  assert.equal(runtimeCalls, 1);
  assert.equal(duplicate.success, false);
  assert.match(duplicate.contentItems[0].text, /parallel_revit_call_blocked/);

  resolveFirst({ content: [{ type: "text", text: "{\"plannedToTag\":1}" }] });
  const completed = await first as any;
  assert.equal(completed.success, true);
});

test("app-server handler blocks an active exact-route quarantine before MCP dispatch", { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-tool-quarantine-handler-"));
  const previous = process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
  process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = path.join(root, "memory.json");
  try {
    setRevitToolQuarantine({
      method: "POST",
      path: "/revit/tag-elements",
      active: true,
      reason: "confirmed test defect"
    });
    let runtimeCalls = 0;
    const runtime = { callTool: async () => { runtimeCalls += 1; return { content: [] }; } };
    const result = await handleCodexServerRequest(runtime as any, {
      method: "item/tool/call",
      params: { namespace: "revit_operator", ...call() }
    } as any) as any;

    assert.equal(runtimeCalls, 0);
    assert.equal(result.success, false);
    assert.match(result.contentItems[0].text, /revit_tool_quarantined/);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH;
    else process.env.OPERATOR_REVIT_TOOL_CONTRACT_MEMORY_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
