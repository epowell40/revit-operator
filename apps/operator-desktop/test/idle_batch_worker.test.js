import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackendRevitBatchWorker, normalizeBatchBinding } from "../revit_batch_frontend.js";
const binding = normalizeBatchBinding({ session_id: "session", target_executor_id: "worker", project_fingerprint: "a".repeat(64) });
const store = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "operator-idle-batch-")), "settlements.json");
test("empty, malformed, and failed availability probes never touch Revit or claim a job", async () => {
  for (const response of [false, null, {}, "true", new Error("backend down")]) {
    let native = 0, claims = 0;
    const worker = createBackendRevitBatchWorker({ settlementStorePath: store(),
      hasPendingWork: async () => { if (response instanceof Error) throw response; return response; },
      getBatchBinding: async () => { native++; return binding; }, readBackendJson: async () => { claims++; return { ok: true }; } });
    if (response instanceof Error) await assert.rejects(worker.runOnce(), /backend down/); else await worker.runOnce();
    assert.equal(native, 0); assert.equal(claims, 0);
  }
});
test("availability is only a hint: a job still requires fresh binding, fencing, and the pre-execution check", async () => {
  let native = 0, claims = 0, executions = 0, failed = 0, probes = 0;
  const worker = createBackendRevitBatchWorker({ settlementStorePath: store(), hasPendingWork: async () => ++probes === 1,
    getBatchBinding: async () => ++native === 1 ? binding : normalizeBatchBinding({ ...binding, project_fingerprint: "b".repeat(64), target_context: undefined }),
    readBackendJson: async route => {
      if (route.endsWith("claim-next")) { claims++; return { job: { id: "j", job_type: "delegated_revit_task_batch", session_id: binding.session_id, target_context: binding.target_context }, item: { id: "i" }, claim_token: "fence" }; }
      if (route.endsWith("/fail")) { failed++; return { ok: true }; }
      throw new Error(route);
    }, executeDelegatedWorkItem: async () => { executions++; } });
  await worker.runOnce();
  assert.equal(native, 2); assert.equal(claims, 1); assert.equal(executions, 0); assert.equal(failed, 1);
});
test("foreground work admitted during the availability request prevents a native read", async () => {
  let foreground = false;
  const worker = createBackendRevitBatchWorker({ settlementStorePath: store(), shouldYield: () => foreground,
    hasPendingWork: async () => { foreground = true; return true; },
    getBatchBinding: async () => { throw new Error("Native read competed with foreground"); } });
  await worker.runOnce();
});
