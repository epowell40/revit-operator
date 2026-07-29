import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadHostedSafeReadAttestation,
  SAFE_READ_ATTESTATION_SET_SCHEMA,
  SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA,
  SafeReadAttestationAuthorityError
} from "../src/capabilities/safe_read_attestation_authority.js";
import {
  SAFE_READ_EXECUTOR_ID,
  SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
  SAFE_READ_POLICY_SHA256,
  SAFE_READ_PREAUTHORIZATION_SCHEMA,
  SAFE_READ_ROUTE_CONTRACT_SHA256,
  SAFE_READ_ROUTE_ID,
  SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
  SafeReadCapabilityError,
  SafeReadCapabilityService
} from "../src/capabilities/safe_read_capability.js";
import { canonicalJson, type JsonValue } from "../src/capabilities/tool_certification.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const TUPLE = {
  host_content_sha256: HASH_A,
  host_mvid: "11111111-1111-1111-1111-111111111111",
  revit_api_content_sha256: HASH_B,
  revit_api_mvid: "22222222-2222-2222-2222-222222222222",
  revit_version: "2024"
};

function sha(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function attestation() {
  return {
    schema: "revit-operator.safe-read-runtime-attestation.v1",
    state: "active",
    issued_at_utc: "2026-07-29T19:55:00.000Z",
    expires_at_utc: "2026-07-29T20:05:00.000Z",
    route_id: "safe_read.sheet_count.v1",
    route_contract_sha256: `sha256:${"c".repeat(64)}`,
    policy_sha256: `sha256:${"d".repeat(64)}`,
    proof_sha256: `sha256:${"e".repeat(64)}`,
    executor_id: "revit-operator.safe-read-host.v1",
    runtime_tuple: TUPLE
  };
}

function expectAuthorityError(fn: () => unknown, code: string): void {
  let received: unknown;
  try { fn(); } catch (error) { received = error; }
  assert.ok(received instanceof SafeReadAttestationAuthorityError);
  assert.equal(received.code, code);
}

function fixture(options: { sequence?: number; signerState?: "active" | "revoked"; attestationValue?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-attestation-authority-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signerRing = {
    schema: SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA,
    signers: [{
      key_id: "release-2026-a",
      algorithm: "ed25519",
      state: options.signerState ?? "active",
      public_key_spki_base64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    }]
  };
  const attestationValue = options.attestationValue ?? attestation();
  const attestationJson = `${JSON.stringify(attestationValue)}\n`;
  const attestationSha = sha(attestationJson);
  const entries = [{ runtime_attestation_sha256: attestationSha, runtime_tuple: TUPLE, attestation_json: attestationJson }];
  const payload = {
    schema: SAFE_READ_ATTESTATION_SET_SCHEMA,
    sequence: options.sequence ?? 7,
    issued_at_utc: "2026-07-29T19:50:00.000Z",
    entries
  };
  const set = {
    ...payload,
    signatures: [{
      key_id: "release-2026-a",
      algorithm: "ed25519",
      signature_base64url: sign(null, Buffer.from(canonicalJson(payload as unknown as JsonValue)), privateKey).toString("base64url")
    }]
  };
  const ringPath = path.join(root, "signers.json");
  const setPath = path.join(root, "set.json");
  const resign = () => {
    const signedPayload = {
      schema: set.schema,
      sequence: set.sequence,
      issued_at_utc: set.issued_at_utc,
      entries: set.entries
    };
    set.signatures[0]!.signature_base64url = sign(null, Buffer.from(canonicalJson(signedPayload as unknown as JsonValue)), privateKey).toString("base64url");
  };
  const write = () => {
    const ringRaw = `${JSON.stringify(signerRing)}\n`;
    const setRaw = `${JSON.stringify(set)}\n`;
    fs.writeFileSync(ringPath, ringRaw);
    fs.writeFileSync(setPath, setRaw);
    return { ringRaw, setRaw };
  };
  const raw = write();
  const env: NodeJS.ProcessEnv = {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_PATH: ringPath,
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: sha(raw.ringRaw),
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: setPath,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(raw.setRaw)
  };
  return { env, set, signerRing, setPath, ringPath, attestationSha, write, resign };
}

test("hosted authority verifies separately pinned signer ring and set, then selects exact hash and tuple", () => {
  const f = fixture();
  const selected = loadHostedSafeReadAttestation(f.env, f.attestationSha, TUPLE);
  assert.equal(selected.setSequence, 7);
  assert.equal(selected.attestationSha256, f.attestationSha);
  assert.deepEqual(selected.attestation, attestation());
});

test("hosted authority rejects non-hosted use, mixed legacy config, missing pairs, and wrong pins", () => {
  const f = fixture();
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, REVIT_OPERATOR_MODE: "local" }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_CONFIG_MIXED");
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256: HASH_A }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_CONFIG_MIXED");
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: undefined }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_UNAVAILABLE");
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: HASH_A }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_PIN_MISMATCH");
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: HASH_A }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_PIN_MISMATCH");
});

test("hosted authority rejects signature tampering, revoked signer authorization, and imprecise selection", () => {
  const f = fixture();
  f.set.signatures[0]!.signature_base64url = f.set.signatures[0]!.signature_base64url.replace(/^./, f.set.signatures[0]!.signature_base64url[0] === "A" ? "B" : "A");
  const changed = f.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...f.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(changed.setRaw) }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SIGNATURE_INVALID");

  const revoked = fixture({ signerState: "revoked" });
  expectAuthorityError(() => loadHostedSafeReadAttestation(revoked.env, revoked.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SIGNATURE_INVALID");

  const valid = fixture();
  expectAuthorityError(() => loadHostedSafeReadAttestation(valid.env, HASH_A, TUPLE), "SAFE_READ_ATTESTATION_SELECTION_FAILED");
  expectAuthorityError(() => loadHostedSafeReadAttestation(valid.env, valid.attestationSha, { ...TUPLE, revit_version: "2025" }), "SAFE_READ_ATTESTATION_SELECTION_FAILED");
});

test("hosted authority permits signer rotation while a revoked predecessor cannot authorize", () => {
  const f = fixture();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  f.signerRing.signers[0]!.state = "revoked";
  (f.signerRing.signers as Array<Record<string, unknown>>).push({
    key_id: "release-2026-b",
    algorithm: "ed25519",
    state: "active",
    public_key_spki_base64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
  });
  const payload = { schema: f.set.schema, sequence: f.set.sequence, issued_at_utc: f.set.issued_at_utc, entries: f.set.entries };
  f.set.signatures = [{
    key_id: "release-2026-b",
    algorithm: "ed25519",
    signature_base64url: sign(null, Buffer.from(canonicalJson(payload as unknown as JsonValue)), privateKey).toString("base64url")
  }];
  const raw = f.write();
  const env = {
    ...f.env,
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: sha(raw.ringRaw),
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(raw.setRaw)
  };
  assert.equal(loadHostedSafeReadAttestation(env, f.attestationSha, TUPLE).setSequence, 7);
});

test("hosted authority rejects oversized, duplicate, and attestation-content-mismatched sets", () => {
  const oversized = fixture();
  oversized.set.entries = Array.from({ length: 17 }, () => oversized.set.entries[0]!);
  const oversizedRaw = oversized.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...oversized.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(oversizedRaw.setRaw) }, oversized.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const duplicate = fixture();
  duplicate.set.entries.push(duplicate.set.entries[0]!);
  const duplicateRaw = duplicate.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...duplicate.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(duplicateRaw.setRaw) }, duplicate.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const mismatch = fixture();
  mismatch.set.entries[0]!.runtime_attestation_sha256 = HASH_A;
  const mismatchRaw = mismatch.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({ ...mismatch.env, OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(mismatchRaw.setRaw) }, HASH_A, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");
});

test("checked-in hosted examples are internally signed but inert because signer and attestation are revoked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-attestation-examples-"));
  const sourceRing = JSON.parse(fs.readFileSync(path.resolve("config/safe_read_attestation_trusted_signers.example.json"), "utf8"));
  const sourceSet = JSON.parse(fs.readFileSync(path.resolve("config/safe_read_runtime_attestation_set.example.json"), "utf8"));
  assert.equal(sourceRing.signers[0].state, "revoked");
  assert.equal(JSON.parse(sourceSet.entries[0].attestation_json).state, "revoked");
  sourceRing.signers[0].state = "active";
  const ringPath = path.join(root, "ring.json");
  const setPath = path.join(root, "set.json");
  const ringRaw = `${JSON.stringify(sourceRing)}\n`;
  const setRaw = `${JSON.stringify(sourceSet)}\n`;
  fs.writeFileSync(ringPath, ringRaw);
  fs.writeFileSync(setPath, setRaw);
  const selection = loadHostedSafeReadAttestation({
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_PATH: ringPath,
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: sha(ringRaw),
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: setPath,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(setRaw)
  }, sourceSet.entries[0].runtime_attestation_sha256, sourceSet.entries[0].runtime_tuple);
  assert.equal((selection.attestation as { state: string }).state, "revoked");
});

function validServiceAttestation() {
  return {
    ...attestation(),
    schema: SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
    route_id: SAFE_READ_ROUTE_ID,
    route_contract_sha256: SAFE_READ_ROUTE_CONTRACT_SHA256,
    policy_sha256: SAFE_READ_POLICY_SHA256,
    executor_id: SAFE_READ_EXECUTOR_ID
  };
}

function serviceRequest(attestationSha: string, attempt: string, nonceHash: string) {
  return {
    schema: SAFE_READ_PREAUTHORIZATION_SCHEMA,
    route_id: SAFE_READ_ROUTE_ID,
    host_instance_id: "11111111-1111-1111-1111-111111111111",
    executor_id: SAFE_READ_EXECUTOR_ID,
    runtime_attestation_sha256: attestationSha,
    runtime_tuple: TUPLE,
    document: {
      project_fingerprint: `sha256:${"f".repeat(64)}`,
      document_session_id: "33333333-3333-3333-3333-333333333333"
    },
    client_session_id: "44444444-4444-4444-4444-444444444444",
    request_id: "55555555-5555-5555-5555-555555555555",
    attempt_id: attempt,
    capability_nonce_sha256: nonceHash
  };
}

function expectCapabilityError(fn: () => unknown, code: string): void {
  let received: unknown;
  try { fn(); } catch (error) { received = error; }
  assert.ok(received instanceof SafeReadCapabilityError);
  assert.equal(received.code, code);
}

test("hosted capability persists sequence high-water, permits signed rotation, and rejects rollback and equivocation", () => {
  const f = fixture({ attestationValue: validServiceAttestation() });
  const databasePath = path.join(path.dirname(f.setPath), "capabilities.sqlite");
  const service = new SafeReadCapabilityService({ databasePath, env: f.env, now: () => new Date("2026-07-29T20:00:00.000Z") });
  const nonce1 = Buffer.alloc(32, 1);
  service.preauthorize(`sha256:${"1".repeat(64)}`, serviceRequest(f.attestationSha, "66666666-6666-6666-6666-666666666666", sha(nonce1)));

  f.set.sequence = 8;
  f.resign();
  let raw = f.write();
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  service.preauthorize(`sha256:${"1".repeat(64)}`, serviceRequest(f.attestationSha, "77777777-7777-7777-7777-777777777777", sha(Buffer.alloc(32, 2))));

  f.set.sequence = 7;
  f.resign();
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  expectCapabilityError(
    () => service.preauthorize(`sha256:${"1".repeat(64)}`, serviceRequest(f.attestationSha, "88888888-8888-8888-8888-888888888888", sha(Buffer.alloc(32, 3)))),
    "SAFE_READ_ATTESTATION_SET_ROLLBACK"
  );

  f.set.sequence = 8;
  f.set.issued_at_utc = "2026-07-29T19:51:00.000Z";
  f.resign();
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  expectCapabilityError(
    () => service.preauthorize(`sha256:${"1".repeat(64)}`, serviceRequest(f.attestationSha, "99999999-9999-9999-9999-999999999999", sha(Buffer.alloc(32, 4)))),
    "SAFE_READ_ATTESTATION_SET_EQUIVOCATION"
  );
  service.close();

  const reopened = new SafeReadCapabilityService({ databasePath, env: f.env, now: () => new Date("2026-07-29T20:00:00.000Z") });
  expectCapabilityError(
    () => reopened.preauthorize(`sha256:${"1".repeat(64)}`, serviceRequest(f.attestationSha, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sha(Buffer.alloc(32, 5)))),
    "SAFE_READ_ATTESTATION_SET_EQUIVOCATION"
  );
  reopened.close();
});

test("hosted final authorization reloads and re-verifies the signed set before capability CAS", () => {
  const f = fixture({ attestationValue: validServiceAttestation() });
  const service = new SafeReadCapabilityService({
    databasePath: path.join(path.dirname(f.setPath), "reload.sqlite"),
    env: f.env,
    now: () => new Date("2026-07-29T20:00:00.000Z")
  });
  const nonce = Buffer.alloc(32, 9);
  const preauth = serviceRequest(f.attestationSha, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", sha(nonce));
  const capability = service.preauthorize(`sha256:${"2".repeat(64)}`, preauth);
  f.set.signatures[0]!.signature_base64url = f.set.signatures[0]!.signature_base64url.replace(
    /^./,
    f.set.signatures[0]!.signature_base64url[0] === "A" ? "B" : "A"
  );
  let raw = f.write();
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  const final = {
    ...preauth,
    schema: SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
    capability_id: capability.capability_id,
    capability_nonce: nonce.toString("base64url")
  };
  delete (final as Record<string, unknown>).capability_nonce_sha256;
  expectCapabilityError(() => service.authorizeExecution(`sha256:${"2".repeat(64)}`, final), "SAFE_READ_ATTESTATION_SIGNATURE_INVALID");

  f.resign();
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  assert.equal(service.authorizeExecution(`sha256:${"2".repeat(64)}`, final).attempt_id, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  service.close();
});
