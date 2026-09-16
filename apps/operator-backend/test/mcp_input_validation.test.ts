import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpInputValidator } from "../src/codex/mcp_input_validation.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";

const dynamicTools = [{ name: "operator_run_dynamic_revit_program", inputSchema: {
  type: "object", required: ["source", "mode"], additionalProperties: false,
  properties: { source: { type: "string", minLength: 1 }, mode: { enum: ["read", "preview", "apply"] },
    worker_deadline_ms: { type: "integer", minimum: 1000, maximum: 30000 },
    apply_deadline_ms: { type: "integer", minimum: 100, maximum: 5000 },
    category: { type: "string", pattern: "^OST_[A-Za-z0-9_]{1,120}$" } }
} }];

test("advertised MCP bounds reject the live invalid deadlines before accepting corrected arguments", () => {
  const validator = new McpInputValidator();
  const args = { source: "public class Program {}", mode: "apply", worker_deadline_ms: 120000, apply_deadline_ms: 120000 };
  assert.throws(() => validator.validate(dynamicTools[0]!.name, args, dynamicTools),
    error => error instanceof Error && /worker_deadline_ms/.test(error.message) && /apply_deadline_ms/.test(error.message));
  validator.validate(dynamicTools[0]!.name, { ...args, worker_deadline_ms: 30000, apply_deadline_ms: 5000 }, dynamicTools);
  assert.equal(args.worker_deadline_ms, 120000, "validation must not coerce or mutate the provider's input");
});

test("runtime preflight consumes the real MCP advertised schema without dispatching a program", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-mcp-schema-"));
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: root, codexHome: root,
    spawnEnv: { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" } });
  try {
    await assert.rejects(runtime.validateToolArguments("operator_run_dynamic_revit_program", {
      mode: "apply", source: "public class Program {}", worker_deadline_ms: 120000, apply_deadline_ms: 120000
    }), /no tool was dispatched/);
    await runtime.validateToolArguments("operator_run_dynamic_revit_program", {
      mode: "apply", source: "public class Program {}", worker_deadline_ms: 30000, apply_deadline_ms: 5000
    });
    assert.equal(fs.existsSync(path.join(root, "artifacts/dynamic-runtime-runs")), false);
  } finally { runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("MCP preflight handles required fields, categories, unknown tools and runtime schema refresh", () => {
  const validator = new McpInputValidator();
  for (const args of [{}, { source: "", mode: "read" }, { source: "x", mode: "apply", category: "ducts" }])
    assert.throws(() => validator.validate(dynamicTools[0]!.name, args, dynamicTools), /no tool was dispatched/);
  assert.throws(() => validator.validate("not-advertised", {}, dynamicTools), /not advertised/);
  validator.clear();
  assert.throws(() => validator.validate(dynamicTools[0]!.name, { source: "x", mode: "apply" }, [
    { name: dynamicTools[0]!.name, inputSchema: { type: "object", required: ["new_runtime_field"] } }
  ]), /new_runtime_field/);
});
