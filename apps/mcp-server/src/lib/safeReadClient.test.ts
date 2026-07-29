import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { countSheetsViaSafeRead, SAFE_READ_SHEETS_COUNT_BODY, SafeReadCallError } from "./safeReadClient.js";
import { discoverSafeReadInstance, SafeReadDiscoveryError } from "./safeReadDiscovery.js";
import { runWithRevitToolAlias, ToolExposurePolicyError } from "./toolExposurePolicy.js";

const guid = "4a3dd9c3-8eb0-4abe-a706-e519a2ef4a3d";
const hash = `sha256:${"a".repeat(64)}`;

function instance(port: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schema: "revit-operator.safe-read-instance.v1",
    host_instance_id: guid,
    executor_id: "revit-2024-4242",
    pid: 4242,
    revit_year: 2024,
    route_id: "revit_count_sheets_certified.v1",
    route: "/revit/certified/sheets/count",
    endpoint: `http://127.0.0.1:${port}`,
    startup_token: "opaque-test-token+/=",
    runtime_attestation_sha256: hash,
    runtime_tuple: {
      host_content_sha256: hash,
      host_mvid: guid,
      revit_api_content_sha256: hash,
      revit_api_mvid: guid,
      revit_version: "2024.2"
    },
    document: { project_fingerprint: hash, document_session_id: guid },
    attestation: {
      schema: "revit-operator.safe-read-attestation.v1",
      host_instance_id: guid,
      route_id: "revit_count_sheets_certified.v1",
      document_session_id: guid,
      runtime_attestation_sha256: hash
    }
  };
  return { ...base, ...overrides };
}

function writeInstance(root: string, value: unknown, name = "host.json"): void {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value), "utf8");
}

function laboratoryEnv(): () => void {
  const before = {
    mode: process.env.REVIT_OPERATOR_MODE,
    profile: process.env.OPERATOR_TOOL_EXPOSURE_PROFILE,
    transport: process.env.OPERATOR_REVIT_TRANSPORT,
    bridge: process.env.REVIT_BRIDGE_URL
  };
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  process.env.OPERATOR_REVIT_TRANSPORT = "courier";
  process.env.REVIT_BRIDGE_URL = "http://127.0.0.1:1";
  return () => {
    for (const [key, value] of Object.entries(before)) {
      const envKey = key === "mode" ? "REVIT_OPERATOR_MODE" : key === "profile" ? "OPERATOR_TOOL_EXPOSURE_PROFILE" : key === "transport" ? "OPERATOR_REVIT_TRANSPORT" : "REVIT_BRIDGE_URL";
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("SafeRead discovery accepts one live exact fixture and rejects stale, malformed, ambiguous, and non-loopback publications", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-discovery-"));
  try {
    writeInstance(root, instance(4545));
    const discovered = discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: pid => pid === 4242 });
    assert.equal(discovered.endpoint, "http://127.0.0.1:4545");
    assert.equal(discovered.document.document_session_id, guid);

    for (const [name, value] of [
      ["wrong-schema", instance(4545, { schema: "unexpected" })],
      ["wrong-guid", instance(4545, { host_instance_id: "not-a-guid" })],
      ["wrong-year", instance(4545, { revit_year: 2025 })],
      ["wrong-route", instance(4545, { route: "/revit/sheets" })],
      ["wrong-attestation", instance(4545, { attestation: { schema: "wrong" } })],
      ["non-loopback", instance(4545, { endpoint: "http://example.test:4545" })],
      ["userinfo", instance(4545, { endpoint: "http://token@127.0.0.1:4545" })]
    ] as const) {
      const isolated = fs.mkdtempSync(path.join(os.tmpdir(), `safe-read-${name}-`));
      try {
        writeInstance(isolated, value);
        assert.throws(() => discoverSafeReadInstance({ instancesDirectory: isolated, revitYear: 2024, isPidAlive: () => true }), SafeReadDiscoveryError, name);
      } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
    }

    fs.rmSync(path.join(root, "host.json"));
    writeInstance(root, instance(4545, { pid: 9 }));
    assert.throws(() => discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: () => false }), /No live, valid/);
    writeInstance(root, instance(4546), "other.json");
    assert.throws(() => discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: () => true }), (error: unknown) => error instanceof SafeReadDiscoveryError && error.code === "safe_read_discovery_ambiguous");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("laboratory SafeRead alias uses exact bytes and dedicated host headers without bridge or courier fallback", async () => {
  let requestCount = 0;
  let observedBody = "";
  let observedHeaders: http.IncomingHttpHeaders = {};
  const host = http.createServer(async (request, response) => {
    requestCount += 1;
    observedHeaders = request.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observedBody = Buffer.concat(chunks).toString("utf8");
    assert.equal(request.url, "/revit/certified/sheets/count");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ count: 7, receipt_id: "fixture-receipt" }));
  });
  const port = await listen(host);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-client-"));
  const restore = laboratoryEnv();
  try {
    writeInstance(root, instance(port));
    const result = await runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
      discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true }
    }));
    assert.deepEqual(result, { count: 7, receipt_id: "fixture-receipt" });
    assert.equal(requestCount, 1);
    assert.equal(observedBody, SAFE_READ_SHEETS_COUNT_BODY);
    assert.equal(observedHeaders["x-revit-operator-safe-read-startup-token"], "opaque-test-token+/=");
    assert.equal(observedHeaders["x-revit-operator-safe-read-host-instance-id"], guid);
    assert.equal(observedHeaders["x-revit-operator-safe-read-document-session-id"], guid);
    assert.doesNotMatch(JSON.stringify(result), /opaque-test-token/);
  } finally {
    restore();
    await close(host);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SafeRead certified admission denies the new alias before discovery or transport", async () => {
  const before = { mode: process.env.REVIT_OPERATOR_MODE, profile: process.env.OPERATOR_TOOL_EXPOSURE_PROFILE };
  process.env.REVIT_OPERATOR_MODE = "hosted";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  try {
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({ discovery: { instancesDirectory: "Z:\\missing", isPidAlive: () => true } })),
      (error: unknown) => error instanceof ToolExposurePolicyError
    );
  } finally {
    if (before.mode === undefined) delete process.env.REVIT_OPERATOR_MODE; else process.env.REVIT_OPERATOR_MODE = before.mode;
    if (before.profile === undefined) delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE; else process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = before.profile;
  }
});

test("SafeRead final failures are terminal and never automatically retried", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-terminal-"));
  const restore = laboratoryEnv();
  let calls = 0;
  try {
    writeInstance(root, instance(4545));
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        fetch: async () => {
          calls += 1;
          return new Response("consumed", { status: 409 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError && error.retryable === false && error.outcome_unknown === true
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
