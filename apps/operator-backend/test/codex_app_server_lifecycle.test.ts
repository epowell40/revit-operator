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

function fixturePath(): string {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(testDir, "fixtures", "codex_app_server_fixture.js"),
    path.join(testDir, "..", "..", "test", "fixtures", "codex_app_server_fixture.js")
  ];
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(resolved, `Codex app-server fixture is missing; checked: ${candidates.join(", ")}`);
  return resolved;
}

function createClient(root: string, statePath: string, tracePath: string, extraEnv: NodeJS.ProcessEnv = {}): CodexAppServer {
  return new CodexAppServer({
    cwd: root,
    codexHome: path.join(root, ".codex"),
    spawnEnv: { ...process.env, ...extraEnv, CODEX_FIXTURE_STATE_PATH: statePath, CODEX_FIXTURE_TRACE_PATH: tracePath },
    command: process.execPath,
    commandPrefixArgs: [fixturePath()]
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
    await first.stopAndWait();
    first = null;

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

test("fast interrupt before acknowledgement is retained and restart cannot inherit the old completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-fast-interrupt-"));
  const statePath = path.join(root, "state.json"), tracePath = path.join(root, "trace.jsonl");
  const client = createClient(root, statePath, tracePath, { CODEX_FIXTURE_INTERRUPT_BEFORE_ACK: "1" });
  try {
    await client.ensureStarted();
    const thread = await client.startThread({ cwd: root, sandbox: "read-only", approvalPolicy: "never" });
    const threadId = thread.thread.id;
    const turn = await client.startTurn({ threadId, input: [{ type: "text", text: "interrupt-me", text_elements: [] }] });
    const turnId = turn.turn.id;
    await client.interruptTurn({ threadId, turnId });
    assert.deepEqual(await client.waitForTurnCompleted({ threadId, turnId, timeoutMs: 200 }), { status: "interrupted", interrupted: true });
    const pending = client.waitForTurnCompleted({ threadId, turnId: "unobserved", timeoutMs: 5000 });
    const rejected = assert.rejects(pending, /transport stopped/);
    await client.stopAndWait();
    await rejected;
    await client.ensureStarted();
    await client.resumeThread({ threadId, cwd: root, sandbox: "read-only", approvalPolicy: "never", excludeTurns: true });
    await assert.rejects(client.waitForTurnCompleted({ threadId, turnId, timeoutMs: 20 }), /Timed out/);
    const trace = fs.readFileSync(tracePath, "utf8");
    assert.doesNotMatch(trace, /turn\/(get|status)/);
  } finally {
    await client.stopAndWait();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("operator-fast-interrupt-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reconnect reads terminal history from the supported resume response without polling nonexistent methods", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-resume-completion-"));
  const client = createClient(root, path.join(root,"state.json"), path.join(root,"trace.jsonl"), {
    CODEX_FIXTURE_RESUME_TURNS: JSON.stringify([{id:"turn-fixture-1",status:"completed",error:null}])
  });
  try {
    await client.ensureStarted();
    const thread = await client.startThread({cwd:root,sandbox:"read-only",approvalPolicy:"never"});
    const turn = await client.startTurn({threadId:thread.thread.id,input:[{type:"text",text:"interrupt-me",text_elements:[]}]});
    await client.stopAndWait();
    await client.ensureStarted();
    await client.resumeThread({threadId:thread.thread.id,cwd:root,sandbox:"read-only",approvalPolicy:"never"});
    assert.deepEqual(await client.waitForTurnCompleted({threadId:thread.thread.id,turnId:turn.turn.id,timeoutMs:0}),{status:"completed",interrupted:false});
    const trace = fs.readFileSync(path.join(root,"trace.jsonl"),"utf8");
    assert.doesNotMatch(trace,/turn\/get|turn\/status/);
  } finally {
    await client.stopAndWait();
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("operator-resume-completion-"));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("completion before start acknowledgement is available without another provider request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-fast-completion-"));
  const client = createClient(root, path.join(root, "state.json"), path.join(root, "trace.jsonl"), { CODEX_FIXTURE_COMPLETE_BEFORE_START_ACK: "1" });
  try {
    await client.ensureStarted();
    const thread = await client.startThread({ cwd: root, sandbox: "read-only", approvalPolicy: "never" });
    const turn = await client.startTurn({ threadId: thread.thread.id, input: [{ type: "text", text: "complete", text_elements: [] }] });
    assert.deepEqual(await client.waitForTurnCompleted({ threadId: thread.thread.id, turnId: turn.turn.id, timeoutMs: 0 }), { status: "completed", interrupted: false });
  } finally {
    await client.stopAndWait();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("operator-fast-completion-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
