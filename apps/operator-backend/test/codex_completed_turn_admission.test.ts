import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";

test("same-batch completion fences new tool calls while admitted work and other turns settle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-completed-admission-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(here, "fixtures/codex_app_server_fixture.js"),
    path.join(here, "../../test/fixtures/codex_app_server_fixture.js")].find(candidate => fs.existsSync(candidate));
  assert.ok(fixture);
  const tracePath = path.join(root, "trace.jsonl");
  const client = new CodexAppServer({ cwd: root, codexHome: path.join(root, ".codex"), command: process.execPath,
    commandPrefixArgs: [fixture], spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root, "state.json"),
      CODEX_FIXTURE_TRACE_PATH: tracePath, CODEX_FIXTURE_COMPLETED_ADMISSION: "1" } });
  let finishAdmitted!: (value: unknown) => void;
  const entered: string[] = [];
  client.setServerRequestHandler(async request => {
    entered.push(String(request.id));
    if (request.id === "admitted-before") return new Promise(resolve => { finishAdmitted = resolve; });
    return { settled: request.id };
  });
  try {
    await client.ensureStarted();
    const thread = await client.startThread({ cwd: root });
    const turn = await client.startTurn({ threadId: thread.thread.id, input: [] });
    assert.deepEqual(entered, ["admitted-before", "other-turn"], "a later call must not enter the handler after completion, even before start acknowledgement");
    await assert.rejects(client.waitForTurnCompleted({ threadId: thread.thread.id, turnId: turn.turn.id, timeoutMs: 1000 }), /Injected usage/);
    finishAdmitted({ settled: "already-admitted" });
    const deadline = Date.now() + 1000;
    let responses: any[] = [];
    while (Date.now() < deadline) {
      responses = fs.readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.direction === "server-response");
      if (responses.length === 5) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(responses.length, 5);
    assert.match(responses.find(row => row.method === "late-after-completion")?.error?.message ?? "", /completed|settled/);
    for (const id of ["missing-thread", "missing-turn"])
      assert.match(responses.find(row => row.method === id)?.error?.message ?? "", /exact thread and turn identity/);
    assert.deepEqual(responses.find(row => row.method === "admitted-before")?.result, { settled: "already-admitted" });
    assert.deepEqual(responses.find(row => row.method === "other-turn")?.result, { settled: "other-turn" });
  } finally {
    finishAdmitted?.({ cleanup: true });
    await client.stopAndWait();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("operator-completed-admission-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
