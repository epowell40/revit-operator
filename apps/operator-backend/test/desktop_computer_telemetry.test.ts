import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getDesktopComputerProviderErrorReceipt,
  relayDesktopComputerResponse
} from "../src/desktop_computer.js";

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function availablePort(): Promise<number> {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { "x-operator-token": token } });
      if (response.ok) return;
    } catch {
      // Retry while the backend child starts.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for backend health at ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

test("desktop relay preserves outer-model usage for Luna at literal max", { concurrency: false }, async () => {
  let requestBody: any = null;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_desktop_luna",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 150 },
          output_tokens: 55,
          output_tokens_details: { reasoning_tokens: 34 },
          total_tokens: 265
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    key: process.env.OPERATOR_OPENAI_API_KEY,
    baseUrl: process.env.OPERATOR_OPENAI_BASE_URL
  };
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
    const result = await relayDesktopComputerResponse({
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input: "test input"
    });

    assert.equal(requestBody.model, "gpt-5.6-luna");
    assert.equal(requestBody.reasoning.effort, "max");
    assert.equal(result.model_call_receipt.route, "desktop_computer");
    assert.equal(result.model_call_receipt.call_id, "resp_desktop_luna");
    assert.equal(result.model_call_receipt.success, true);
    assert.deepEqual(result.model_call_receipt.tokens, {
      input_tokens: 210,
      cached_input_tokens: 150,
      output_tokens: 55,
      reasoning_output_tokens: 34,
      total_tokens: 265
    });
  } finally {
    if (previous.key === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.OPERATOR_OPENAI_BASE_URL;
    else process.env.OPERATOR_OPENAI_BASE_URL = previous.baseUrl;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("desktop relay rejects unsafe explicit model and effort values before dispatch", { concurrency: false }, async () => {
  const previous = process.env.OPERATOR_OPENAI_API_KEY;
  process.env.OPERATOR_OPENAI_API_KEY = "test-key";
  try {
    for (const [request, expectedMessage] of [
      [{ model: "../../bad model", input: "test" }, /bounded provider model identifier/],
      [{ reasoning_effort: "maximum", input: "test" }, /none, low, medium, high, xhigh, or max/]
    ]) {
      try {
        await relayDesktopComputerResponse(request as any);
        assert.fail("Expected pre-dispatch validation to fail.");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : "", expectedMessage as RegExp);
        assert.equal(getDesktopComputerProviderErrorReceipt(error), null);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous;
  }
});

test("desktop relay does not claim a provider call when API configuration is missing", { concurrency: false }, async () => {
  const previous = {
    operatorKey: process.env.OPERATOR_OPENAI_API_KEY,
    fallbackKey: process.env.OPENAI_API_KEY
  };
  delete process.env.OPERATOR_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await relayDesktopComputerResponse({ input: "test" });
    assert.fail("Expected missing API configuration to fail.");
  } catch (error) {
    assert.match(error instanceof Error ? error.message : "", /OPERATOR_OPENAI_API_KEY/);
    assert.equal(getDesktopComputerProviderErrorReceipt(error), null);
  } finally {
    if (previous.operatorKey === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous.operatorKey;
    if (previous.fallbackKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.fallbackKey;
  }
});

test("desktop endpoint returns one content-free failed receipt for a dispatched provider error", { concurrency: false }, async (t) => {
  const rawProviderMessage = "provider raw body contains prompt=DO_NOT_EXPOSE and secret=sk-private";
  let providerCalls = 0;
  const provider = http.createServer((_request, response) => {
    providerCalls += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: rawProviderMessage,
        type: "invalid_request_error",
        code: "mock_provider_failure"
      }
    }));
  });
  const providerPort = await listen(provider);
  const backendPort = await availablePort();
  const token = "desktop-provider-error-receipt-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-desktop-receipt-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(backendPort),
      OPERATOR_TOKEN: token,
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_OPENAI_API_KEY: "test-key",
      OPERATOR_OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}`,
      OPERATOR_HOSTED_ENABLED: "0"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForHealth(`http://127.0.0.1:${backendPort}/health`, token);
  const response = await fetch(`http://127.0.0.1:${backendPort}/desktop/computer/respond`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operator-token": token
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input: "sensitive prompt that must not be returned"
    })
  });

  assert.equal(response.status, 500);
  const responseText = await response.text();
  const payload = JSON.parse(responseText) as any;
  assert.equal(payload.error, "Desktop computer provider request failed.");
  assert.equal(providerCalls, 1);
  assert.equal(payload.model_call_receipts.length, 1);
  assert.deepEqual(payload.model_call_receipts[0], {
    schema: "revit-operator.model-call-receipt.v1",
    call_id: payload.model_call_receipts[0].call_id,
    provider: "openai",
    route: "desktop_computer",
    requested_model: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    started_at_utc: payload.model_call_receipts[0].started_at_utc,
    duration_ms: payload.model_call_receipts[0].duration_ms,
    success: false,
    response_status: null,
    error_code: "mock_provider_failure",
    tokens: {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null
    }
  });
  assert.match(payload.model_call_receipts[0].call_id, /^[0-9a-f-]{36}$/);
  assert.match(payload.model_call_receipts[0].started_at_utc, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Number.isInteger(payload.model_call_receipts[0].duration_ms), true);
  assert.equal(responseText.includes(rawProviderMessage), false);
  assert.equal(responseText.includes("sensitive prompt"), false);
  assert.equal(responseText.includes("sk-private"), false);
});
