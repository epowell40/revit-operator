import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { callRevit, RevitBridgeCallError } from "./revitClient.js";
import { runWithRevitToolAlias, ToolExposurePolicyError } from "./toolExposurePolicy.js";
import {
  NATIVE_TRANSPORT_ALGORITHM,
  NATIVE_TRANSPORT_PATH,
  NATIVE_TRANSPORT_VERSION
} from "./nativeTransport.js";

const sourcePolicyPath = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
  ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
  : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");
const sourcePolicyHash = (JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8")) as { policy_hash: string }).policy_hash;

function canonicalTestValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.replace(/\r\n?/g, "\n").normalize("NFC"), item] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalTestValue(item)]));
  }
  return value;
}

function canonicalTestDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalTestValue(value)), "utf8").digest("hex")}`;
}

function writePingExposurePolicy(): { policyPath: string; policyHash: string } {
  const policy = JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8"));
  const ping = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/ping");
  ping.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  for (const record of policy.records) {
    const { policy_record_hash: _oldRecordHash, ...recordPayload } = record;
    record.policy_record_hash = canonicalTestDigest(recordPayload);
  }
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = canonicalTestDigest(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-client-policy-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash };
}

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
    runtimeMode: process.env.REVIT_OPERATOR_MODE,
    exposureProfile: process.env.OPERATOR_TOOL_EXPOSURE_PROFILE,
    localAppData: process.env.LOCALAPPDATA,
    exposurePolicyPath: process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH,
    exposurePolicyHash: process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256,
    protectedLaboratory: process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY,
  };
  process.env.REVIT_BRIDGE_URL = url;
  process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS = String(timeoutMs);
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "revit-client-test-"));
  process.env.OPERATOR_TOKEN = "r".repeat(32);
  process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "revit-client-localappdata-"));
  process.env.OPERATOR_REVIT_TRANSPORT = "direct";
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  delete process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH;
  return () => {
    for (const [name, value] of Object.entries({
      REVIT_BRIDGE_URL: previous.url,
      OPERATOR_REVIT_REQUEST_TIMEOUT_MS: previous.timeout,
      OPERATOR_WORKSPACE_ROOT: previous.workspace,
      OPERATOR_TOKEN: previous.token,
      OPERATOR_REVIT_TRANSPORT: previous.transport,
      REVIT_OPERATOR_MODE: previous.runtimeMode,
      OPERATOR_TOOL_EXPOSURE_PROFILE: previous.exposureProfile,
      LOCALAPPDATA: previous.localAppData,
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: previous.exposurePolicyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: previous.exposurePolicyHash,
      OPERATOR_CERTIFICATION_PROTECTED_LABORATORY: previous.protectedLaboratory,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function writeNativeTransportReceipt(url: string): void {
  const directory = path.join(process.env.LOCALAPPDATA!, "RevitOperator");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "bridge_transport.v1.json"), JSON.stringify({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url")
  }), "utf8");
}

test("generic Revit dispatch hard-rejects the reserved certified namespace for direct and courier transport", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    for (const transport of ["direct", "courier"] as const) {
      process.env.OPERATOR_REVIT_TRANSPORT = transport;
      for (const reservedPath of [
        "/revit/certified/sheets/count",
        "/REVIT/CERTIFIED/sheets/count",
        "/revit/certified/sheets/count?attempt=2",
        "/revit/certified%2fsheets/count",
        "/revit/certified%252fsheets/count",
        "/revit/certified%25252fsheets/count",
        "/revit/%63ertified/sheets/count",
        "/revit/certified\\sheets\\count",
        "//revit/certified/sheets/count",
        "/revit//certified///sheets/count",
        "/revit/x/../certified/sheets/count",
        "/revit/x/%2e%2e/certified/sheets/count",
        "/revit/certified"
      ]) {
        await assert.rejects(
          callRevit(reservedPath, "POST", { schema: "bypass" }),
          /reserved for the direct attested SafeRead microhost client/
        );
      }
      for (const invalidPath of [
        "/revit/certified%2fsheets/count%zz",
        "/revit/certified%25252525252525252fsheets/count"
      ]) {
        await assert.rejects(
          callRevit(invalidPath, "POST", { schema: "bypass" }),
          /malformed percent encoding|did not converge within the safety bound/
        );
      }
    }
    assert.equal(requests, 0);
  } finally {
    restore();
    await close(server);
  }
});

test("non-exact production admission denies unknown, uncertified, generic schedule, and grant-backed writes before bridge dispatch", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ unexpected: true }));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  process.env.REVIT_OPERATOR_MODE = "production ";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
    ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
    : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = sourcePolicyHash;
  fs.writeFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT!, "write_grant.json"), JSON.stringify({
    token: "cannot-override-certification",
    expires_at_utc: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");
  try {
    const calls = [
      callRevit("/revit/not-certified", "GET"),
      callRevit("/revit/ping", "GET"),
      callRevit("/revit/schedules", "POST", { action: "list", max: 10, query: "" }, { channel: "generic_call" }),
      callRevit("/revit/update-schedule-cell", "POST", {
        apply: false,
        dryRun: true,
        rowKey: "$fixture.row_key",
        targetField: "$fixture.target_field",
        value: "$fixture.value"
      }, { channel: "generic_call", workflow: "schedule_cell_update_runtime" })
    ];
    for (const call of calls) {
      await assert.rejects(call, (error: unknown) => error instanceof ToolExposurePolicyError);
    }
    assert.equal(requests, 0, "certification must run before token/grant creation or bridge fetch");

    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    await assert.rejects(callRevit("/revit/ping"), (error: unknown) => error instanceof ToolExposurePolicyError);
    assert.equal(requests, 0, "courier selection must not bypass certified admission");
  } finally {
    restore();
    await close(server);
  }
});

test("non-exact production callRevit admits only the actual bound typed alias before direct dispatch", async () => {
  let requests = 0;
  let observed: http.IncomingMessage | undefined;
  const server = http.createServer((request, response) => {
    requests += 1;
    observed = request;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  const variant = writePingExposurePolicy();
  process.env.REVIT_OPERATOR_MODE = "production ";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = variant.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = variant.policyHash;
  writeNativeTransportReceipt(`http://127.0.0.1:${port}`);
  try {
    await assert.rejects(
      runWithRevitToolAlias("revit_get_context", async () => await callRevit("/revit/ping")),
      (error: unknown) => error instanceof ToolExposurePolicyError
        && error.code === "CERT_TYPED_ALIAS_MISMATCH"
    );
    assert.equal(requests, 0);
    await assert.rejects(
      runWithRevitToolAlias("revit_ping", async () => await callRevit("/revit/ping")),
      (error: unknown) => error instanceof RevitBridgeCallError
        && error.code === "revit_bridge_invalid_response"
        && error.retryable === true
    );
    assert.equal(requests, 1);
    assert.equal(observed?.method, "POST");
    assert.equal(observed?.url, NATIVE_TRANSPORT_PATH);
    assert.equal(observed?.headers["x-operator-token"], undefined);
    assert.equal(observed?.headers["x-operator-correlation-id"], undefined);
    assert.equal(observed?.headers["x-operator-write-grant"], undefined);
  } finally {
    restore();
    await close(server);
    fs.rmSync(path.dirname(variant.policyPath), { recursive: true, force: true });
  }
});

test("explicit certification laboratory evidence uses protected native transport without claiming certified policy", async () => {
  let observed: http.IncomingMessage | undefined;
  const server = http.createServer((request, response) => {
    observed = request;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY = "1";
  writeNativeTransportReceipt(`http://127.0.0.1:${port}`);
  try {
    await assert.rejects(
      runWithRevitToolAlias("revit_ping", async () => await callRevit("/revit/ping", "GET")),
      (error: unknown) => error instanceof RevitBridgeCallError
        && error.code === "revit_bridge_invalid_response"
    );
    assert.equal(observed?.method, "POST");
    assert.equal(observed?.url, NATIVE_TRANSPORT_PATH);
    assert.equal(observed?.headers["content-type"], "application/vnd.revit-operator.native-transport+json");
    assert.equal(observed?.headers["x-operator-token"], undefined);
    assert.equal(observed?.headers["x-operator-write-grant"], undefined);
  } finally {
    restore();
    await close(server);
  }
});

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

test("exact development and laboratory direct transport preserves the legacy raw credential contract", async () => {
  let headers: http.IncomingHttpHeaders | undefined;
  const server = http.createServer((request, response) => {
    headers = request.headers;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  fs.writeFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT!, "write_grant.json"), JSON.stringify({
    token: "legacy-grant",
    expires_at_utc: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");
  try {
    assert.deepEqual(await callRevit("/revit/ping"), { ok: true });
    assert.equal(headers?.["x-operator-token"], "r".repeat(32));
    assert.equal(headers?.["x-operator-write-grant"], "legacy-grant");
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks a timed-out mutating request as non-retryable with an unknown outcome", async () => {
  const server = http.createServer(() => {
    // Deliberately leave the response open until the client deadline aborts it.
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 250);
  const started = Date.now();
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_timeout");
        assert.equal(error.transportCode, "revit_bridge_timeout");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.equal(error.outcomeUnknown, true);
        assert.match(error.message, /POST \/revit\/walls exceeded 250 ms/);
        assert.match(error.message, /may already have started/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit preserves structured outcome-unknown bridge errors", async () => {
  const bridgeError = {
    ok: false,
    error: "The Revit action deadline elapsed after execution may have started.",
    code: "revit_action_deadline_elapsed_outcome_unknown",
    retryable: false,
    phase: "revit_external_event",
    host_health: "degraded",
    opens_circuit: true,
    outcome_unknown: true,
    correlation_id: "correlation-408",
    deadline_class: "write",
    deadline_ms: 30_000,
  };
  const server = http.createServer((_request, response) => {
    response.statusCode = 408;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(bridgeError));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.transportCode, "revit_bridge_http_error");
        assert.equal(error.status, 408);
        assert.equal(error.bridgeCode, bridgeError.code);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.equal(error.phase, bridgeError.phase);
        assert.equal(error.host_health, bridgeError.host_health);
        assert.equal(error.opens_circuit, bridgeError.opens_circuit);
        assert.equal(error.correlation_id, bridgeError.correlation_id);
        assert.equal(error.deadline_class, bridgeError.deadline_class);
        assert.equal(error.deadline_ms, bridgeError.deadline_ms);
        assert.deepEqual(error.bridgeDetails, bridgeError);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps legacy unstructured HTTP errors compatible", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.transportCode, "revit_bridge_http_error");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.bridgeDetails, undefined);
        assert.match(error.message, /bridge unavailable/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

for (const status of [500, 502, 503]) {
  test(`callRevit settles an unstructured mutation HTTP ${status} as outcome unknown`, async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = status;
      response.end("legacy bridge failure");
    });
    const port = await listen(server);
    const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
    try {
      await assert.rejects(
        callRevit("/revit/walls", "POST", { action: "create" }),
        (error: unknown) => {
          assert.ok(error instanceof RevitBridgeCallError);
          assert.equal(error.status, status);
          assert.equal(error.retryable, false);
          assert.equal(error.outcome_unknown, true);
          assert.match(error.message, /legacy bridge failure/);
          return true;
        },
      );
    } finally {
      restore();
      await close(server);
    }
  });
}

test("callRevit does not replay an unstructured mutation rejection", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.statusCode = 403;
    response.end("write requires approval; X-Operator-Write-Grant missing");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.status, 403);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit honors a structured pre-dispatch rejection for a mutation", async () => {
  const bridgeError = {
    ok: false,
    code: "request_validation_failed",
    phase: "pre_dispatch",
    outcome_unknown: false,
    retryable: true,
  };
  const server = http.createServer((_request, response) => {
    response.statusCode = 422;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(bridgeError));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.status, 422);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.phase, "pre_dispatch");
        assert.deepEqual(error.bridgeDetails, bridgeError);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit settles a truncated mutation error body as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(503, {
      "content-type": "application/json",
      "content-length": "200",
    });
    response.write('{"ok":false,"code":');
    setImmediate(() => response.socket?.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /response body was unavailable or incomplete/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps a known read-only POST safely retryable", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/sheets", "POST", { action: "list" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit treats native API policy GET as read and POST as mutating", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/native-api-policy", "GET"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/native-api-policy", "POST", { policy: "certified" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    assert.equal(requests, 2);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit classifies conditional POST bodies and never retries an unknown rollback preview", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/fire-damper-audit", "POST", { command: "audit" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/move-elements", "POST", { dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/fire-damper-audit", "POST", { command: "fix", dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", JSON.stringify({ action: "list" })),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", { action: "rename_types", dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", { action: "rename_types", dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit treats a pre-connect refusal for a mutation as proven safe to retry", async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.match(error.message, /Revit may be closed or the bridge may not be listening/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("callRevit marks a mutation socket reset after the server reads its body as outcome unknown", async () => {
  let receivedBody = "";
  const server = http.createServer((request) => {
    request.setEncoding("utf8");
    request.on("data", chunk => { receivedBody += chunk; });
    request.on("end", () => request.socket.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /after dispatch could not be ruled out/);
        assert.match(error.message, /reconcile its outcome in Revit/);
        return true;
      },
    );
    assert.equal(receivedBody, JSON.stringify({ action: "create" }));
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps a read-only socket reset retryable", async () => {
  const server = http.createServer(request => {
    request.on("end", () => request.socket.destroy());
    request.resume();
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks invalid 2xx JSON for a mutation as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("not-json");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /invalid or incomplete JSON response/);
        assert.match(error.message, /may already have completed/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks truncated 2xx JSON for a mutation as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "100",
    });
    response.write('{"ok":');
    setImmediate(() => response.socket?.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps invalid 2xx JSON for a read-only call retryable", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("not-json");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});
