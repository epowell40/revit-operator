import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countSheetsViaSafeRead,
  SAFE_READ_FAILURE_SCHEMA,
  SAFE_READ_RESPONSE_MAX_BYTES,
  SAFE_READ_SHEETS_COUNT_BODY,
  SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA,
  SafeReadCallError,
  safeReadClientSessionId,
  safeReadFailurePayload
} from "./safeReadClient.js";
import { discoverSafeReadInstance, SafeReadDiscoveryError } from "./safeReadDiscovery.js";
import { runWithRevitToolAlias, ToolExposurePolicyError } from "./toolExposurePolicy.js";

const guid = "4a3dd9c3-8eb0-4abe-a706-e519a2ef4a3d";
const documentGuid = "e7ea87e5-e78f-4c9f-8e5f-e89726b00d2c";
const hash = `sha256:${"a".repeat(64)}`;
const startupToken = "A".repeat(43);

function instance(port = 5040, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schema: "revit-operator.safe-read.instance.v1",
    product_id: "aafaa2c0-43f1-42a0-a6b4-d9a0c5f5ce0e",
    host_instance_id: guid,
    executor_id: "revit-operator.safe-read-host.v1",
    pid: 4242,
    revit_year: 2024,
    route_id: "safe_read.sheet_count.v1",
    route: "/revit/certified/sheets/count",
    endpoint: `http://127.0.0.1:${port}/`,
    startup_token: startupToken,
    runtime_attestation_sha256: hash,
    runtime_tuple: {
      host_content_sha256: hash,
      host_mvid: guid,
      revit_api_content_sha256: hash,
      revit_api_mvid: guid,
      revit_version: "2024.2"
    },
    document: { project_fingerprint: hash, document_session_id: documentGuid }
  };
  return { ...base, ...overrides };
}

function writeInstance(root: string, value: unknown, name = `${guid}.json`): void {
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

test("SafeRead discovery accepts one live exact fixture and rejects stale, malformed, ambiguous, and non-loopback publications", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-discovery-"));
  try {
    writeInstance(root, instance());
    const discovered = discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: pid => pid === 4242 });
    assert.equal(discovered.endpoint, "http://127.0.0.1:5040");
    assert.equal(discovered.document.document_session_id, documentGuid);

    for (const [name, value] of [
      ["wrong-schema", instance(5040, { schema: "unexpected" })],
      ["extra-field", { ...instance(), operator_token: "must-not-be-read" }],
      ["wrong-guid", instance(5040, { host_instance_id: guid.toUpperCase() })],
      ["wrong-year", instance(5040, { revit_year: 2025 })],
      ["wrong-route", instance(5040, { route_id: "safe_read.other.v1" })],
      ["wrong-attestation", instance(5040, { runtime_attestation_sha256: `${hash}0` })],
      ["wrong-port-low", instance(5039)],
      ["wrong-port-high", instance(5051)],
      ["non-loopback", instance(5040, { endpoint: "http://localhost:5040/" })],
      ["userinfo", instance(5040, { endpoint: "http://token@127.0.0.1:5040/" })]
    ] as const) {
      const isolated = fs.mkdtempSync(path.join(os.tmpdir(), `safe-read-${name}-`));
      try {
        const filename = name === "wrong-guid" ? `${guid.toUpperCase()}.json` : `${guid}.json`;
        writeInstance(isolated, value, filename);
        assert.throws(() => discoverSafeReadInstance({ instancesDirectory: isolated, revitYear: 2024, isPidAlive: () => true }), SafeReadDiscoveryError, name);
      } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
    }

    fs.rmSync(path.join(root, `${guid}.json`));
    writeInstance(root, instance(5040, { pid: 9 }));
    assert.throws(() => discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: () => false }), /No live, valid/);
    const otherGuid = "779886ce-266f-4477-8f6a-64f775c5379a";
    writeInstance(root, instance(5041, { host_instance_id: otherGuid }), `${otherGuid}.json`);
    assert.throws(() => discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: () => true }), (error: unknown) => error instanceof SafeReadDiscoveryError && error.code === "safe_read_discovery_ambiguous");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("laboratory SafeRead alias sends exact bytes, exact headers, stable/per-call IDs, and no nonce or fallback controls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-client-"));
  const restore = laboratoryEnv();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let idIndex = 0;
  const ids = [
    "0d8f8c33-23b3-4342-8380-47a3b7198384",
    "516186e0-9ed5-41f4-b610-103d12296b4e",
    "f763145f-6397-4023-8359-e09b7cf807cc",
    "398e4cbd-e36a-4c3e-8d6b-fc17e92c662d"
  ];
  try {
    writeInstance(root, instance());
    const invoke = () => runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
      discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
      idFactory: () => ids[idIndex++]!,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init! });
        return new Response(`{"schema":"${SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA}","count":7}`, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }));
    assert.deepEqual(await invoke(), { schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA, count: 7 });
    assert.deepEqual(await invoke(), { schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA, count: 7 });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "http://127.0.0.1:5040/revit/certified/sheets/count");
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "error");
      assert.equal(call.init.body, SAFE_READ_SHEETS_COUNT_BODY);
      assert.ok(call.init.signal instanceof AbortSignal);
      const headers = call.init.headers as Record<string, string>;
      assert.deepEqual(Object.keys(headers).sort(), [
        "Content-Type",
        "X-RevitOperator-SafeRead-Attempt-Id",
        "X-RevitOperator-SafeRead-Client-Session-Id",
        "X-RevitOperator-SafeRead-Document-Session-Id",
        "X-RevitOperator-SafeRead-Host-Instance-Id",
        "X-RevitOperator-SafeRead-Request-Id",
        "X-RevitOperator-SafeRead-Startup-Token"
      ].sort());
      assert.equal(headers["X-RevitOperator-SafeRead-Startup-Token"], startupToken);
      assert.equal(headers["X-RevitOperator-SafeRead-Host-Instance-Id"], guid);
      assert.equal(headers["X-RevitOperator-SafeRead-Document-Session-Id"], documentGuid);
      assert.equal(headers["X-RevitOperator-SafeRead-Client-Session-Id"], safeReadClientSessionId());
      assert.equal(Object.keys(headers).some(name => /nonce/i.test(name)), false);
    }
    assert.equal((calls[0]!.init.headers as Record<string, string>)["X-RevitOperator-SafeRead-Request-Id"], ids[0]);
    assert.equal((calls[0]!.init.headers as Record<string, string>)["X-RevitOperator-SafeRead-Attempt-Id"], ids[1]);
    assert.equal((calls[1]!.init.headers as Record<string, string>)["X-RevitOperator-SafeRead-Request-Id"], ids[2]);
    assert.equal((calls[1]!.init.headers as Record<string, string>)["X-RevitOperator-SafeRead-Attempt-Id"], ids[3]);
  } finally {
    restore();
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

test("SafeRead preserves exact structured failures and never automatically retries a dispatched final attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-terminal-"));
  const restore = laboratoryEnv();
  let calls = 0;
  try {
    writeInstance(root, instance());
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            schema: SAFE_READ_FAILURE_SCHEMA,
            code: "authorization_unavailable",
            error: "Final capability state is unavailable.",
            retryable: false,
            request_dispatched: true,
            outcome_unknown: true,
            phase: "authorization_final"
          }), { status: 503 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "authorization_unavailable"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
        && error.phase === "authorization_final"
        && error.failure?.schema === SAFE_READ_FAILURE_SCHEMA
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead MCP failure projection preserves structured outcome fields without credentials", () => {
  const error = new SafeReadCallError(
    "safe_read_transport_outcome_unknown",
    "Transport outcome requires reconciliation.",
    false,
    true,
    true,
    "transport"
  );
  assert.deepEqual(safeReadFailurePayload(error), {
    schema: SAFE_READ_FAILURE_SCHEMA,
    code: "safe_read_transport_outcome_unknown",
    error: "Transport outcome requires reconciliation.",
    retryable: false,
    request_dispatched: true,
    outcome_unknown: true,
    phase: "transport"
  });
  assert.doesNotMatch(JSON.stringify(safeReadFailurePayload(error)), new RegExp(startupToken));
});

test("SafeRead classifies definite connect failures separately from transport loss after send", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-transport-"));
  const restore = laboratoryEnv();
  try {
    writeInstance(root, instance());
    for (const [cause, expected] of [
      [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), { retryable: true, dispatched: false, unknown: false }],
      [Object.assign(new Error("reset"), { code: "ECONNRESET" }), { retryable: false, dispatched: true, unknown: true }]
    ] as const) {
      await assert.rejects(
        runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
          discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
          fetch: async () => { throw cause; }
        })),
        (error: unknown) => error instanceof SafeReadCallError
          && error.retryable === expected.retryable
          && error.request_dispatched === expected.dispatched
          && error.outcome_unknown === expected.unknown
          && !error.message.includes(startupToken)
      );
    }
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead enforces the response byte cap and exact success/failure schemas", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-response-"));
  const restore = laboratoryEnv();
  try {
    writeInstance(root, instance());
    const invalidBodies = [
      JSON.stringify({ schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA, count: 100001 }),
      JSON.stringify({ schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA, count: 1, extra: true }),
      JSON.stringify({ schema: SAFE_READ_FAILURE_SCHEMA, code: "busy", error: "Busy.", retryable: true, request_dispatched: false, outcome_unknown: false }),
      "x".repeat(SAFE_READ_RESPONSE_MAX_BYTES + 1)
    ];
    for (const body of invalidBodies) {
      await assert.rejects(
        runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
          discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
          fetch: async () => new Response(body, { status: body.startsWith("x") ? 200 : 409 })
        })),
        (error: unknown) => error instanceof SafeReadCallError
          && error.code === "safe_read_invalid_response"
          && error.retryable === false
          && error.request_dispatched === true
          && error.outcome_unknown === true
      );
    }
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead deadline aborts once and remains outcome-unknown without fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-deadline-"));
  const restore = laboratoryEnv();
  let calls = 0;
  try {
    writeInstance(root, instance());
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 5,
        fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        })
      })),
      (error: unknown) => error instanceof SafeReadCallError && error.retryable === false && error.outcome_unknown === true
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
