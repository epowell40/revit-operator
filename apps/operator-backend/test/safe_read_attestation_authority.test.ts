import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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

function fixture(options: {
  sequence?: number;
  ringSequence?: number;
  ringEpoch?: string;
  signerState?: "active" | "revoked";
  attestationValue?: unknown;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-read-attestation-authority-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signerRing = {
    schema: SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA,
    epoch: options.ringEpoch ?? "test-authority-2026",
    sequence: options.ringSequence ?? 3,
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
    signer_ring: {
      epoch: signerRing.epoch,
      sequence: signerRing.sequence,
      sha256: ""
    },
    entries
  };
  const set = {
    ...payload,
    signatures: [{
      key_id: "release-2026-a",
      algorithm: "ed25519",
      signature_base64url: ""
    }]
  };
  const ringPath = path.join(root, "signers.json");
  const setPath = path.join(root, "set.json");
  const bindRing = () => {
    set.signer_ring = {
      epoch: signerRing.epoch,
      sequence: signerRing.sequence,
      sha256: sha(`${JSON.stringify(signerRing)}\n`)
    };
  };
  const resign = (key = privateKey, keyId = "release-2026-a") => {
    const signedPayload = {
      schema: set.schema,
      sequence: set.sequence,
      issued_at_utc: set.issued_at_utc,
      signer_ring: set.signer_ring,
      entries: set.entries
    };
    set.signatures = [{
      key_id: keyId,
      algorithm: "ed25519",
      signature_base64url: sign(null, Buffer.from(canonicalJson(signedPayload as unknown as JsonValue)), key).toString("base64url")
    }];
  };
  const write = () => {
    const ringRaw = `${JSON.stringify(signerRing)}\n`;
    const setRaw = `${JSON.stringify(set)}\n`;
    fs.writeFileSync(ringPath, ringRaw);
    fs.writeFileSync(setPath, setRaw);
    return { ringRaw, setRaw };
  };
  bindRing();
  resign();
  const raw = write();
  const env: NodeJS.ProcessEnv = {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_PATH: ringPath,
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: sha(raw.ringRaw),
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: setPath,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(raw.setRaw)
  };
  return { env, set, signerRing, setPath, ringPath, attestationSha, write, resign, bindRing };
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
  f.signerRing.sequence++;
  (f.signerRing.signers as Array<Record<string, unknown>>).push({
    key_id: "release-2026-b",
    algorithm: "ed25519",
    state: "active",
    public_key_spki_base64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
  });
  f.bindRing();
  f.resign(privateKey, "release-2026-b");
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

test("hosted authority rejects duplicate JSON properties at every signed boundary", () => {
  const duplicateSet = fixture();
  const validSetRaw = fs.readFileSync(duplicateSet.setPath, "utf8");
  const setRaw = validSetRaw.replace('"sequence":7', '"sequence":1,"sequence":7');
  fs.writeFileSync(duplicateSet.setPath, setRaw);
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...duplicateSet.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(setRaw)
  }, duplicateSet.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const duplicateRing = fixture();
  const validRingRaw = fs.readFileSync(duplicateRing.ringPath, "utf8");
  const ringRaw = validRingRaw.replace('"state":"active"', '"state":"revoked","state":"active"');
  fs.writeFileSync(duplicateRing.ringPath, ringRaw);
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...duplicateRing.env,
    OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256: sha(ringRaw)
  }, duplicateRing.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const duplicateEmbedded = fixture();
  const embeddedRaw = JSON.stringify(attestation()).replace('"state":"active"', '"state":"revoked","state":"active"');
  duplicateEmbedded.set.entries[0]!.attestation_json = embeddedRaw;
  duplicateEmbedded.set.entries[0]!.runtime_attestation_sha256 = sha(embeddedRaw);
  duplicateEmbedded.resign();
  const duplicateEmbeddedRaw = duplicateEmbedded.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...duplicateEmbedded.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(duplicateEmbeddedRaw.setRaw)
  }, sha(embeddedRaw), TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");
});

test("hosted authority rejects BOM, malformed UTF-8, relative paths, and non-regular files", () => {
  const bom = fixture();
  const bomRaw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(bom.setPath)]);
  fs.writeFileSync(bom.setPath, bomRaw);
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...bom.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(bomRaw)
  }, bom.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const utf8 = fixture();
  const invalidUtf8 = Buffer.concat([Buffer.from('{"schema":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  fs.writeFileSync(utf8.setPath, invalidUtf8);
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...utf8.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(invalidUtf8)
  }, utf8.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const relative = fixture();
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...relative.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: path.relative(process.cwd(), relative.setPath)
  }, relative.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_UNAVAILABLE");

  const nonRegular = fixture();
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...nonRegular.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: path.dirname(nonRegular.setPath)
  }, nonRegular.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");
});

test("hosted authority rejects oversized files before parsing and rejects linked paths", t => {
  const oversized = fixture();
  const oversizedRaw = Buffer.alloc((2 * 1024 * 1024) + 1, 0x20);
  fs.writeFileSync(oversized.setPath, oversizedRaw);
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...oversized.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(oversizedRaw)
  }, oversized.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");

  const linked = fixture();
  const linkPath = path.join(path.dirname(linked.setPath), "linked-set.json");
  try {
    fs.symlinkSync(linked.setPath, linkPath, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("symlink creation is not permitted on this Windows host");
      return;
    }
    throw error;
  }
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...linked.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH: linkPath
  }, linked.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SET_INVALID");
});

test("hosted authority binds the signed set to the exact signer-ring epoch, sequence, and bytes", () => {
  const f = fixture();
  f.set.signer_ring.sha256 = HASH_A;
  f.resign();
  const raw = f.write();
  expectAuthorityError(() => loadHostedSafeReadAttestation({
    ...f.env,
    OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256: sha(raw.setRaw)
  }, f.attestationSha, TUPLE), "SAFE_READ_ATTESTATION_SIGNER_RING_MISMATCH");
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

test("hosted capability durably rejects signer-ring rollback, equivocation, and revoked-key reactivation", () => {
  const f = fixture({ attestationValue: validServiceAttestation(), ringSequence: 1 });
  const originalRing = structuredClone(f.signerRing);
  const databasePath = path.join(path.dirname(f.setPath), "signer-ring-high-water.sqlite");
  const principal = `sha256:${"3".repeat(64)}`;
  let service = new SafeReadCapabilityService({ databasePath, env: f.env, now: () => new Date("2026-07-29T20:00:00.000Z") });
  service.preauthorize(principal, serviceRequest(f.attestationSha, "c0000000-0000-0000-0000-000000000001", sha(Buffer.alloc(32, 1))));

  const { publicKey: publicKeyB, privateKey: privateKeyB } = generateKeyPairSync("ed25519");
  f.signerRing.sequence = 2;
  f.signerRing.signers[0]!.state = "revoked";
  (f.signerRing.signers as Array<Record<string, unknown>>).push({
    key_id: "release-2026-b",
    algorithm: "ed25519",
    state: "active",
    public_key_spki_base64: publicKeyB.export({ format: "der", type: "spki" }).toString("base64")
  });
  f.set.sequence = 8;
  f.bindRing();
  f.resign(privateKeyB, "release-2026-b");
  let raw = f.write();
  f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  service.preauthorize(principal, serviceRequest(f.attestationSha, "c0000000-0000-0000-0000-000000000002", sha(Buffer.alloc(32, 2))));
  service.close();

  service = new SafeReadCapabilityService({ databasePath, env: f.env, now: () => new Date("2026-07-29T20:00:00.000Z") });
  f.signerRing.sequence = originalRing.sequence;
  f.signerRing.signers = originalRing.signers;
  f.set.sequence = 9;
  f.bindRing();
  f.resign();
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  expectCapabilityError(
    () => service.preauthorize(principal, serviceRequest(f.attestationSha, "c0000000-0000-0000-0000-000000000003", sha(Buffer.alloc(32, 3)))),
    "SAFE_READ_ATTESTATION_SIGNER_RING_ROLLBACK"
  );

  const { publicKey: publicKeyC } = generateKeyPairSync("ed25519");
  f.signerRing.sequence = 2;
  f.signerRing.signers = [
    { ...originalRing.signers[0]!, state: "revoked" },
    {
      key_id: "release-2026-b",
      algorithm: "ed25519",
      state: "active",
      public_key_spki_base64: publicKeyB.export({ format: "der", type: "spki" }).toString("base64")
    },
    {
      key_id: "release-2026-c",
      algorithm: "ed25519",
      state: "active",
      public_key_spki_base64: publicKeyC.export({ format: "der", type: "spki" }).toString("base64")
    }
  ];
  f.bindRing();
  f.resign(privateKeyB, "release-2026-b");
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  expectCapabilityError(
    () => service.preauthorize(principal, serviceRequest(f.attestationSha, "c0000000-0000-0000-0000-000000000004", sha(Buffer.alloc(32, 4)))),
    "SAFE_READ_ATTESTATION_SIGNER_RING_EQUIVOCATION"
  );

  f.signerRing.sequence = 3;
  f.signerRing.signers = [
    { ...originalRing.signers[0]!, state: "active" },
    {
      key_id: "release-2026-b",
      algorithm: "ed25519",
      state: "active",
      public_key_spki_base64: publicKeyB.export({ format: "der", type: "spki" }).toString("base64")
    }
  ];
  f.bindRing();
  f.resign(privateKeyB, "release-2026-b");
  raw = f.write();
  f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
  f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  expectCapabilityError(
    () => service.preauthorize(principal, serviceRequest(f.attestationSha, "c0000000-0000-0000-0000-000000000005", sha(Buffer.alloc(32, 5)))),
    "SAFE_READ_ATTESTATION_SIGNER_REACTIVATION"
  );
  service.close();
});

test("hosted capability rejects active-signer omission across restart and accepts only an explicit rotation chain", () => {
  const f = fixture({ attestationValue: validServiceAttestation(), ringSequence: 1 });
  const signerA = structuredClone(f.signerRing.signers[0]!);
  const { publicKey: publicKeyB, privateKey: privateKeyB } = generateKeyPairSync("ed25519");
  const signerB = {
    key_id: "release-2026-b",
    algorithm: "ed25519",
    state: "active" as const,
    public_key_spki_base64: publicKeyB.export({ format: "der", type: "spki" }).toString("base64")
  };
  const databasePath = path.join(path.dirname(f.setPath), "signer-ring-omission.sqlite");
  const principal = `sha256:${"4".repeat(64)}`;
  const publish = (): void => {
    f.bindRing();
    f.resign(privateKeyB, "release-2026-b");
    const raw = f.write();
    f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
    f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
  };
  let service = new SafeReadCapabilityService({
    databasePath,
    env: f.env,
    now: () => new Date("2026-07-29T20:00:00.000Z")
  });
  service.preauthorize(
    principal,
    serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000001", sha(Buffer.alloc(32, 1)))
  );

  f.signerRing.sequence = 2;
  f.signerRing.signers = [signerB];
  f.set.sequence = 8;
  publish();
  expectCapabilityError(
    () => service.preauthorize(
      principal,
      serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000002", sha(Buffer.alloc(32, 2)))
    ),
    "SAFE_READ_ATTESTATION_SIGNER_OMISSION"
  );
  service.close();

  service = new SafeReadCapabilityService({
    databasePath,
    env: f.env,
    now: () => new Date("2026-07-29T20:00:00.000Z")
  });
  expectCapabilityError(
    () => service.preauthorize(
      principal,
      serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000003", sha(Buffer.alloc(32, 3)))
    ),
    "SAFE_READ_ATTESTATION_SIGNER_OMISSION"
  );

  f.signerRing.signers = [{ ...signerA, state: "revoked" }, signerB];
  publish();
  service.preauthorize(
    principal,
    serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000004", sha(Buffer.alloc(32, 4)))
  );
  service.close();

  service = new SafeReadCapabilityService({
    databasePath,
    env: f.env,
    now: () => new Date("2026-07-29T20:00:00.000Z")
  });
  f.signerRing.sequence = 3;
  f.signerRing.signers = [signerB];
  f.set.sequence = 9;
  publish();
  service.preauthorize(
    principal,
    serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000005", sha(Buffer.alloc(32, 5)))
  );
  service.close();

  service = new SafeReadCapabilityService({
    databasePath,
    env: f.env,
    now: () => new Date("2026-07-29T20:00:00.000Z")
  });
  f.signerRing.sequence = 4;
  f.signerRing.signers = [{ ...signerA, state: "active" }, signerB];
  f.set.sequence = 10;
  publish();
  expectCapabilityError(
    () => service.preauthorize(
      principal,
      serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000006", sha(Buffer.alloc(32, 6)))
    ),
    "SAFE_READ_ATTESTATION_SIGNER_REACTIVATION"
  );

  const { publicKey: substitutedKey } = generateKeyPairSync("ed25519");
  f.signerRing.signers = [{
    ...signerA,
    state: "revoked",
    public_key_spki_base64: substitutedKey.export({ format: "der", type: "spki" }).toString("base64")
  }, signerB];
  publish();
  expectCapabilityError(
    () => service.preauthorize(
      principal,
      serviceRequest(f.attestationSha, "d0000000-0000-0000-0000-000000000007", sha(Buffer.alloc(32, 7)))
    ),
    "SAFE_READ_ATTESTATION_SIGNER_IDENTITY_REUSE"
  );
  service.close();
});

test("hosted capability fails closed when durable signer-ring predecessor history is missing", () => {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as new (name: string) => {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
  for (const [index, missingEvidence] of ["legacy-ledger", "identity-row"].entries()) {
    const f = fixture({ attestationValue: validServiceAttestation(), ringSequence: 1 });
    const databasePath = path.join(path.dirname(f.setPath), `missing-predecessor-${index}.sqlite`);
    const principal = `sha256:${"5".repeat(64)}`;
    if (missingEvidence === "legacy-ledger") {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE safe_read_attestation_high_water (
          authority_id TEXT PRIMARY KEY,
          set_sequence INTEGER NOT NULL,
          set_sha256 TEXT NOT NULL,
          signer_ring_epoch TEXT NOT NULL,
          signer_ring_sequence INTEGER NOT NULL,
          signer_ring_sha256 TEXT NOT NULL,
          accepted_at_ms INTEGER NOT NULL
        )
      `);
      db.prepare(`
        INSERT INTO safe_read_attestation_high_water(
          authority_id, set_sequence, set_sha256, signer_ring_epoch,
          signer_ring_sequence, signer_ring_sha256, accepted_at_ms
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        "safe-read.hosted-attestation-set.v1",
        f.set.sequence,
        f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256!,
        f.signerRing.epoch,
        f.signerRing.sequence,
        f.set.signer_ring.sha256,
        Date.parse("2026-07-29T20:00:00.000Z")
      );
      db.close();
    } else {
      const initial = new SafeReadCapabilityService({
        databasePath,
        env: f.env,
        now: () => new Date("2026-07-29T20:00:00.000Z")
      });
      initial.preauthorize(
        principal,
        serviceRequest(f.attestationSha, "e0000000-0000-0000-0000-000000000001", sha(Buffer.alloc(32, 1)))
      );
      initial.close();
      const db = new Database(databasePath);
      db.prepare("DELETE FROM safe_read_attestation_signer_identities").run();
      db.close();
    }

    const { publicKey: publicKeyB, privateKey: privateKeyB } = generateKeyPairSync("ed25519");
    f.signerRing.sequence = 2;
    f.signerRing.signers[0]!.state = "revoked";
    (f.signerRing.signers as Array<Record<string, unknown>>).push({
      key_id: "release-2026-b",
      algorithm: "ed25519",
      state: "active",
      public_key_spki_base64: publicKeyB.export({ format: "der", type: "spki" }).toString("base64")
    });
    f.set.sequence = 8;
    f.bindRing();
    f.resign(privateKeyB, "release-2026-b");
    const raw = f.write();
    f.env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256 = sha(raw.ringRaw);
    f.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256 = sha(raw.setRaw);
    const service = new SafeReadCapabilityService({
      databasePath,
      env: f.env,
      now: () => new Date("2026-07-29T20:00:00.000Z")
    });
    expectCapabilityError(
      () => service.preauthorize(
        principal,
        serviceRequest(
          f.attestationSha,
          `e0000000-0000-0000-0000-00000000001${index + 1}`,
          sha(Buffer.alloc(32, index + 3))
        )
      ),
      "SAFE_READ_ATTESTATION_SIGNER_PREDECESSOR_MISSING"
    );
    service.close();
  }
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
