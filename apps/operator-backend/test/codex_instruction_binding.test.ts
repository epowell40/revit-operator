import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexInstructionBindingError, assertConfiguredBenchmarkInstructions, hostInstructionBinding } from "../src/codex/instruction_binding.js";
import { getOrCreateCodexThread } from "../src/brains/codex_thread_lifecycle.js";
import { getCodexThreadStartProfile } from "../src/brains/codex_turn_profile.js";
import { codexTelemetryThreadKey } from "../src/brains/codex_turn_model_telemetry.js";
import { getCodexThreadId } from "../src/memory/sqlite_store.js";

const a = { baseInstructions: "base A", developerInstructions: "skills A" };
const b = { baseInstructions: "base A", developerInstructions: "skills B" };

test("loaded A rejects B before provider dispatch while matching reuse preserves durable thread", async t => {
  const oldResearch = process.env.OPERATOR_WEB_RESEARCH_MODE;
  const oldDenylist = process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
  process.env.OPERATOR_WEB_RESEARCH_MODE = "unrestricted";
  delete process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
  t.after(() => {
    if (oldResearch === undefined) delete process.env.OPERATOR_WEB_RESEARCH_MODE;
    else process.env.OPERATOR_WEB_RESEARCH_MODE = oldResearch;
    if (oldDenylist === undefined) delete process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
    else process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS = oldDenylist;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-instruction-binding-"));
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const tracePath = path.join(root, "trace.jsonl");
  const resumeStatusPath = path.join(root, "resume-status.txt");
  fs.writeFileSync(resumeStatusPath, "active");
  const sourceTestDir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(sourceTestDir, "fixtures/codex_app_server_fixture.js"), path.join(sourceTestDir, "../../test/fixtures/codex_app_server_fixture.js")].find(file => fs.existsSync(file))!;
  const client = (active = false) => new CodexAppServer({ cwd: root, codexHome: path.join(root, ".codex"),
    command: process.execPath, commandPrefixArgs: [fixture],
    spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root, "state.json"), CODEX_FIXTURE_TRACE_PATH: tracePath,
      ...(active ? { CODEX_FIXTURE_RESUME_STATUS_PATH: resumeStatusPath } : {}) } });
  const first = client();
  const second = client();
  const activeRejoin = client(true);
  const profile = getCodexThreadStartProfile({ session_id: "binding-test", context: {} }, a);
  const args = { sessionId: "binding-test", profile, cwd: root,
    settings: { model: "fixture", reasoning_effort: "medium" as const }, getDynamicTools: async () => [] };
  try {
    await first.ensureStarted();
    const threadId = await getOrCreateCodexThread({ ...args, client: first });
    const durableKey = codexTelemetryThreadKey(profile);
    assert.equal(getCodexThreadId(durableKey), threadId);
    const envelopePath = path.join(root, "expected.json");
    fs.writeFileSync(envelopePath, JSON.stringify({ schema: "revit-operator.benchmark-run-envelope/v2", identity: { run_id: "instruction-test" }, instruction_bundle_hashes: hostInstructionBinding(b) }));
    const previousEnvelope = process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH;
    process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH = envelopePath;
    try {
      await assert.rejects(getOrCreateCodexThread({ ...args, client: first }), CodexInstructionBindingError);
    } finally {
      if (previousEnvelope === undefined) delete process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH;
      else process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH = previousEnvelope;
    }
    await assert.rejects(getOrCreateCodexThread({ ...args, profile: { ...profile, ...b }, client: first }), CodexInstructionBindingError);
    assert.throws(() => first.startBoundTurn({ threadId, input: [] }, b), CodexInstructionBindingError);
    assert.equal(getCodexThreadId(durableKey), threadId);
    assert.equal(await getOrCreateCodexThread({ ...args, client: first }), threadId);
    let trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 0);
    assert.equal((trace.match(/"method":"thread\/start"/g) ?? []).length, 1);
    assert.equal((trace.match(/"method":"thread\/resume"/g) ?? []).length, 0);
    assert.equal((trace.match(/"method":"turn\/interrupt"/g) ?? []).length, 0);
    const started = await first.startBoundTurn({ threadId, input: [] }, a);
    assert.deepEqual(first.getTurnInstructionBinding(threadId, started.turn.id), hostInstructionBinding(a));
    first.acknowledgePersistedTurnInstructionBinding(threadId, started.turn.id);
    assert.equal(first.getTurnInstructionBinding(threadId, started.turn.id), undefined);
    first.stop();
    assert.equal(first.getThreadInstructionBinding(threadId), undefined);
    await second.ensureStarted();
    assert.equal(await getOrCreateCodexThread({ ...args, client: second }), threadId);
    assert.deepEqual(second.getThreadInstructionBinding(threadId), hostInstructionBinding(a));
    assert.throws(() => second.startBoundTurn({ threadId, input: [] }, b), CodexInstructionBindingError);
    await second.startBoundTurn({ threadId, input: [] }, a);
    await assert.rejects(second.resumeThread({ threadId, ...b }), CodexInstructionBindingError);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 2);
    assert.equal(getCodexThreadId(durableKey), threadId);
    await activeRejoin.ensureStarted();
    assert.equal(await getOrCreateCodexThread({ ...args, client: activeRejoin, monitoringOnly: true }), threadId);
    assert.equal(activeRejoin.hasLoadedThread(threadId), true);
    assert.equal(activeRejoin.getThreadInstructionBinding(threadId), undefined);
    assert.throws(() => activeRejoin.startBoundTurn({ threadId, input: [] }, a), CodexInstructionBindingError);
    await assert.rejects(getOrCreateCodexThread({ ...args, client: activeRejoin }), CodexInstructionBindingError);
    assert.equal(getCodexThreadId(durableKey), threadId);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 2, "active metadata resume must not replay a turn");
    fs.writeFileSync(resumeStatusPath, "idle");
    assert.equal(await getOrCreateCodexThread({ ...args, client: activeRejoin }), threadId);
    assert.deepEqual(activeRejoin.getThreadInstructionBinding(threadId), hostInstructionBinding(a));
    await activeRejoin.startBoundTurn({ threadId, input: [] }, a);
    assert.equal(getCodexThreadId(durableKey), threadId);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 3, "only the requested new turn may start after idle acknowledgement");
    assert.equal((trace.match(/"method":"thread\/start"/g) ?? []).length, 1, "recovery preserves the original thread");
    const threadRequests = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => ["thread/start", "thread/resume"].includes(row.method) && row.params?.config);
    assert.ok(threadRequests.some(row => row.method === "thread/start"));
    assert.ok(threadRequests.some(row => row.method === "thread/resume"));
    for (const row of threadRequests) assert.equal(row.params.config.web_search, "live", "live research survives creation and process resume");
    assert.equal((trace.match(/"method":"turn\/interrupt"/g) ?? []).length, 0);
  } finally {
    first.stop(); second.stop(); activeRejoin.stop();
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
    // SQLite may still hold this exact diagnostic fixture open on Windows.
    // Leave it in the OS temporary directory rather than forcing handle cleanup.
  }
});

test("host-configured benchmark envelope mismatch fails closed without trusting request context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instruction-envelope-"));
  const file = path.join(root, "envelope.json");
  const env = { OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH: file };
  try {
    assert.throws(() => assertConfiguredBenchmarkInstructions(a, env), CodexInstructionBindingError);
    fs.writeFileSync(file, JSON.stringify({ schema: "revit-operator.benchmark-run-envelope/v2", identity: { run_id: "instruction-test" }, instruction_bundle_hashes: hostInstructionBinding(b) }));
    assert.throws(() => assertConfiguredBenchmarkInstructions(a, env), CodexInstructionBindingError);
    assertConfiguredBenchmarkInstructions(b, env);
    assert.equal(hostInstructionBinding(a).system_instruction_sha256, hostInstructionBinding({ ...a }).system_instruction_sha256);
    assert.notEqual(hostInstructionBinding(a).system_instruction_sha256, hostInstructionBinding(b).system_instruction_sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("both production turn dispatch paths use the bound method and one frozen profile", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const source = [path.join(testDir, "../src/brains/codex_brain.ts"), path.join(testDir, "../../src/brains/codex_brain.ts")].find(file => fs.existsSync(file))!;
  const text = fs.readFileSync(source, "utf8");
  assert.equal((text.match(/\.startBoundTurn\(/g) ?? []).length, 2);
  assert.doesNotMatch(text, /(?:activeClient|c)\.startTurn\(/);
  assert.match(text, /const threadProfile = Object\.freeze\(getCodexThreadStartProfileForTest\(req\)\)/);
  assert.match(text, /if \(error instanceof CodexInstructionBindingError\) return instructionBindingStop\(error\)/);
});
