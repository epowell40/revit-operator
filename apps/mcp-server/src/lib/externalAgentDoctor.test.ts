import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_TRANSPORT_ALGORITHM,
  NATIVE_TRANSPORT_CONTENT_TYPE,
  NATIVE_TRANSPORT_PATH,
  NATIVE_TRANSPORT_VERSION
} from "./nativeTransport.js";

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

async function runDoctor(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = fileURLToPath(new URL("../cli/externalAgent.js", import.meta.url));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "doctor"], { env, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

test("external-agent doctor uses ROSB/1 and never sends raw Revit credentials outside exact laboratory mode", async () => {
  let requests = 0;
  let observed: { url?: string; method?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
  const server = http.createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      observed = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8")
      };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{\"status\":\"hostile plaintext\"}");
    });
  });
  const port = await listen(server);
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "external-agent-doctor-localappdata-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "external-agent-doctor-workspace-"));
  const receiptDirectory = path.join(localAppData, "RevitOperator");
  fs.mkdirSync(receiptDirectory, { recursive: true });
  fs.writeFileSync(path.join(receiptDirectory, "bridge_transport.v1.json"), JSON.stringify({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url: `http://127.0.0.1:${port}`,
    server_epoch: Buffer.alloc(32, 7).toString("base64url")
  }), "utf8");

  const childEnv = { ...process.env };
  delete childEnv.OPERATOR_TOOL_EXPOSURE_PROFILE;
  Object.assign(childEnv, {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_TOKEN: "doctor-token-0123456789abcdef0000",
    LOCALAPPDATA: localAppData,
    OPERATOR_WORKSPACE_ROOT: workspace,
    REVIT_BRIDGE_URL: "http://127.0.0.1:1"
  });
  try {
    const result = await runDoctor(childEnv);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, false);
    assert.match(report.bridgeError, /unauthenticated content type/);
    assert.equal(requests, 1);
    assert.equal(observed.url, NATIVE_TRANSPORT_PATH);
    assert.equal(observed.method, "POST");
    assert.equal(observed.headers?.["content-type"], NATIVE_TRANSPORT_CONTENT_TYPE);
    assert.equal(observed.headers?.["x-operator-token"], undefined);
    assert.equal(observed.headers?.["x-operator-correlation-id"], undefined);
    assert.equal(observed.headers?.["x-operator-write-grant"], undefined);
    assert.doesNotMatch(observed.body ?? "", /doctor-token|revit\/ping|write-grant-status/);
  } finally {
    await close(server);
  }
});
