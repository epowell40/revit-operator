import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countSheetsViaSafeRead,
  SAFE_READ_FAILURE_SCHEMA,
  SAFE_READ_REQUEST_HEADERS,
  SAFE_READ_REQUEST_HEADER_NAMES,
  SAFE_READ_RESPONSE_MAX_BYTES,
  SAFE_READ_SHEETS_COUNT_BODY,
  SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA,
  SafeReadCallError,
  safeReadClientSessionId,
  safeReadFailurePayload
} from "./safeReadClient.js";
import {
  discoverSafeReadInstance,
  SafeReadDiscoveryError,
  SAFE_READ_EXECUTOR_ID,
  SAFE_READ_INSTANCE_SCHEMA,
  SAFE_READ_MAX_PORT,
  SAFE_READ_MIN_PORT,
  SAFE_READ_PRODUCT_ID,
  SAFE_READ_RESERVED_PATH_PREFIX,
  SAFE_READ_SHEETS_COUNT_PATH,
  SAFE_READ_SHEETS_COUNT_ROUTE_ID
} from "./safeReadDiscovery.js";
import { runWithRevitToolAlias, ToolExposurePolicyError } from "./toolExposurePolicy.js";

const guid = "4a3dd9c3-8eb0-4abe-a706-e519a2ef4a3d";
const documentGuid = "e7ea87e5-e78f-4c9f-8e5f-e89726b00d2c";
const hash = `sha256:${"a".repeat(64)}`;
const startupToken = "A".repeat(43);
const SAFE_READ_CONTRACT = JSON.parse(fs.readFileSync(
  path.resolve("..", "..", "contracts", "safe-read", "contract.v1.json"),
  "utf8"
)) as {
  identity: { product_id: string; executor_id: string };
  route: Record<string, unknown> & {
    route_id: string; method: string; path: string; reserved_path_prefix: string;
    canonical_body_json: string; body_sha256: string; request_hash: string;
    effect_hash: string; route_contract_sha256: string; policy_sha256: string;
    effect: unknown; policy: unknown;
  };
  headers: string[];
  schemas: Record<string, string>;
  keys: Record<string, string[]>;
  bounds: Record<string, number>;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

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

async function rejectionWithin(promise: Promise<unknown>, maxMs = 250): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(
      value => ({ state: "fulfilled" as const, value }),
      error => ({ state: "rejected" as const, error })
    ),
    new Promise<{ state: "timeout" }>(resolve => {
      timer = setTimeout(() => resolve({ state: "timeout" }), maxMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (result.state === "timeout") assert.fail(`SafeRead request did not settle within ${maxMs} ms.`);
  if (result.state === "fulfilled") assert.fail("SafeRead request unexpectedly fulfilled.");
  return result.error;
}

test("SafeRead runtime values and computed hashes match the canonical cross-runtime fixture", () => {
  const contract = SAFE_READ_CONTRACT;
  const canonicalBody = JSON.parse(contract.route.canonical_body_json) as unknown;
  assert.equal(canonicalSha256(canonicalBody), contract.route.body_sha256);
  assert.equal(canonicalSha256({ method: contract.route.method, path: contract.route.path, body: canonicalBody }), contract.route.request_hash);
  assert.equal(canonicalSha256(contract.route.effect), contract.route.effect_hash);
  assert.equal(canonicalSha256({
    route_id: contract.route.route_id,
    method: contract.route.method,
    path: contract.route.path,
    canonical_body_json: contract.route.canonical_body_json,
    request_hash: contract.route.request_hash,
    effect_hash: contract.route.effect_hash
  }), contract.route.route_contract_sha256);
  assert.equal(canonicalSha256(contract.route.policy), contract.route.policy_sha256);
  assert.deepEqual({
    instance_schema: SAFE_READ_INSTANCE_SCHEMA,
    product_id: SAFE_READ_PRODUCT_ID,
    executor_id: SAFE_READ_EXECUTOR_ID,
    route_id: SAFE_READ_SHEETS_COUNT_ROUTE_ID,
    route: SAFE_READ_SHEETS_COUNT_PATH,
    reserved_path_prefix: SAFE_READ_RESERVED_PATH_PREFIX,
    body: SAFE_READ_SHEETS_COUNT_BODY,
    success_schema: SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA,
    failure_schema: SAFE_READ_FAILURE_SCHEMA,
    headers: SAFE_READ_REQUEST_HEADERS
  }, {
    instance_schema: contract.schemas.discovery,
    product_id: contract.identity.product_id,
    executor_id: contract.identity.executor_id,
    route_id: contract.route.route_id,
    route: contract.route.path,
    reserved_path_prefix: contract.route.reserved_path_prefix,
    body: contract.route.canonical_body_json,
    success_schema: contract.schemas.success,
    failure_schema: contract.schemas.failure,
    headers: {
      startupToken: contract.headers[0],
      hostInstanceId: contract.headers[1],
      documentSessionId: contract.headers[2],
      clientSessionId: contract.headers[3],
      requestId: contract.headers[4],
      attemptId: contract.headers[5]
    }
  });
  assert.deepEqual(SAFE_READ_REQUEST_HEADER_NAMES, contract.headers);
  assert.deepEqual([SAFE_READ_MIN_PORT, SAFE_READ_MAX_PORT, SAFE_READ_RESPONSE_MAX_BYTES], [
    contract.bounds.minimum_port, contract.bounds.maximum_port, contract.bounds.host_response_max_bytes
  ]);
  assert.deepEqual(Object.keys(instance()), contract.keys.discovery);
  assert.deepEqual(Object.keys((instance().runtime_tuple as Record<string, unknown>)), contract.keys.runtime_tuple);
  assert.deepEqual(Object.keys((instance().document as Record<string, unknown>)), contract.keys.document);
});

test("SafeRead discovery accepts one live exact fixture and rejects stale, malformed, ambiguous, and non-loopback publications", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-discovery-"));
  try {
    writeInstance(root, instance());
    const discovered = discoverSafeReadInstance({ instancesDirectory: root, revitYear: 2024, isPidAlive: pid => pid === 4242 });
    assert.equal(discovered.endpoint, "http://127.0.0.1:5040/");
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
      ["userinfo", instance(5040, { endpoint: "http://token@127.0.0.1:5040/" })],
      ["missing-trailing-slash", instance(5040, { endpoint: "http://127.0.0.1:5040" })],
      ["endpoint-path", instance(5040, { endpoint: "http://127.0.0.1:5040/base/" })]
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
      assert.deepEqual(Object.keys(headers).sort(), ["Content-Type", ...SAFE_READ_REQUEST_HEADER_NAMES].sort());
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

test("SafeRead preserves a retryable pre-dispatch host rejection without changing its outcome fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-pre-dispatch-"));
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
            code: "safe_read_busy",
            error: "The certified host is busy.",
            retryable: true,
            request_dispatched: false,
            outcome_unknown: false,
            phase: "admission"
          }), { status: 409 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_busy"
        && error.retryable === true
        && error.request_dispatched === false
        && error.outcome_unknown === false
        && error.phase === "admission"
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

test("SafeRead classifies definite connect failures and connect deadlines separately from transport loss after send", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-transport-"));
  const restore = laboratoryEnv();
  try {
    writeInstance(root, instance());
    for (const [cause, expected] of [
      [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), { code: "safe_read_unavailable", phase: "transport_connect", retryable: true, dispatched: false, unknown: false }],
      [Object.assign(new Error("connect deadline"), { code: "UND_ERR_CONNECT_TIMEOUT" }), { code: "safe_read_unavailable", phase: "transport_connect", retryable: true, dispatched: false, unknown: false }],
      [Object.assign(new Error("reset"), { code: "ECONNRESET" }), { code: "safe_read_transport_outcome_unknown", phase: "transport", retryable: false, dispatched: true, unknown: true }]
    ] as const) {
      await assert.rejects(
        runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
          discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
          fetch: async () => { throw cause; }
        })),
        (error: unknown) => error instanceof SafeReadCallError
          && error.code === expected.code
          && error.phase === expected.phase
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
      JSON.stringify({ schema: SAFE_READ_FAILURE_SCHEMA, code: "busy", error: "Busy.", retryable: true, request_dispatched: true, outcome_unknown: true, phase: "dispatch" }),
      JSON.stringify({ schema: SAFE_READ_FAILURE_SCHEMA, code: "busy", error: "Busy.", retryable: false, request_dispatched: false, outcome_unknown: true, phase: "dispatch" }),
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

test("SafeRead denies redirects and declared oversized responses without following or retrying", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-response-metadata-"));
  const restore = laboratoryEnv();
  try {
    writeInstance(root, instance());
    for (const responseFactory of [
      () => new Response("", { status: 302, headers: { location: "http://127.0.0.1:5041/revit/certified/sheets/count" } }),
      () => new Response("{}", { status: 200, headers: { "content-length": String(SAFE_READ_RESPONSE_MAX_BYTES + 1) } })
    ]) {
      let calls = 0;
      await assert.rejects(
        runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
          discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
          fetch: async (_input, init) => {
            calls += 1;
            assert.equal(init?.redirect, "error");
            return responseFactory();
          }
        })),
        (error: unknown) => error instanceof SafeReadCallError
          && error.code === "safe_read_invalid_response"
          && error.retryable === false
          && error.request_dispatched === true
          && error.outcome_unknown === true
      );
      assert.equal(calls, 1);
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
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_transport_outcome_unknown"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
        && error.phase === "transport"
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead total deadline includes delayed response headers and makes exactly one call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-delayed-headers-"));
  const restore = laboratoryEnv();
  let calls = 0;
  try {
    writeInstance(root, instance());
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 10,
        fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted before headers", "AbortError")), { once: true });
        })
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_transport_outcome_unknown"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
        && error.phase === "transport"
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead total deadline cancels a body that stalls after headers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-headers-stall-"));
  const restore = laboratoryEnv();
  let calls = 0;
  let cancellations = 0;
  try {
    writeInstance(root, instance());
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 15,
        fetch: async () => {
          calls += 1;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"schema":')); },
            cancel() { cancellations += 1; }
          }), { status: 200 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_transport_outcome_unknown"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
        && error.phase === "transport"
    );
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead total deadline cancels byte-dribble bodies instead of resetting per chunk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-byte-dribble-"));
  const restore = laboratoryEnv();
  let calls = 0;
  let cancellations = 0;
  let interval: NodeJS.Timeout | undefined;
  try {
    writeInstance(root, instance());
    const body = new TextEncoder().encode(`{"schema":"${SAFE_READ_SHEETS_COUNT_RESPONSE_SCHEMA}","count":7}`);
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 20,
        fetch: async () => {
          calls += 1;
          let offset = 0;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              interval = setInterval(() => {
                if (offset >= body.byteLength) {
                  if (interval) clearInterval(interval);
                  controller.close();
                  return;
                }
                controller.enqueue(body.slice(offset, offset + 1));
                offset += 1;
              }, 4);
            },
            cancel() {
              cancellations += 1;
              if (interval) clearInterval(interval);
            }
          }), { status: 200 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_transport_outcome_unknown"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
    );
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  } finally {
    if (interval) clearInterval(interval);
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SafeRead treats an abort mid-body as one dispatched outcome-unknown call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-abort-mid-body-"));
  const restore = laboratoryEnv();
  let calls = 0;
  try {
    writeInstance(root, instance());
    await assert.rejects(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 100,
        fetch: async () => {
          calls += 1;
          let pulls = 0;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"schema":'));
              else controller.error(new DOMException("peer aborted", "AbortError"));
            }
          }), { status: 200 });
        }
      })),
      (error: unknown) => error instanceof SafeReadCallError
        && error.code === "safe_read_transport_outcome_unknown"
        && error.retryable === false
        && error.request_dispatched === true
        && error.outcome_unknown === true
        && error.phase === "transport"
    );
    assert.equal(calls, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead rejects oversized, truncated, and malformed bodies with no retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-body-failures-"));
  const restore = laboratoryEnv();
  let oversizedCancellations = 0;
  try {
    writeInstance(root, instance());
    const cases = [
      {
        expectedCode: "safe_read_invalid_response",
        response: () => new Response(new ReadableStream<Uint8Array>({
          cancel() { oversizedCancellations += 1; }
        }), { status: 200, headers: { "content-length": String(SAFE_READ_RESPONSE_MAX_BYTES + 1) } })
      },
      {
        expectedCode: "safe_read_transport_outcome_unknown",
        response: () => new Response("{}", { status: 200, headers: { "content-length": "3" } })
      },
      {
        expectedCode: "safe_read_invalid_response",
        response: () => new Response("{malformed", { status: 200 })
      }
    ] as const;
    for (const scenario of cases) {
      let calls = 0;
      await assert.rejects(
        runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
          discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
          fetch: async () => { calls += 1; return scenario.response(); }
        })),
        (error: unknown) => error instanceof SafeReadCallError
          && error.code === scenario.expectedCode
          && error.retryable === false
          && error.request_dispatched === true
          && error.outcome_unknown === true
      );
      assert.equal(calls, 1);
    }
    assert.equal(oversizedCancellations, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead declared-oversize response settles when body cancellation never does", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-noncooperative-declared-"));
  const restore = laboratoryEnv();
  let calls = 0;
  let cancellations = 0;
  try {
    writeInstance(root, instance());
    const error = await rejectionWithin(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        fetch: async () => {
          calls += 1;
          return new Response(new ReadableStream<Uint8Array>({
            cancel() {
              cancellations += 1;
              return new Promise<void>(() => undefined);
            }
          }), { status: 200, headers: { "content-length": String(SAFE_READ_RESPONSE_MAX_BYTES + 1) } });
        }
      }))
    );
    assert.ok(error instanceof SafeReadCallError);
    assert.equal(error.code, "safe_read_invalid_response");
    assert.equal(error.retryable, false);
    assert.equal(error.request_dispatched, true);
    assert.equal(error.outcome_unknown, true);
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead streamed-oversize response settles when reader cancellation never does", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-noncooperative-streamed-"));
  const restore = laboratoryEnv();
  let calls = 0;
  let cancellations = 0;
  try {
    writeInstance(root, instance());
    const error = await rejectionWithin(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        fetch: async () => {
          calls += 1;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(SAFE_READ_RESPONSE_MAX_BYTES + 1)); },
            cancel() {
              cancellations += 1;
              return new Promise<void>(() => undefined);
            }
          }), { status: 200 });
        }
      }))
    );
    assert.ok(error instanceof SafeReadCallError);
    assert.equal(error.code, "safe_read_invalid_response");
    assert.equal(error.retryable, false);
    assert.equal(error.request_dispatched, true);
    assert.equal(error.outcome_unknown, true);
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SafeRead stalled response settles at the deadline when reader cancellation never does", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-noncooperative-stall-"));
  const restore = laboratoryEnv();
  let calls = 0;
  let cancellations = 0;
  try {
    writeInstance(root, instance());
    const error = await rejectionWithin(
      runWithRevitToolAlias("revit_count_sheets_certified", () => countSheetsViaSafeRead({
        discovery: { instancesDirectory: root, revitYear: 2024, isPidAlive: () => true },
        timeoutMs: 10,
        fetch: async () => {
          calls += 1;
          return new Response(new ReadableStream<Uint8Array>({
            cancel() {
              cancellations += 1;
              return new Promise<void>(() => undefined);
            }
          }), { status: 200 });
        }
      }))
    );
    assert.ok(error instanceof SafeReadCallError);
    assert.equal(error.code, "safe_read_transport_outcome_unknown");
    assert.equal(error.retryable, false);
    assert.equal(error.request_dispatched, true);
    assert.equal(error.outcome_unknown, true);
    assert.equal(error.phase, "transport");
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  } finally { restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
