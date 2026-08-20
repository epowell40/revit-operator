import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.144.5\n");
  process.exit(0);
}
if (args[0] !== "app-server") throw new Error(`Unexpected fixture command: ${args.join(" ")}`);

const statePath = process.env.CODEX_FIXTURE_STATE_PATH;
const tracePath = process.env.CODEX_FIXTURE_TRACE_PATH;
if (!statePath || !tracePath) throw new Error("Fixture state and trace paths are required.");

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { threads: Array.isArray(parsed.threads) ? parsed.threads : [], nextTurn: parsed.nextTurn ?? 1 };
  } catch {
    return { threads: [], nextTurn: 1 };
  }
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}
function trace(direction, method, details = {}) {
  fs.appendFileSync(tracePath, `${JSON.stringify({ pid: process.pid, direction, method, ...details })}\n`);
}
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notify(method, params) {
  trace("out", method);
  send({ method, params });
}

const state = loadState();
const pendingToolTimers = new Map();
let initialized = false;
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  trace("in", message.method);
  if (message.method === "initialized") return;
  const respond = result => send({ id: message.id, result });
  if (message.method === "initialize") {
    if (initialized) {
      send({ id: message.id, error: { code: -32600, message: "initialize called more than once" } });
      return;
    }
    initialized = true;
    respond({ userAgent: "fixture/0.144.5", codexHome: process.cwd(), platformFamily: "windows", platformOs: "windows" });
    return;
  }
  if (!initialized) throw new Error(`Method ${message.method} arrived before initialize.`);
  if (message.method === "thread/start") {
    const threadId = `thread-fixture-${state.threads.length + 1}`;
    state.threads.push(threadId);
    saveState(state);
    respond({ thread: { id: threadId } });
    return;
  }
  if (message.method === "thread/resume") {
    const threadId = String(message.params?.threadId ?? "");
    if (!state.threads.includes(threadId)) {
      send({ id: message.id, error: { code: -32602, message: `thread not found: ${threadId}` } });
      return;
    }
    respond({ thread: { id: threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-fixture-${state.nextTurn++}`;
    saveState(state);
    respond({ turn: { id: turnId } });
    const shouldWaitForInterrupt = JSON.stringify(message.params?.input ?? []).includes("interrupt-me");
    if (shouldWaitForInterrupt) {
      pendingToolTimers.set(turnId, setTimeout(() => {
        pendingToolTimers.delete(turnId);
        notify("item/completed", { threadId: message.params.threadId, turnId, item: { type: "dynamicToolCall", tool: "forbidden_after_interrupt" } });
      }, 120));
    } else {
      setTimeout(() => notify("turn/completed", {
        threadId: message.params.threadId,
        turn: { id: turnId, status: "completed", error: null }
      }), 20);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    const turnId = String(message.params?.turnId ?? "");
    const timer = pendingToolTimers.get(turnId);
    if (timer) clearTimeout(timer);
    pendingToolTimers.delete(turnId);
    respond({});
    setTimeout(() => notify("turn/completed", {
      threadId: message.params.threadId,
      turn: { id: turnId, status: "interrupted", error: null }
    }), 10);
    return;
  }
  if (message.method === "turn/get" || message.method === "turn/status") {
    send({ id: message.id, error: { code: -32601, message: "fixture does not implement polling" } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported fixture method: ${message.method}` } });
});
