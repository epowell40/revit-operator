import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeDirectRevitExecution,
  DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES,
  DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES,
  DirectRevitExecutionAuthorizationError
} from "../src/capabilities/direct_revit_execution_authorization.js";
import {
  BUNDLED_TOOL_EXPOSURE_POLICY_HASH,
  loadTrustedToolExposurePolicy,
  TrustedToolExposurePolicyError
} from "../src/capabilities/trusted_tool_exposure_policy.js";
import { computeRequestHash, sha256 } from "../src/capabilities/tool_certification.js";

type PolicyFixture = { policyPath: string; policyHash: string; record: Record<string, any> };
const REQUEST_ID = "0123456789abcdef0123456789abcdef";

function rawSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function directRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "revit-operator.revit-direct-admission-request.v1",
    request_id: REQUEST_ID,
    method: "POST",
    path: "/revit/ping",
    body_present: true,
    body_json: "{}",
    ...overrides
  };
}

function writePolicy(root: string, options: {
  request?: unknown;
  method?: "GET" | "POST";
  path?: string;
  exposed?: boolean;
  secondEffect?: boolean;
} = {}): PolicyFixture {
  const request = options.request ?? {};
  const method = options.method ?? "POST";
  const toolPath = options.path ?? "/revit/ping";
  const recordBase = {
    method,
    path: toolPath,
    typed_mcp_aliases: ["revit_ping"],
    request_hash: computeRequestHash(method, toolPath, request as never),
    effect_hash: `sha256:${"2".repeat(64)}`,
    evidence_record_hash: `sha256:${"3".repeat(64)}`,
    highest_cumulative_level: "L4",
    observed_levels: ["L0", "L1", "L2", "L3", "L4"],
    visibility: "candidate",
    channels: {
      search: { exposed: false, required_level: "L3", reason_codes: ["CERT_CHANNEL_NOT_REQUESTED"] },
      generic_call: {
        exposed: options.exposed !== false,
        required_level: "L4",
        reason_codes: [options.exposed === false ? "CERT_EVIDENCE_REVOKED" : "CERTIFIED"]
      },
      typed_mcp: { exposed: false, required_level: "L4", reason_codes: ["CERT_CHANNEL_NOT_REQUESTED"] },
      deterministic_workflow: { exposed: false, required_level: "L4", reason_codes: ["CERT_CHANNEL_NOT_REQUESTED"] }
    }
  };
  const record = { ...recordBase, policy_record_hash: sha256(recordBase as never) };
  const records: Record<string, unknown>[] = [record];
  if (options.secondEffect) {
    const ambiguousBase = {
      ...recordBase,
      effect_hash: `sha256:${"5".repeat(64)}`,
      evidence_record_hash: `sha256:${"6".repeat(64)}`
    };
    records.push({ ...ambiguousBase, policy_record_hash: sha256(ambiguousBase as never) });
  }
  const policyBase = {
    schema: "revit-operator.tool-exposure-policy.v1",
    hash_algorithm: "sha256",
    evidence_schema: "revit-operator.tool-certification-evidence.v1",
    evidence_source_hash: `sha256:${"4".repeat(64)}`,
    records
  };
  const policy = { ...policyBase, policy_hash: sha256(policyBase as never) };
  const policyPath = path.join(root, `direct-policy-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash, record };
}

function certifiedEnv(policy: PolicyFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REVIT_OPERATOR_MODE: "local",
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policy.policyPath,
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: policy.policyHash,
    ...overrides
  };
}

function expectDirectError(fn: () => unknown, status: number, code: string): DirectRevitExecutionAuthorizationError {
  let received: unknown;
  try { fn(); } catch (error) { received = error; }
  assert.ok(received instanceof DirectRevitExecutionAuthorizationError);
  assert.equal(received.status, status);
  assert.equal(received.code, code);
  return received;
}

test("compiled trusted-policy loader locates and validates the bundled pinned policy without cwd or explicit env", () => {
  const priorCwd = process.cwd();
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-policy-cwd-"));
  process.chdir(unrelated);
  try {
    const trusted = loadTrustedToolExposurePolicy({});
    assert.equal(trusted.policy.policy_hash, BUNDLED_TOOL_EXPOSURE_POLICY_HASH);
    assert.equal(trusted.policy.records.length, 25);
    assert.equal(trusted.policy.records.flatMap(record => Object.values(record.channels)).length, 100);
    assert.equal(trusted.policy.records.flatMap(record => Object.values(record.channels)).some(decision => decision.exposed), false);
    assert.deepEqual(
      trusted.policy.records.find(record => record.path === "/revit/certified/sheets/count")?.execution_surface,
      {
        executor_id: "revit-operator.safe-read-host.v1",
        kind: "standalone_executor",
        route_id: "safe_read.sheet_count.v1",
        transport: "direct_loopback"
      }
    );
    assert.equal(trusted.trustSource, "bundled");
    assert.match(trusted.policyPath.replace(/\\/g, "/"), /apps\/operator-backend\/config\/tool_exposure_policy\.v1\.json$/);
  } finally {
    process.chdir(priorCwd);
  }
});

test("trusted backend policy rejects standalone false promotion onto bridge and courier channels", () => {
  const bundled = loadTrustedToolExposurePolicy({});
  for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
    const policy = structuredClone(bundled.policy) as any;
    const safeRead = policy.records.find((record: any) => record.path === "/revit/certified/sheets/count");
    safeRead.channels[channel] = {
      exposed: true,
      required_level: channel === "search" ? "L3" : "L4",
      reason_codes: ["CERTIFIED"]
    };
    const { policy_record_hash: _oldRecordHash, ...recordPayload } = safeRead;
    safeRead.policy_record_hash = sha256(recordPayload);
    const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
    policy.policy_hash = sha256(policyPayload);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-trusted-standalone-promotion-"));
    const policyPath = path.join(root, "tool_exposure_policy.v1.json");
    fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
    assert.throws(
      () => loadTrustedToolExposurePolicy({
        OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policyPath,
        OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: policy.policy_hash
      }),
      (error: unknown) => error instanceof TrustedToolExposurePolicyError
        && error.code === "CERTIFICATION_POLICY_INVALID"
        && error.message.includes(`cannot expose the ${channel} channel`)
    );
  }

  const policy = structuredClone(bundled.policy) as any;
  const safeRead = policy.records.find((record: any) => record.path === "/revit/certified/sheets/count");
  delete safeRead.execution_surface;
  for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
    safeRead.channels[channel] = {
      exposed: true,
      required_level: channel === "search" ? "L3" : "L4",
      reason_codes: ["CERTIFIED"]
    };
  }
  const { policy_record_hash: _oldRecordHash, ...recordPayload } = safeRead;
  safeRead.policy_record_hash = sha256(recordPayload);
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = sha256(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-trusted-standalone-stripped-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
  assert.throws(
    () => loadTrustedToolExposurePolicy({
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: policy.policy_hash
    }),
    (error: unknown) => error instanceof TrustedToolExposurePolicyError
      && error.code === "CERTIFICATION_POLICY_INVALID"
      && error.message.includes("require the exact standalone execution_surface")
  );
});

test("direct authorization derives every generic-call binding from one exact exposed policy record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-allow-"));
  const policy = writePolicy(root, { request: { a: 1, z: "raw" } });
  const bodyJson = "{\"z\":\"raw\",\"a\":1}";
  const authorization = authorizeDirectRevitExecution(directRequest({ body_json: bodyJson }), certifiedEnv(policy), new Date("2026-07-29T12:00:00.000Z"));

  assert.equal(authorization.phase, "certification_native_direct_admission");
  assert.equal(authorization.valid_for_ms, 5_000);
  assert.equal(authorization.request_id, REQUEST_ID);
  assert.equal(authorization.method, "POST");
  assert.equal(authorization.path, "/revit/ping");
  assert.equal(authorization.body_present, true);
  assert.equal(authorization.source_body_sha256, rawSha256(bodyJson));
  assert.equal(authorization.canonical_body_json, "{\"a\":1,\"z\":\"raw\"}");
  assert.equal(authorization.body_sha256, rawSha256(authorization.canonical_body_json));
  assert.equal(authorization.policy_hash, policy.policyHash);
  assert.equal(authorization.policy_record_hash, policy.record.policy_record_hash);
  assert.equal(authorization.evidence_record_hash, policy.record.evidence_record_hash);
  assert.equal(authorization.request_hash, policy.record.request_hash);
  assert.equal(authorization.effect_hash, policy.record.effect_hash);
  assert.equal(authorization.channel, "generic_call");
  assert.equal(authorization.runtime_mode, "local");
  assert.equal(authorization.exposure_profile, "certified");
  assert.equal(authorization.policy_trust_source, "deployment");
  const { authorization_hash: declared, ...payload } = authorization;
  assert.equal(declared, sha256(payload as never));
  assert.notEqual(declared, sha256({ ...payload, source_body_sha256: rawSha256("{}") } as never));
  assert.notEqual(declared, sha256({ ...payload, canonical_body_json: "{}" } as never));

  const getPolicy = writePolicy(root, { method: "GET", path: "/revit/context", request: {} });
  const getAuthorization = authorizeDirectRevitExecution(directRequest({
    request_id: "a".repeat(64),
    method: "GET",
    path: "/revit/context",
    body_present: false,
    body_json: ""
  }), certifiedEnv(getPolicy));
  assert.equal(getAuthorization.method, "GET");
  assert.equal(getAuthorization.path, "/revit/context");
  assert.equal(getAuthorization.body_present, false);
  assert.equal(getAuthorization.request_id, "a".repeat(64));
  assert.equal(getAuthorization.source_body_sha256, rawSha256(""));
  assert.equal(getAuthorization.canonical_body_json, "");
  assert.equal(getAuthorization.body_sha256, rawSha256(""));
});

test("direct authorization rejects source lexical drift before policy evaluation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-source-form-"));
  const policy = writePolicy(root, { request: { a: 2 } });
  const env = certifiedEnv(policy);

  for (const bodyJson of [
    "{\"a\":1,\"a\":2}",
    "{ \"a\": 2 }",
    "{\"a\":2e0}",
    "{\"a\":-0}",
    "{\"a\":9007199254740993}"
  ]) {
    expectDirectError(
      () => authorizeDirectRevitExecution(directRequest({ body_json: bodyJson }), env),
      400,
      "CERTIFICATION_DIRECT_REQUEST_MALFORMED"
    );
  }
});

test("direct authorization binds distinct compact source and normalized canonical body forms", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-normalization-"));
  const policy = writePolicy(root, { request: { line: "first\nsecond", value: "é" } });
  const sourceBodyJson = JSON.stringify({ value: "e\u0301", line: "first\r\nsecond" });
  const authorization = authorizeDirectRevitExecution(
    directRequest({ body_json: sourceBodyJson }),
    certifiedEnv(policy),
    new Date("2026-07-29T12:00:00.000Z")
  );

  assert.equal(sourceBodyJson, "{\"value\":\"é\",\"line\":\"first\\r\\nsecond\"}");
  assert.equal(authorization.source_body_sha256, rawSha256(sourceBodyJson));
  assert.equal(authorization.canonical_body_json, "{\"line\":\"first\\nsecond\",\"value\":\"é\"}");
  assert.equal(authorization.body_sha256, rawSha256(authorization.canonical_body_json));
  assert.notEqual(authorization.source_body_sha256, authorization.body_sha256);

  const resubmitted = authorizeDirectRevitExecution(
    directRequest({ request_id: "b".repeat(32), body_json: authorization.canonical_body_json }),
    certifiedEnv(policy)
  );
  assert.equal(resubmitted.canonical_body_json, authorization.canonical_body_json);
  assert.equal(resubmitted.source_body_sha256, authorization.body_sha256);
  assert.equal(resubmitted.body_sha256, authorization.body_sha256);
});

test("direct authorization rejects caller trust material, malformed contracts, request mismatches, ambiguity, denial, and laboratory mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-deny-"));
  const allowed = writePolicy(root, { request: {} });
  const exact = directRequest();

  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, effect_hash: allowed.record.effect_hash }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, schema: "revit-operator.revit-direct-admission-request.v2" }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, request_id: "A".repeat(32) }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, method: "post" }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, path: "/revit/ping/" }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, body_json: "{" }, certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution(directRequest({ method: "GET", body_present: true, body_json: "{}" }), certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution(directRequest({ body_present: false, body_json: "" }), certifiedEnv(allowed)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
  expectDirectError(() => authorizeDirectRevitExecution({ ...exact, body_json: JSON.stringify({ different: true }) }, certifiedEnv(allowed)), 403, "CERTIFICATION_POLICY_DENIED");

  const denied = writePolicy(root, { request: {}, exposed: false });
  expectDirectError(() => authorizeDirectRevitExecution(exact, certifiedEnv(denied)), 403, "CERTIFICATION_POLICY_DENIED");
  const ambiguous = writePolicy(root, { request: {}, secondEffect: true });
  expectDirectError(() => authorizeDirectRevitExecution(exact, certifiedEnv(ambiguous)), 403, "CERTIFICATION_POLICY_DENIED");
  expectDirectError(() => authorizeDirectRevitExecution(exact, certifiedEnv(allowed, {
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
  })), 403, "CERTIFICATION_RUNTIME_PROFILE_MISMATCH");
  assert.equal(authorizeDirectRevitExecution(exact, certifiedEnv(allowed, {
    REVIT_OPERATOR_MODE: "Development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
  })).runtime_mode, "development");
  assert.equal(authorizeDirectRevitExecution(exact, certifiedEnv(allowed, {
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: " laboratory "
  })).runtime_mode, "development");
});

test("direct authorization enforces the raw 2 MiB body ceiling and returns structured service failures for trust-anchor problems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-limits-"));
  const policy = writePolicy(root);
  const oversized = `\"${"a".repeat(DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES)}\"`;
  expectDirectError(() => authorizeDirectRevitExecution(directRequest({ body_json: oversized }), certifiedEnv(policy)), 400, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");

  expectDirectError(() => authorizeDirectRevitExecution(directRequest(), certifiedEnv(policy, {
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: `sha256:${"f".repeat(64)}`
  })), 503, "CERTIFICATION_POLICY_ROLLBACK_REJECTED");
  expectDirectError(() => authorizeDirectRevitExecution(directRequest(), certifiedEnv(policy, {
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: path.join(root, "missing.json")
  })), 503, "CERTIFICATION_POLICY_UNAVAILABLE");
});

test("escape-heavy near-limit native wrapper fits the bounded HTTP authorization ceiling", () => {
  const sourceBodyJson = JSON.stringify({ value: "<".repeat(DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES - 32) });
  const sourceBytes = Buffer.byteLength(sourceBodyJson, "utf8");
  assert.ok(sourceBytes <= DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES);
  assert.ok(sourceBytes > DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES - 64);

  // System.Text.Json's default encoder can turn each '<' source byte into the
  // six-byte outer-wrapper escape \u003C. Preserve the other JSON.stringify
  // escaping to model the exact double-encoded request shape.
  const nativeWrapper = JSON.stringify(directRequest({ body_json: sourceBodyJson })).replaceAll("<", "\\u003C");
  const wrapperBytes = Buffer.byteLength(nativeWrapper, "utf8");
  assert.ok(wrapperBytes > DIRECT_REVIT_AUTHORIZATION_MAX_BODY_BYTES * 5);
  assert.ok(wrapperBytes <= DIRECT_REVIT_AUTHORIZATION_HTTP_MAX_BYTES);
  assert.deepEqual((JSON.parse(nativeWrapper) as any).body_json, sourceBodyJson);
});

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number };
      socket.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

function withoutCertificationOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.OPERATOR_TOOL_EXPOSURE_POLICY_PATH;
  delete copy.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256;
  delete copy.OPERATOR_TOOL_EXPOSURE_PROFILE;
  return copy;
}

async function startBackend(
  t: { after: (fn: () => Promise<void>) => void },
  options: { policy?: PolicyFixture } = {}
): Promise<{ base: string; headers: Record<string, string> }> {
  const port = await availablePort();
  const token = `direct-token-${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-backend-"));
  const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-backend-cwd-"));
  const baseEnv = withoutCertificationOverrides(process.env);
  const child = spawn(process.execPath, [path.resolve("dist/src/index.js")], {
    cwd: unrelatedCwd,
    env: {
      ...baseEnv,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_BRAIN: "rule",
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_WORKSPACE_ROOT: workspace,
      REVIT_OPERATOR_MODE: "local",
      ...(options.policy ? {
        OPERATOR_TOOL_EXPOSURE_POLICY_PATH: options.policy.policyPath,
        OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: options.policy.policyHash
      } : {})
    },
    stdio: "ignore"
  });
  t.after(async () => stop(child));
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-operator-token": token };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`, { headers })).ok) return { base, headers };
    } catch {
      // wait for startup
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("backend did not become ready");
}

test("authenticated HTTP endpoint returns exact structured deny and allow receipts from the built runtime", async (t) => {
  const bundled = await startBackend(t);
  const request = directRequest();
  const unauthenticated = await fetch(`${bundled.base}/api/revit-direct/authorize-execution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  assert.equal(unauthenticated.status, 401);

  const bundledDeny = await fetch(`${bundled.base}/api/revit-direct/authorize-execution`, {
    method: "POST",
    headers: bundled.headers,
    body: JSON.stringify(request)
  });
  assert.equal(bundledDeny.status, 403);
  assert.deepEqual(await bundledDeny.json(), {
    ok: false,
    code: "CERTIFICATION_POLICY_DENIED",
    error: "Current certification policy does not contain one exact certified method, path, request, and effect.",
    retryable: false
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-direct-http-policy-"));
  const policy = writePolicy(root, { request: {} });
  const allowed = await startBackend(t, { policy });
  const response = await fetch(`${allowed.base}/api/revit-direct/authorize-execution`, {
    method: "POST",
    headers: allowed.headers,
    body: JSON.stringify(request)
  });
  assert.equal(response.status, 200);
  const receipt = await response.json() as any;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.authorization.policy_hash, policy.policyHash);
  assert.equal(receipt.authorization.effect_hash, policy.record.effect_hash);
  assert.equal(receipt.authorization.channel, "generic_call");
  assert.equal(receipt.authorization.request_id, REQUEST_ID);
  assert.equal(receipt.authorization.valid_for_ms, 5_000);
  assert.equal(receipt.authorization.source_body_sha256, rawSha256("{}"));
  assert.equal(receipt.authorization.canonical_body_json, "{}");
  assert.equal(receipt.authorization.body_sha256, rawSha256("{}"));
  assert.deepEqual(Object.keys(receipt.authorization).sort(), [
    "authorization_hash", "authorized_at", "body_present", "body_sha256", "canonical_body_json",
    "channel", "effect_hash", "evidence_record_hash", "exposure_profile", "method", "path",
    "phase", "policy_hash", "policy_record_hash", "policy_trust_source", "request_hash", "request_id",
    "runtime_mode", "source_body_sha256", "valid_for_ms", "version"
  ]);

  const malformed = await fetch(`${allowed.base}/api/revit-direct/authorize-execution`, {
    method: "POST",
    headers: allowed.headers,
    body: JSON.stringify({ ...request, policy_hash: policy.policyHash })
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as any).code, "CERTIFICATION_DIRECT_REQUEST_MALFORMED");
});
