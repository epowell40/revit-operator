import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { decideCodexStreaming, warmCodexAppServer } from "../src/brains/codex_brain.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { assignmentKernelTerminalSettlementDeferredV2 } from "../src/assignments/assignment_kernel_v2_terminal_barrier.js";
import { activeProviderTurnForBinding } from "../src/codex/active_turns.js";
import { __closeForTests, recentCommandEvents } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import type { AssignmentBindingV2 } from "../src/domain/assignment-kernel/index.js";

test("actual Codex brain catches typed quota, records hold before cleanup and returns failed usage without replay", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-brain-usage-"));
  const workspace = path.join(root, "workspace"), fakeHome = path.join(root, "fake-home");
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-token-never-authenticated" } }));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(here, "fixtures/codex_app_server_fixture.js"), path.join(here, "../../test/fixtures/codex_app_server_fixture.js")].find(file => fs.existsSync(file));
  assert.ok(fixture);
  const envNames = ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_BRAIN", "OPERATOR_REVIT_TRANSPORT", "OPERATOR_ASSIGNMENT_KERNEL_V2", "OPERATOR_THIN_REFERENCE_SESSION_IDS", "REVIT_OPERATOR_MODE"];
  const prior = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OPERATOR_WORKSPACE_ROOT: workspace, OPERATOR_BRAIN: "codex", OPERATOR_REVIT_TRANSPORT: "courier",
    OPERATOR_ASSIGNMENT_KERNEL_V2: "1", OPERATOR_THIN_REFERENCE_SESSION_IDS: "", REVIT_OPERATOR_MODE: "development" });
  // These mocks only isolate external process selection, fake auth home and MCP/network boundaries.
  // Real brain, app-server transport, waiter, journal, progress and finally cleanup remain unchanged.
  t.mock.method(os, "homedir", () => fakeHome);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access in isolated brain fixture"); });
  const clients = new Set<CodexAppServer>(), runtimes = new Set<CodexMcpToolRuntime>();
  const start = CodexAppServer.prototype.ensureStarted;
  const tracePath = path.join(root, "protocol-trace.jsonl");
  t.mock.method(CodexAppServer.prototype, "ensureStarted", async function(this: CodexAppServer) {
    clients.add(this);
    const opts = (this as any).opts;
    assert.equal(path.resolve(opts.codexHome), path.join(workspace, ".codex"));
    opts.command = process.execPath; opts.commandPrefixArgs = [fixture];
    opts.spawnEnv = { ...opts.spawnEnv, CODEX_FIXTURE_STATE_PATH: path.join(root, "protocol-state.json"), CODEX_FIXTURE_TRACE_PATH: tracePath,
      CODEX_FIXTURE_TURN_ERROR: JSON.stringify({ message: "Injected provider quota fixture", codexErrorInfo: "usageLimitExceeded" }) };
    return start.call(this);
  });
  t.mock.method(CodexMcpToolRuntime.prototype, "getDynamicToolNamespace", async function(this: CodexMcpToolRuntime) {
    runtimes.add(this); return { type: "namespace", name: "revit_operator", description: "Isolated fixture", tools: [] };
  });
  const mcpStartup = CodexMcpToolRuntime.prototype as unknown as { ensureStarted: () => Promise<void> };
  t.mock.method(mcpStartup, "ensureStarted", async () => { throw new Error("Unexpected MCP process startup in isolated fixture"); });
  t.mock.method(CodexMcpToolRuntime.prototype, "callTool", async () => { throw new Error("Unexpected MCP/native dispatch in isolated fixture"); });
  let binding: AssignmentBindingV2 | undefined;
  const heldAtCleanup: boolean[] = [];
  const endAuth = CodexMcpToolRuntime.prototype.endBackendAuthLease;
  t.mock.method(CodexMcpToolRuntime.prototype, "endBackendAuthLease", function(this: CodexMcpToolRuntime, lease: Parameters<typeof endAuth>[0]) {
    if (lease?.turn_id && binding) heldAtCleanup.push(Boolean(getAssignmentKernelSnapshotV2(binding.assignment_id)?.provider_usage_hold));
    return endAuth.call(this, lease);
  });
  __testOnlyResetGoalListCache();
  try {
    await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "fixture-local-token") }, async () => {
      await warmCodexAppServer();
      const goal = createGoal({ title: "Quota brain boundary", objective: "Inspect the current sheets", status: "active",
        acceptance_criteria: ["The current sheets are established"], related_session_id: "brain-usage-session", created_by: "fixture-owner",
        work_budget: { requested_effect: "read", document_fingerprint: "fixture-document" } });
      binding = createAssignmentKernelForGoalV2({ goal, run_id: "brain-usage-run" });
      let done = "";
      const response = await decideCodexStreaming({ version: "operator.backend.v1", session_id: binding.session_id,
        message_id: "brain-quota-attempt", assignment_id: binding.assignment_id, assignment_run_id: binding.run_id,
        assignment_generation: binding.generation, user_text: "Inspect the current sheets",
        context: { ui: { speed_settings: { agent_model: "gpt-6-astra", agent_reasoning_effort: "medium", speed_mode: false } } }
      }, { onDone: text => { done = text; } });
      const snapshot = response.assignment_snapshot_v2!;
      assert.ok(snapshot?.provider_usage_hold, "The real brain catch must retain a nonterminal usage hold");
      assert.equal(snapshot.terminal, false); assert.equal(snapshot.outcome, "active");
      assert.equal(snapshot.execution_failure_ids.length, 0);
      assert.deepEqual(response.actions, []); assert.deepEqual(response.model_call_receipts, []);
      assert.equal(response.provider_turn_usage?.disposition, "failed");
      assert.deepEqual(response.provider_turn_usage?.raw_response_ids, []);
      assert.equal(response.provider_turn_usage?.turn_id, snapshot.provider_usage_hold.provider_turn_id);
      assert.equal(snapshot.provider_usage_hold.attempt_id, "brain-quota-attempt");
      assert.equal(snapshot.provider_usage_hold.worker_identity?.configured_billing_mode, "chatgpt");
      assert.equal(snapshot.provider_usage_hold.worker_identity?.requested_model, "gpt-6-astra");
      assert.equal(snapshot.provider_usage_hold.worker_identity?.reported_model, null);
      assert.equal(done, response.assistant_message); assert.match(done, /usage limit/i); assert.match(done, /may be unsaved/);
      assert.deepEqual(heldAtCleanup, [true], "Hold must precede the real bound auth-lease cleanup");
      assert.equal(assignmentKernelTerminalSettlementDeferredV2(binding), false);
      assert.equal(activeProviderTurnForBinding(binding), null);
      for (const runtime of runtimes) assert.equal(runtime.assignmentKernelV2Binding(snapshot.provider_usage_hold.provider_turn_id, binding.session_id), null);
      const coverage = recentCommandEvents(binding.session_id, "codex.turn.usage_coverage") as any[];
      assert.equal(coverage.length, 1); assert.equal(coverage[0].disposition, "failed");
      const trace = fs.readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const requests = trace.filter(row => row.direction === "in");
      assert.equal(requests.filter(row => row.method === "turn/start").length, 1);
      assert.equal(requests.filter(row => row.method === "turn/interrupt").length, 0);
      assert.equal(requests.filter(row => row.method === "thread/resume").length, 0);
      assert.equal(requests.filter(row => row.method === "initialize").length, 1);
      assert.doesNotMatch(JSON.stringify(response), /fixture-token-never-authenticated|fixture-local-token|auth.json|fake-home/);
    });
  } finally {
    for (const client of clients) await client.stopAndWait();
    __closeForTests(); __testOnlyResetGoalListCache();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    t.mock.restoreAll();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("operator-brain-usage-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
