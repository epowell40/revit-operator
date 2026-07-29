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
  SAFE_READ_BODY_SHA256,
  SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT,
  SAFE_READ_CANONICAL_BODY_JSON,
  SAFE_READ_CAPABILITY_VALID_FOR_MS,
  SAFE_READ_COURIER_DISABLED,
  SAFE_READ_EFFECT_HASH,
  SAFE_READ_EXECUTOR_ID,
  SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
  SAFE_READ_FINAL_RECEIPT_SCHEMA,
  SAFE_READ_METHOD,
  SAFE_READ_PATH,
  SAFE_READ_POLICY_SHA256,
  SAFE_READ_PREAUTHORIZATION_SCHEMA,
  SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA,
  SAFE_READ_PREAUTHORIZE_ENDPOINT,
  SAFE_READ_RECEIPT_VALID_FOR_MS,
  SAFE_READ_REQUEST_HASH,
  SAFE_READ_ROUTE_ID,
  SAFE_READ_ROUTE_CONTRACT_SHA256,
  SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
  SAFE_READ_GOLDEN_CONTRACT,
  SafeReadCapabilityError,
  SafeReadCapabilityService,
  computeSafeReadReceiptHmac,
  isSafeReadCapabilityId,
  isSafeReadReceiptId,
  safeReadCourierDisabledFailure,
  safeReadDirectEndpointEnvelope,
  safeReadFinalAuthorizationEnvelope,
  safeReadPreauthorizationEnvelope,
  safeReadRuntimeAttestationPath
} from "../src/capabilities/safe_read_capability.js";
import { canonicalJson, type JsonValue } from "../src/capabilities/tool_certification.js";

const NOW = "2026-07-29T20:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SCOPE = `sha256:${"c".repeat(64)}`;
const HOST_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const DOCUMENT_SESSION_ID = "33333333-3333-3333-3333-333333333333";
const CLIENT_SESSION_ID = "44444444-4444-4444-4444-444444444444";
const REQUEST_ID = "55555555-5555-5555-5555-555555555555";
const ATTEMPT_ID = "66666666-6666-6666-6666-666666666666";

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
    route_id: SAFE_READ_ROUTE_ID,
    route_contract_sha256: SAFE_READ_ROUTE_CONTRACT_SHA256,
    policy_sha256: SAFE_READ_POLICY_SHA256,
    proof_sha256: `sha256:${"9".repeat(64)}`,
    executor_id: SAFE_READ_EXECUTOR_ID,
    runtime_tuple: {
      host_content_sha256: HASH_A,
      host_mvid: "11111111-1111-1111-1111-111111111111",
      revit_api_content_sha256: HASH_B,
      revit_api_mvid: "22222222-2222-2222-2222-222222222222",
      revit_version: "2024"
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
    host_instance_id: HOST_INSTANCE_ID,
    executor_id: current.executor_id,
    runtime_attestation_sha256: pin,
    runtime_tuple: current.runtime_tuple,
    document: {
      project_fingerprint: `sha256:${"d".repeat(64)}`,
      document_session_id: DOCUMENT_SESSION_ID
    },
    client_session_id: CLIENT_SESSION_ID,
    request_id: REQUEST_ID,
    attempt_id: ATTEMPT_ID,
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
  assert.equal(SAFE_READ_BODY_SCHEMA, "revit-operator.safe-read.sheets-count.request.v1");
  assert.equal(SAFE_READ_CANONICAL_BODY_JSON, "{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}");
  assert.deepEqual(safeReadCourierDisabledFailure(), {
    ok: false,
    code: SAFE_READ_COURIER_DISABLED,
    error: "SafeRead capabilities are direct-only; courier jobs and transport are disabled.",
    retryable: false,
    request_dispatched: false,
    outcome_unknown: false
  });
});

test("exported golden contract vectors freeze exact body and server-derived hashes", () => {
  assert.deepEqual(SAFE_READ_GOLDEN_CONTRACT, {
    route_id: "safe_read.sheet_count.v1",
    executor_id: "revit-operator.safe-read-host.v1",
    method: "POST",
    path: "/revit/certified/sheets/count",
    body_schema: "revit-operator.safe-read.sheets-count.request.v1",
    canonical_body_json: "{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}",
    body_sha256: "sha256:3365135151daf7e1cf9b20c5a3b49a2b5b3b0e42eab9a73a404739a7cdad65d5",
    request_hash: "sha256:106a5e8cbfce57eb12d94757eb052e660ffc222855ea1b77548b6865d8f769e1",
    effect_hash: "sha256:82669f8c2d957b0bbce5bfa5f7846ef1b7b0f46d9818aec41fbbc4c03de001dc",
    route_contract_sha256: "sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874",
    policy_sha256: "sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67",
    capability_id_pattern: "src1_ + 32-byte base64url (48 chars)",
    receipt_id_pattern: "srr1_ + 32-byte base64url (48 chars)",
    preauthorize_endpoint: "/api/safe-read/direct/preauthorize",
    authorize_execution_endpoint: "/api/safe-read/direct/authorize-execution",
    nonce_transport: "host-generated; sha256 in preauthorization body; raw nonce in final body only",
    receipt_hmac_domain: "safe-read-final-receipt-v1"
  });
  assert.equal(SAFE_READ_BODY_SHA256, SAFE_READ_GOLDEN_CONTRACT.body_sha256);
  assert.equal(SAFE_READ_REQUEST_HASH, SAFE_READ_GOLDEN_CONTRACT.request_hash);
  assert.equal(SAFE_READ_EFFECT_HASH, SAFE_READ_GOLDEN_CONTRACT.effect_hash);
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
  expectError(() => parseSafeReadPreauthorizationRequest({ ...request, host_instance_id: ` ${HOST_INSTANCE_ID}` }), "SAFE_READ_REQUEST_MALFORMED");
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
  assert.equal(authorization.capability_id.length, 48);
  assert.equal(isSafeReadCapabilityId(authorization.capability_id), true);
  assert.match(authorization.bindings_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Date.parse(authorization.expires_at_utc) - Date.parse(authorization.issued_at_utc), SAFE_READ_CAPABILITY_VALID_FOR_MS);

  const final = finalRequest(request, authorization.capability_id, n.encoded);
  const receipt = f.service.authorizeExecution(SCOPE, final);
  assert.equal(receipt.schema, SAFE_READ_FINAL_RECEIPT_SCHEMA);
  assert.equal(receipt.route_id, SAFE_READ_ROUTE_ID);
  assert.equal(receipt.receipt_id.length, 48);
  assert.equal(isSafeReadReceiptId(receipt.receipt_id), true);
  assert.equal(receipt.bindings_hash, authorization.bindings_hash);
  assert.equal(Date.parse(receipt.expires_at_utc) - Date.parse(receipt.issued_at_utc), SAFE_READ_RECEIPT_VALID_FOR_MS);
  const { hmac_sha256, ...payload } = receipt;
  const key = createHmac("sha256", n.bytes).update("safe-read-final-receipt-v1", "utf8").digest();
  const expected = `sha256:${createHmac("sha256", key).update(canonicalJson(payload as unknown as JsonValue), "utf8").digest("hex")}`;
  assert.equal(hmac_sha256, expected);
  assert.equal(computeSafeReadReceiptHmac(n.bytes, payload), expected);
  const preauthEnvelope = safeReadPreauthorizationEnvelope(authorization);
  const finalEnvelope = safeReadFinalAuthorizationEnvelope(receipt);
  assert.deepEqual(Object.keys(preauthEnvelope), ["ok", "authorization"]);
  assert.deepEqual(Object.keys(finalEnvelope), ["ok", "receipt"]);
  assert.equal(preauthEnvelope.authorization, authorization);
  assert.equal(finalEnvelope.receipt, receipt);
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
  expectError(() => f.service.authorizeExecution(SCOPE, { ...final, attempt_id: "77777777-7777-7777-7777-777777777777" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, { ...final, host_instance_id: "88888888-8888-8888-8888-888888888888" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, {
    ...final,
    runtime_tuple: { ...(final.runtime_tuple as object), host_mvid: "33333333-3333-3333-3333-333333333333" }
  }), "SAFE_READ_ATTESTATION_BINDING_MISMATCH");
  expectError(() => f.service.authorizeExecution(SCOPE, {
    ...final,
    document: { ...(final.document as object), project_fingerprint: `sha256:${"f".repeat(64)}` }
  }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH");

  assert.equal(f.service.authorizeExecution(SCOPE, final).request_id, REQUEST_ID);
  f.service.close();
});

test("direct endpoint dispatcher returns exact ordered success envelopes and accepts nonce only in request bodies", () => {
  const f = fixture();
  const n = nonce();
  const preauthBody = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n.hash);
  const preauthEnvelope = safeReadDirectEndpointEnvelope(f.service, SAFE_READ_PREAUTHORIZE_ENDPOINT, SCOPE, preauthBody);
  assert.deepEqual(Object.keys(preauthEnvelope), ["ok", "authorization"]);
  assert.equal("authorization" in preauthEnvelope, true);
  const authorization = (preauthEnvelope as { authorization: { capability_id: string } }).authorization;
  const finalBody = finalRequest(preauthBody, authorization.capability_id, n.encoded);
  const finalEnvelope = safeReadDirectEndpointEnvelope(f.service, SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT, SCOPE, finalBody);
  assert.deepEqual(Object.keys(finalEnvelope), ["ok", "receipt"]);
  assert.equal("receipt" in finalEnvelope, true);
  assert.equal(Object.hasOwn(preauthBody, "capability_nonce"), false);
  assert.equal(Object.hasOwn(finalBody, "capability_nonce_sha256"), false);
  f.service.close();
});

test("deployment attestation is static while canonical host, document, and request identities remain ephemeral", () => {
  const staticManifest = manifest();
  assert.deepEqual(Object.keys(staticManifest), [
    "schema", "state", "issued_at_utc", "expires_at_utc", "route_id", "route_contract_sha256",
    "policy_sha256", "proof_sha256", "executor_id", "runtime_tuple"
  ]);
  for (const forbidden of [
    "host_instance_id", "document", "client_session_id", "request_id", "attempt_id", "capability_nonce_sha256"
  ]) {
    assert.equal(Object.hasOwn(staticManifest, forbidden), false);
  }

  const f = fixture({ manifest: staticManifest });
  const first = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, nonce().hash);
  const second = preauthRequest(f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, nonce().hash, {
    host_instance_id: "99999999-9999-9999-9999-999999999999",
    document: {
      project_fingerprint: `sha256:${"e".repeat(64)}`,
      document_session_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    },
    client_session_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    request_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    attempt_id: "dddddddd-dddd-dddd-dddd-dddddddddddd"
  });
  assert.equal(f.service.preauthorize(SCOPE, first).schema, SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA);
  assert.equal(f.service.preauthorize(SCOPE, second).schema, SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA);
  expectError(() => f.service.preauthorize(SCOPE, {
    ...second,
    request_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    runtime_tuple: { ...(second.runtime_tuple as object), host_mvid: "ffffffff-ffff-ffff-ffff-ffffffffffff" }
  }), "SAFE_READ_ATTESTATION_BINDING_MISMATCH");
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

test("checked-in example is a valid static attestation with lowercase hashes and canonical MVIDs", () => {
  const examplePath = path.resolve("config/safe_read_runtime_attestation.example.json");
  const raw = fs.readFileSync(examplePath, "utf8");
  const example = JSON.parse(raw) as Record<string, any>;
  assert.deepEqual(Object.keys(example), [
    "schema", "state", "issued_at_utc", "expires_at_utc", "route_id", "route_contract_sha256",
    "policy_sha256", "proof_sha256", "executor_id", "runtime_tuple"
  ]);
  for (const value of [
    example.route_contract_sha256, example.policy_sha256, example.proof_sha256,
    example.runtime_tuple.host_content_sha256, example.runtime_tuple.revit_api_content_sha256
  ]) assert.match(value, /^sha256:[0-9a-f]{64}$/);
  for (const value of [example.runtime_tuple.host_mvid, example.runtime_tuple.revit_api_mvid]) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-example-"));
  const pin = rawSha256(raw);
  const service = new SafeReadCapabilityService({
    databasePath: path.join(root, "safe-read.sqlite"),
    manifestPath: examplePath,
    env: { OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256: pin },
    now: () => new Date("2030-01-01T00:01:00.000Z")
  });
  const request = preauthRequest(pin, nonce().hash, { runtime_tuple: example.runtime_tuple });
  assert.equal(service.preauthorize(SCOPE, request).schema, SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA);
  service.close();
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
  assert.equal(f.service.authorizeExecution(SCOPE, final).attempt_id, ATTEMPT_ID);
  f.service.close();

  const rotated = fixture();
  const n2 = nonce();
  const request2 = preauthRequest(rotated.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256!, n2.hash, { attempt_id: "77777777-7777-7777-7777-777777777777" });
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
  expectError(() => service.authorizeExecution(SCOPE, { ...final, attempt_id: "77777777-7777-7777-7777-777777777777" }), "SAFE_READ_CAPABILITY_BINDING_MISMATCH", false);
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
