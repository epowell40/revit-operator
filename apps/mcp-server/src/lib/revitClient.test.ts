import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callRevit, RevitBridgeCallError } from "./revitClient.js";

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function setTestEnvironment(url: string, timeoutMs: number): () => void {
  const previous = {
    url: process.env.REVIT_BRIDGE_URL,
    timeout: process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS,
    workspace: process.env.OPERATOR_WORKSPACE_ROOT,
    token: process.env.OPERATOR_TOKEN,
    transport: process.env.OPERATOR_REVIT_TRANSPORT,
  };
  process.env.REVIT_BRIDGE_URL = url;
  process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS = String(timeoutMs);
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "revit-client-test-"));
  process.env.OPERATOR_TOKEN = "revit-client-test-token";
  process.env.OPERATOR_REVIT_TRANSPORT = "direct";
  return () => {
    for (const [name, value] of Object.entries({
      REVIT_BRIDGE_URL: previous.url,
      OPERATOR_REVIT_REQUEST_TIMEOUT_MS: previous.timeout,
      OPERATOR_WORKSPACE_ROOT: previous.workspace,
      OPERATOR_TOKEN: previous.token,
      OPERATOR_REVIT_TRANSPORT: previous.transport,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("callRevit returns JSON from a responsive bridge", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    assert.deepEqual(await callRevit("/revit/ping"), { ok: true });
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit aborts a non-responsive bridge with a typed retryable timeout", async () => {
  const server = http.createServer(() => {
    // Deliberately leave the response open until the client deadline aborts it.
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 250);
  const started = Date.now();
  try {
    await assert.rejects(
      callRevit("/revit/sheets", "POST", { action: "list" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_timeout");
        assert.equal(error.retryable, true);
        assert.match(error.message, /POST \/revit\/sheets exceeded 250 ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit reports a closed bridge as typed and retryable", async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, true);
        assert.match(error.message, /Revit may be closed or the bridge may not be listening/);
        return true;
      },
    );
  } finally {
    restore();
  }
});
