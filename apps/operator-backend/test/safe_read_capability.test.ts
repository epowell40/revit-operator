import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseSafeReadPreauthorizationRequest,
  SAFE_READ_BODY_SCHEMA,
  SAFE_READ_CANONICAL_BODY_JSON,
  SAFE_READ_CAPABILITY_VALID_FOR_MS,
  SAFE_READ_COURIER_DISABLED,
  SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
  SAFE_READ_FINAL_RECEIPT_SCHEMA,
  SAFE_READ_METHOD,
  SAFE_READ_PATH,
  SAFE_READ_PREAUTHORIZATION_SCHEMA,
  SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA,
  SAFE_READ_RECEIPT_VALID_FOR_MS,
  SAFE_READ_ROUTE_ID,
  SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
  SafeReadCapabilityError,
  SafeReadCapabilityService,
  safeReadCourierDisabledFailure,
  safeReadRuntimeAttestationPath
} from "../src/capabilities/safe_read_capability.js";
import { canonicalJson, type JsonValue } from "../src/capabilities/tool_certification.js";

const NOW = "2026-07-29T20:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SCOPE = `sha256:${"c".repeat(64)}`;

type Fixture = ReturnType<typeof fixture>;

function rawSha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
    state: "active",
    issued_at_utc: "2026-07-29T19:55:00.000Z",
    expires_at_utc: "2026-07-29T20:05:00.000Z",
    host_instance_id: "host-1",
    executor_id: "executor-1",
    runtime_tuple: {
      host_content_sha256: HASH_A,
      host_mvid: "11111111-1111-1111-1111-111111111111",
      revit_api_content_sha256: HASH_B,
      revit_api_mvid: "22222222-2222-2222-2222-222222222222",
      revit_version: "2024"
    },
    document: {
      project_fingerprint: `sha256:${"d".repeat(64)}`,
      document_session_id: "document-session-1"
    },
    ...overrides
  };
}

function fixture(options: { now?: string; manifest?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-capability-"));
  const manifestPath = path.join(root, "safe_read_runtime_attestation.v1.json");
  const databasePath = path.join(root, "safe-read.sqlite");
  const manifestValue = options.manifest ?? manifest();
  const raw = `${JSON.stringify(manifestValue)}\n`;
  fs.writeFileSync(manifestPath, raw, "utf8");
  const env: NodeJS.ProcessEnv = { OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256: rawSha256(raw) };
  let now = new Date(options.now ?? NOW);
  const service = new SafeReadCapabilityService({ databasePath, manifestPath, env, now: () => now });
  return {
    root,
    manifestPath,
    databasePath,
    env,
    service,
    setNow(value: string) { now = new Date(value); }
  };
}

function nonce(): { bytes: Buffer; encoded: string; hash: string } {
  const bytes = randomBytes(32);
  return { bytes, encoded: bytes.toString("base64url"), hash: rawSha256(bytes) };
}

function preauthRequest(pin: string, nonceHash: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const current = manifest();
  return {
    schema: SAFE_READ_PREAUTHORIZATION_SCHEMA,
    route_id: SAFE_READ_ROUTE_ID,
    host_instance_id: current.host_instance_id,
    executor_id: current.executor_id,
    runtime_attestation_sha256: pin,
    runtime_tuple: current.runtime_tuple,
    document: current.document,
    client_session_id: "client-session-1",
    request_id: "request-1",
    attempt_id: "attempt-1",
    capability_nonce_sha256: nonceHash,
    ...overrides
  };
}

function finalRequest(preauth: Record<string, unknown>, capabilityId: string, nonceValue: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
    route_id: preauth.route_id,
    host_instance_id: preauth.host_instance_id,
    executor_id: preauth.executor_id,
    runtime_attestation_sha256: preauth.runtime_attestation_sha256,
    runtime_tuple: preauth.runtime_tuple,
    document: preauth.document,
    client_session_id: preauth.client_session_id,
    request_id: preauth.request_id,
    attempt_id: preauth.attempt_id,
    capability_id: capabilityId,
    capability_nonce: nonceValue,
    ...overrides
  };
}

function expectError(fn: () => unknown, code: string, outcomeUnknown = false): SafeReadCapabilityError {
  let received: unknown;
  try { fn(); } catch (error) { received = error; }
  assert.ok(received instanceof SafeReadCapabilityError);
  assert.equal(received.code, code);
  assert.deepEqual(received.body(), {
    ok: false,
    code,
    error: received.message,
    retryable: received.retryable,
    request_dispatched: false,
    outcome_unknown: outcomeUnknown
  });
  return received;
}

test("route is one exact direct-only read contract with no courier or policy/tool channel", () => {
  assert.equal(SAFE_READ_ROUTE_ID, "safe_read.sheet_count.v1");
  assert.equal(SAFE_READ_METHOD, "POST");
  assert.equal(SAFE_READ_PATH, "/revit/certified/sheets/count");
  assert.equal(SAFE_READ_BODY_SCHEMA, "revit-operator.safe-read.sheet-count-request.v1");
  assert.equal(SAFE_READ_CANONICAL_BODY_JSON, "{\"schema\":\"revit-operator.safe-read.sheet-count-request.v1\"}");
  assert.deepEqual(safeReadCourierDisabledFailure(), {
    ok: false,
    code: SAFE_READ_COURIER_DISABLED,
    error: "SafeRead capabilities are direct-only; courier jobs and transport are disabled.",
    retryable: false,
    request_dispatched: false,
    outcome_unknown: false
  });
});

test("request schema rejects unknown keys, key order, casing, and identifier/hash whitespace", () => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  assert.deepEqual(parseSafeReadPreauthorizationRequest(request), request);

  expectError(() => parseSafeReadPreauthorizationRequest({ ...request, policy_hash: HASH_A }), "SAFE_READ_REQUEST_MALFORMED");
  const { schema, route_id, ...rest } = request;
  expectError(() => parseSafeReadPreauthorizationRequest({ route_id, schema, ...rest }), "SAFE_READ_REQUEST_MALFORMED");
  expectError(() => parseSafeReadPreauthorizationRequest({ ...request, route_id: "SAFE_READ.SHEET_COUNT.V1" }), "SAFE_READ_REQUEST_MALFORMED");
  expectError(() => parseSafeReadPreauthorizationRequest({ ...request, host_instance_id: " host-1" }), "SAFE_READ_REQUEST_MALFORMED");
  expectError(() => parseSafeReadPreauthorizationRequest({ ...request, runtime_attestation_sha256: `${request.runtime_attestation_sha256} ` }), "SAFE_READ_REQUEST_MALFORMED");
  f.service.close();
});

test("preauthorization returns only the opaque capability envelope and final receipt is nonce-HMACed for at most two seconds", () => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = f.service.preauthorize(SCOPE, request);
  assert.deepEqual(Object.keys(authorization), ["schema", "capability_id", "bindings_hash", "issued_at_utc", "expires_at_utc"]);
  assert.equal(authorization.schema, SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA);
  assert.match(authorization.capability_id, /^src1_[A-Za-z0-9_-]{43}$/);
  assert.match(authorization.bindings_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Date.parse(authorization.expires_at_utc) - Date.parse(authorization.issued_at_utc), SAFE_READ_CAPABILITY_VALID_FOR_MS);

  const final = finalRequest(request, authorization.capability_id, n.encoded);
  const receipt = f.service.authorizeExecution(SCOPE, final);
  assert.equal(receipt.schema, SAFE_READ_FINAL_RECEIPT_SCHEMA);
  assert.equal(receipt.route_id, SAFE_READ_ROUTE_ID);
  assert.equal(receipt.bindings_hash, authorization.bindings_hash);
  assert.equal(Date.parse(receipt.expires_at_utc) - Date.parse(receipt.issued_at_utc), SAFE_READ_RECEIPT_VALID_FOR_MS);
  const { hmac_sha256, ...payload } = receipt;
  const key = createHmac("sha256", n.bytes).update("safe-read-final-receipt-v1", "utf8").digest();
  const expected = `sha256:${createHmac("sha256", key).update(canonicalJson(payload as unknown as JsonValue), "utf8").digest("hex")}`;
  assert.equal(hmac_sha256, expected);
  expectError(() => f.service.authorizeExecution(SCOPE, final), "SAFE_READ_CAPABILITY_REPLAYED");
  f.service.close();
});

test("wrong nonce, principal, tuple, document, runtime, and attempt do not consume a legitimate capability", () => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = f.service.preauthorize(SCOPE, request);
  const final = finalRequest(request, authorization.capability_id, n.encoded);

  expectError(() => f.service.authorizeExecution(`sha256:${"e".repeat(64)}`, final), "SAFE_READ_CAPABILITY_NOT_FOUND");
  expectError(() => f.service.authorizeExecution(SCOPE, { ...final, capability_nonce: nonce().encoded }), "SAFE_READ_CAPABILITY_POSSESSION_FAILED");
  expectError(() => f.service.authorizeExecution(SCOPE, { ...final, attempt_id: "attempt-wrong" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, { ...final, host_instance_id: "host-wrong" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, {
    ...final,
    runtime_tuple: { ...(final.runtime_tuple as object), host_mvid: "33333333-3333-3333-3333-333333333333" }
  }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, {
    ...final,
    document: { ...(final.document as object), project_fingerprint: `sha256:${"f".repeat(64)}` }
  }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");

  assert.equal(f.service.authorizeExecution(SCOPE, final).request_id, "request-1");
  f.service.close();
});

test("expiry is fail-closed and a duplicate principal/session/request/attempt cannot mint a second capability", () => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = f.service.preauthorize(SCOPE, request);
  expectError(() => f.service.preauthorize(SCOPE, { ...request, capability_nonce_sha256: nonce().hash }), "SAFE_READ_ATTEMPT_ALREADY_EXISTS");
  f.setNow("2026-07-29T20:00:30.001Z");
  expectError(() => f.service.authorizeExecution(SCOPE, finalRequest(request, authorization.capability_id, n.encoded)), "SAFE_READ_CAPABILITY_EXPIRED");
  f.service.close();
});

test("fixed manifest location ignores workstation path input and pin, stale, and revoked failures are structured", () => {
  const productionPath = safeReadRuntimeAttestationPath().replace(/\\/g, "/");
  assert.match(productionPath, /apps\/operator-backend\/config\/safe_read_runtime_attestation\.v1\.json$/);

  const pinned = fixture();
  const n = nonce();
  const request = preauthRequest(pinned.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  pinned.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256 = HASH_A;
  expectError(() => pinned.service.preauthorize(SCOPE, request), "SAFE_READ_ATTESTATION_PIN_MISMATCH");
  pinned.service.close();

  const stale = fixture({ manifest: manifest({ expires_at_utc: "2026-07-29T19:59:59.999Z" }) });
  expectError(
    () => stale.service.preauthorize(SCOPE, preauthRequest(stale.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, nonce().hash)),
    "SAFE_READ_ATTESTATION_STALE"
  );
  stale.service.close();

  const revoked = fixture({ manifest: manifest({ state: "revoked" }) });
  expectError(
    () => revoked.service.preauthorize(SCOPE, preauthRequest(revoked.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, nonce().hash)),
    "SAFE_READ_ATTESTATION_REVOKED"
  );
  revoked.service.close();
});

test("final authorization reloads the pinned attestation and rejects stale or newly revoked deployment state without consuming", () => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = f.service.preauthorize(SCOPE, request);
  const final = finalRequest(request, authorization.capability_id, n.encoded);
  f.setNow("2026-07-29T20:05:00.000Z");
  expectError(() => f.service.authorizeExecution(SCOPE, final), "SAFE_READ_ATTESTATION_STALE");
  f.setNow(NOW);
  assert.equal(f.service.authorizeExecution(SCOPE, final).attempt_id, "attempt-1");
  f.service.close();

  const rotated = fixture();
  const n2 = nonce();
  const request2 = preauthRequest(rotated.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n2.hash, { attempt_id: "attempt-2" });
  const authorization2 = rotated.service.preauthorize(SCOPE, request2);
  const revokedRaw = `${JSON.stringify(manifest({ state: "revoked" }))}\n`;
  fs.writeFileSync(rotated.manifestPath, revokedRaw, "utf8");
  rotated.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256 = rawSha256(revokedRaw);
  expectError(
    () => rotated.service.authorizeExecution(SCOPE, finalRequest(request2, authorization2.capability_id, n2.encoded)),
    "SAFE_READ_ATTESTATION_REVOKED"
  );
  rotated.service.close();
});

test("post-CAS receipt failure is outcome-unknown while predispatch failures are known and non-consuming", () => {
  const f = fixture();
  f.service.close();
  const service = new SafeReadCapabilityService({
    databasePath: f.databasePath,
    manifestPath: f.manifestPath,
    env: f.env,
    now: () => new Date(NOW),
    afterConsume: () => { throw new Error("injected post-CAS failure"); }
  });
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = service.preauthorize(SCOPE, request);
  const final = finalRequest(request, authorization.capability_id, n.encoded);
  expectError(() => service.authorizeExecution(SCOPE, { ...final, attempt_id: "wrong-attempt" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH", false);
  expectError(() => service.authorizeExecution(SCOPE, final), "SAFE_READ_POST_AUTHORIZATION_FAILURE", true);
  expectError(() => service.authorizeExecution(SCOPE, final), "SAFE_READ_CAPABILITY_REPLAYED", false);
  service.close();
});

function waitForMessage(child: ChildProcess, predicate: (value: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: any) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`worker exited early: ${code}`)); };
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

test("two independent processes racing the same SQLite capability produce exactly one winner", async (t) => {
  const f = fixture();
  const n = nonce();
  const request = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const authorization = f.service.preauthorize(SCOPE, request);
  f.service.close();
  const input = Buffer.from(JSON.stringify({
    databasePath: f.databasePath,
    manifestPath: f.manifestPath,
    pin: f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256,
    scope: SCOPE,
    request: finalRequest(request, authorization.capability_id, n.encoded),
    now: NOW
  }), "utf8").toString("base64url");
  const workerPath = path.resolve("dist/test/safe_read_capability_worker.js");
  const children = [fork(workerPath, [input], { stdio: ["ignore", "ignore", "ignore", "ipc"] }), fork(workerPath, [input], { stdio: ["ignore", "ignore", "ignore", "ipc"] })];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(child => waitForMessage(child, value => value?.ready === true)));
  const results = children.map(child => waitForMessage(child, value => typeof value?.ok === "boolean"));
  children.forEach(child => child.send({ go: true }));
  const received = await Promise.all(results);
  assert.equal(received.filter(item => item.ok).length, 1);
  assert.deepEqual(received.filter(item => !item.ok).map(item => item.code), ["SAFE_READ_CAPABILITY_REPLAYED"]);
});
