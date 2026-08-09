import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDynamicRevitProgram } from "./dynamicRevitProgramRunner.js";

test("dynamic runner is local-only, bounded, and preserves receipts while redacting trusted paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-runner-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const result = await runDynamicRevitProgram({ source: "public class Program {}", mode: "apply" }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, taskDirectory: "secret-task", runtimeImageDirectory: "secret-runtime", applyReceipt: "receipt" }));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    assert.equal(result.execution_ok, true); assert.equal((result.evidence as any).taskDirectory, "opaque:trusted-task");
    assert.equal((result.evidence as any).applyReceipt, "receipt");
    await assert.rejects(() => runDynamicRevitProgram({ source: "x", mode: "preview" }, { ...env, REVIT_OPERATOR_MODE: "production" }), /unavailable/);
    await assert.rejects(() => runDynamicRevitProgram({ source: "x".repeat(200_001), mode: "preview" }, env), /200,000/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
