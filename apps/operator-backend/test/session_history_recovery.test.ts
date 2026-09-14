import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import net from "node:net";

test("conversation HTTP history survives backend restart and rejects another principal", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-history-http-"));
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const secret = "conversation-principal-test-key";
  const base = `http://127.0.0.1:${port}`;
  const headers = (user: string) => {
    const prefix = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." +
      Buffer.from(JSON.stringify({ sub: user, user_id: user, tenant_id: "team", license_id: "team", roles: ["user"], exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    return { authorization: `Bearer ${prefix}.${createHmac("sha256", secret).update(prefix).digest("base64url")}`, "content-type": "application/json" };
  };
  const children: ChildProcess[] = [];
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  t.after(async () => { for (const child of children) await stop(child); });
  const start = async () => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/src/index.js")], { stdio: "ignore", env: {
      ...process.env, OPERATOR_BACKEND_PORT: String(port), OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_AUTH_MODE: "principal_jwt", OPERATOR_JWT_SECRET: secret, OPERATOR_JWT_ISSUER: "", OPERATOR_JWT_AUDIENCE: "",
      OPERATOR_CLASHPILOT_JWT_SECRET: "", OPERATOR_CLASHPILOT_JWT_ISSUER: "", OPERATOR_CLASHPILOT_JWT_AUDIENCE: "", OPERATOR_BRAIN: "rule"
    } });
    children.push(child);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Conversation backend exited before readiness.");
      try { if ((await fetch(base + "/health")).ok) return child; } catch { }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Conversation backend did not become ready.");
  };
  const first = await start();
  const createdResponse = await fetch(base + "/session/new", { method: "POST", headers: headers("alice") });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { session_id: string };
  const body = { version: "operator.backend.v1", session_id: created.session_id, message_id: "native-question", user_text: "Can you see the open model? What view is active?",
    ui_observation: { ok: true, data: { document: { title: "Pilot", activeView: { name: "L2" } } } } };
  const written = await fetch(base + "/session/ui-context", { method: "POST", headers: headers("alice"), body: JSON.stringify(body) });
  assert.equal(written.status, 200, await written.text());
  const historyUrl = base + "/session/history?session_id=" + encodeURIComponent(created.session_id);
  assert.equal((await fetch(historyUrl)).status, 401);
  assert.equal((await fetch(historyUrl, { headers: headers("bob") })).status, 403);
  assert.equal((await fetch(base + "/session/ui-context", { method: "POST", headers: headers("bob"), body: JSON.stringify(body) })).status, 403);
  await stop(first);
  await start();
  const restored = await fetch(historyUrl, { headers: headers("alice") });
  assert.equal(restored.status, 200);
  assert.equal(restored.headers.get("cache-control"), "no-store");
  const history = await restored.json() as { messages: Array<{ text: string }> };
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].text, body.user_text);
  assert.match(history.messages[1].text, /Pilot.*L2/);
  const mixed = await fetch(base + "/session/ui-context", { method: "POST", headers: headers("alice"), body: JSON.stringify({
    ...body, message_id: "mixed-instruction", user_text: "Can you see the open model? What view is active? Rename it."
  }) });
  assert.equal(mixed.status, 400);
  assert.equal(((await (await fetch(historyUrl, { headers: headers("alice") })).json()) as { messages: unknown[] }).messages.length, 2);
});

test("first new turn after a cold session preserves the earlier durable conversation", async () => {
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-history-recovery-"));
  const database = await import("../src/memory/sqlite_store.js");
  const session = await import("../src/session_store.js");
  database.ensureSessionRow("cold-session");
  assert.equal(database.appendEvent("cold-session", "user", "chat.message", { text: "Which view is open?" }), true);
  assert.equal(database.appendEvent("cold-session", "assistant", "chat.message", { text: "L2 in Team Redline Pilot." }), true);
  // This is the restart ordering: the first new user message arrives before
  // any provider asks for history, so an empty-memory heuristic loses context.
  session.appendMessage("cold-session", { role: "user", text: "What is selected there?" });
  assert.deepEqual(session.getHistory("cold-session").map(message => message.text), [
    "Which view is open?", "L2 in Team Redline Pilot.", "What is selected there?"
  ]);
  session.appendMessage("cold-session", { role: "assistant", text: "One duct." });
  assert.equal(session.getHistory("cold-session").length, 4);
  assert.equal(session.getHistory("unrelated-session").length, 0);
  database.__closeForTests();
});

test("UI answers survive restart without repinning the task or exposing provider attachment text", async () => {
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-visible-history-"));
  const database = await import("../src/memory/sqlite_store.js");
  const session = await import("../src/session_store.js");
  const { recordUiContextConversation, conversationDisplay } = await import("../src/conversation_history.js");
  session.appendMessage("task", { role: "user", text: "Review the mechanical equipment schedule for design development." });
  const pinned = session.getPinnedGoal("task");
  const body = { version: "operator.backend.v1", session_id: "task", message_id: "model-question", user_text: "can you see the open model?",
    ui_observation: { ok: true, data: { document: { title: "Pilot", activeView: { name: "L2" } } } } };
  const answer = await recordUiContextConversation(body);
  assert.match(answer, /Pilot.*L2/);
  assert.equal(session.getPinnedGoal("task"), pinned);
  const { buildCodexTurnInput } = await import("../src/brains/codex_turn_input.js");
  const followup = { version: "operator.backend.v1", session_id: "task", message_id: "followup", user_text: "What about its view?" };
  const providerInput = await buildCodexTurnInput(followup as any, ["CURRENT TASK: keep reviewing the schedule."]);
  const providerText = providerInput.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(providerText, /HISTORICAL UI CONVERSATION/);
  assert.match(providerText, /Pilot.*L2/);
  assert.match(providerText, /not current Revit evidence or task completion/);
  assert.match(providerText, /CURRENT TASK: keep reviewing the schedule/);
  const foreignInput = await buildCodexTurnInput({ ...followup, session_id: "another-task" } as any, []);
  assert.doesNotMatch(JSON.stringify(foreignInput), /Pilot|HISTORICAL UI CONVERSATION/);
  assert.match(session.getHistory("task").at(-1)!.text, /Historical UI observation/);
  database.__closeForTests();
  assert.equal(await recordUiContextConversation({ ...body, ui_observation: { ok: false } }), answer);
  assert.equal(database.getConversationHistory("task").length, 2);
  await assert.rejects(recordUiContextConversation({ ...body, user_text: "what is selected?" }), /another question/);
  await assert.rejects(recordUiContextConversation({ ...body, message_id: "mixed", user_text: "Can you see the model and delete its ducts?" }), /only simple/);
  session.appendMessage("task", { role: "user", text: "PRIVATE PROVIDER ATTACHMENT MACHINERY" },
    { display: conversationDisplay("redline", "Please review this redline.", [{ id: "upload-1", filename: "review.pdf", external_path: "private-path", sha256: "private-hash" }]) });
  const visible = database.getConversationHistory("task");
  assert.equal(visible.length, 3);
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE PROVIDER|private-path|private-hash|Historical UI/);
  assert.deepEqual(visible[2].attachments, [{ id: "upload-1", name: "review.pdf" }]);
  assert.equal(database.getConversationHistory("unrelated").length, 0);
  database.__closeForTests();
});


test("a rejected durable write leaves no ghost turn and can be retried once", async () => {
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-history-write-failure-"));
  const database = await import("../src/memory/sqlite_store.js");
  const session = await import("../src/session_store.js");
  const { ensureWorkspaceLayout } = await import("../src/workspace.js");
  const { createRequire } = await import("node:module");
  const Sqlite = createRequire(import.meta.url)("better-sqlite3");
  session.appendMessage("retry", { role: "user", text: "Existing task conversation." });
  const control = new Sqlite(path.join(ensureWorkspaceLayout().db, "operator.sqlite"));
  try {
    control.exec("CREATE TRIGGER reject_test_message BEFORE INSERT ON events WHEN NEW.kind = 'chat.message' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    assert.throws(() => session.appendMessage("retry", { role: "assistant", text: "New answer." }, { requirePersistence: true }), /test storage failure/);
    assert.deepEqual(session.getHistory("retry").map(m => m.text), ["Existing task conversation."]);
    control.exec("DROP TRIGGER reject_test_message");
    session.appendMessage("retry", { role: "assistant", text: "New answer." }, { requirePersistence: true });
    assert.deepEqual(session.getHistory("retry").map(m => m.text), ["Existing task conversation.", "New answer."]);
    assert.equal(database.getRecentMessages("retry", 80).length, 2);
  } finally { control.close(); database.__closeForTests(); }
});
