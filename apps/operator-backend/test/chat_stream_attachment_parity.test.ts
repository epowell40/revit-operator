import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "../src/contracts.js";

const READINESS_DEADLINE_MS = 20_000;
const READINESS_FETCH_TIMEOUT_MS = 500;
const STDERR_TAIL_LIMIT = 8_192;
const childStderrTails = new WeakMap<ChildProcess, string>();

function captureChildDiagnostics(child: ChildProcess): void {
  childStderrTails.set(child, "");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const previous = childStderrTails.get(child) ?? "";
    childStderrTails.set(child, `${previous}${chunk}`.slice(-STDERR_TAIL_LIMIT));
  });
}

function childDiagnostics(child: ChildProcess): string {
  const stderr = childStderrTails.get(child)?.trim();
  return `exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)} stderrTail=${stderr || "<empty>"}`;
}

async function availablePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number };
      socket.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = async (signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        reject(error);
      };
      child.once("exit", onExit);
      child.once("error", onError);
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        const signaled = child.kill(signal);
        if (!signaled && (child.exitCode !== null || child.signalCode !== null)) finish(true);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  if (await waitForExit("SIGTERM", 2_000)) return;
  if (await waitForExit("SIGKILL", 2_000)) return;
  throw new Error(`Spawned backend process ${child.pid ?? "unknown"} did not exit: ${childDiagnostics(child)}`);
}

async function waitForServer(base: string, headers: Record<string, string>, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Backend exited before readiness: ${childDiagnostics(child)}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(READINESS_FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
    );
    let onExit: (() => void) | undefined;
    try {
      const exited = new Promise<never>((_resolve, reject) => {
        onExit = () => reject(new Error(`Backend exited before readiness: ${childDiagnostics(child)}`));
        child.once("exit", onExit);
      });
      const response = await Promise.race([
        fetch(`${base}/health`, { headers, signal: controller.signal }),
        exited
      ]);
      lastStatus = response.status;
      if (response.ok) return true;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Backend exited before readiness: ${childDiagnostics(child)}`);
      }
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      clearTimeout(timeout);
      if (onExit) child.off("exit", onExit);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `Backend did not become ready within ${READINESS_DEADLINE_MS}ms ` +
    `(lastStatus=${String(lastStatus)} lastError=${lastError ?? "<none>"} ${childDiagnostics(child)}).`
  );
}

function request(sessionId: string): ChatRequest {
  return {
    version: "operator.backend.v1",
    session_id: sessionId,
    message_id: `${sessionId}-message`,
    user_text: "Open the floor plan import tool for this PDF.",
    user_attachments: [
      {
        id: "redline-pdf",
        relative_path: "artifacts/uploads/redline.pdf",
        filename: "redline.pdf",
        sha256: "a".repeat(64),
        mime: "application/pdf"
      }
    ]
  };
}

function attachmentFromActions(actions: any[]): any {
  return actions[0]?.body?.initialPayload?.attachments?.[0];
}

test("stream and non-stream chat pass the same canonical attachment context to the brain", async (t) => {
  const port = await availablePort();
  const token = "stream-attachment-parity-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-attachment-parity-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_BRAIN: "rule",
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_WORKSPACE_ROOT: workspace
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  captureChildDiagnostics(child);
  t.after(async () => {
    try {
      await stop(child);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-operator-token": token };
  assert.equal(await waitForServer(base, { "x-operator-token": token }, child), true, "backend must report ready");

  const regularResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(request("regular"))
  });
  assert.equal(regularResponse.status, 200);
  const regular: any = await regularResponse.json();

  const streamResponse = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(request("stream"))
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  const actionEvent = streamText
    .split("\n\n")
    .find((event) => event.startsWith("event: actions\n"));
  assert.ok(actionEvent, `missing actions event in ${streamText}`);
  const stream: any = JSON.parse(actionEvent!.split("\n").find((line) => line.startsWith("data: "))!.slice(6));

  assert.deepEqual(attachmentFromActions(stream.actions), attachmentFromActions(regular.actions));
  assert.deepEqual(attachmentFromActions(stream.actions), {
    id: "redline-pdf",
    relative_path: "artifacts/uploads/redline.pdf",
    filename: "redline.pdf",
    sha256: "a".repeat(64),
    mime: "application/pdf"
  });
});
