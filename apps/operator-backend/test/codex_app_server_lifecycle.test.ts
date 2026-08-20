import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/codex/app_server.js";

type TraceEntry = { pid: number; direction: "in" | "out"; method: string };

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createClient(root: string, statePath: string, tracePath: string): CodexAppServer {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex_app_server_fixture.js");
  return new CodexAppServer({
    cwd: root,
    codexHome: path.join(root, ".codex"),
    spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: statePath, CODEX_FIXTURE_TRACE_PATH: tracePath },
    command: process.execPath,
    commandPrefixArgs: [fixturePath]
  });
}

test("app-server lifecycle initializes once, resumes persisted threads, and interrupts before later tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-app-server-lifecycle-"));
  const statePath = path.join(root, "state.json");
  const tracePath = path.join(root, "trace.jsonl");
  let first: CodexAppServer | null = null;
  let second: CodexAppServer | null = null;
  try {
    first = createClient(root, statePath, tracePath);
    await first.ensureStarted();
    const started = await first.startThread({
      cwd: root,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      dynamicTools: []
    });
    const threadId = started.thread.id;
    assert.equal(first.hasLoadedThread(threadId), true);
    first.stop();
    first = null;
    await delay(40);

    second = createClient(root, statePath, tracePath);
    await second.ensureStarted();
    assert.equal(second.hasLoadedThread(threadId), false);
    const resumed = await second.resumeThread({
      threadId,
      cwd: root,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      excludeTurns: true
    });
    assert.equal(resumed.thread.id, threadId);
    assert.equal(second.hasLoadedThread(threadId), true);

    const completedTurn = await second.startTurn({
      threadId,
      input: [{ type: "text", text: "complete normally", text_elements: [] }]
    });
    const completed = await second.waitForTurnCompleted({
      threadId,
      turnId: completedTurn.turn.id,
      timeoutMs: 2_000
    });
    assert.deepEqual(completed, { status: "completed", interrupted: false });

    const interruptibleTurn = await second.startTurn({
      threadId,
      input: [{ type: "text", text: "interrupt-me", text_elements: [] }]
    });
    const interruptedWait = second.waitForTurnCompleted({
      threadId,
      turnId: interruptibleTurn.turn.id,
      timeoutMs: 2_000
    });
    await second.interruptTurn({ threadId, turnId: interruptibleTurn.turn.id });
    const interrupted = await interruptedWait;
    assert.deepEqual(interrupted, { status: "interrupted", interrupted: true });
    await delay(180);

    second.stop();
    second = null;
    await delay(40);
    const trace = fs.readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as TraceEntry);
    const byProcess = new Map<number, TraceEntry[]>();
    for (const entry of trace) byProcess.set(entry.pid, [...(byProcess.get(entry.pid) ?? []), entry]);
    assert.equal(byProcess.size, 2);
    for (const entries of byProcess.values()) {
      assert.equal(entries.filter(entry => entry.direction === "in" && entry.method === "initialize").length, 1);
      assert.equal(entries.filter(entry => entry.direction === "in" && entry.method === "initialized").length, 1);
    }
    assert.equal(trace.some(entry => entry.direction === "in" && entry.method === "thread/resume"), true);
    assert.equal(trace.some(entry => entry.direction === "in" && entry.method === "turn/interrupt"), true);
    assert.equal(trace.some(entry => entry.direction === "out" && entry.method === "item/completed"), false);
  } finally {
    first?.stop();
    second?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
