import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DynamicProgramAdmissionError,
  issueDynamicProgramAdmission,
  signDynamicProgramAdmission,
  validateAndConsumeDynamicProgramAdmission,
  type TrustedDynamicAdmissionFactsV1
} from "../src/dynamic_runtime/admission.js";
import { DurableDynamicAdmissionReplayAuthority } from "../src/dynamic_runtime/durable_replay.js";

const h = (token: string) => `sha256:${Buffer.from(token.padEnd(32, token[0] || "0")).subarray(0, 32).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

function facts(overrides: Partial<TrustedDynamicAdmissionFactsV1> = {}): TrustedDynamicAdmissionFactsV1 {
  const timestamp = now();
  return {
    admission_id: "admission-1", normalized_source_hash: h("a"), compiled_artifact_hash: h("b"), compiler_runtime_hash: h("c"),
    sdk_version: "dynamic-revit-sdk/v1", sdk_manifest_hash: h("d"), sdk_artifact_hash: h("e"), worker_executable_hash: h("f"),
    worker_runtime_package_hash: h("1"), sandbox_profile_version: "windows-appcontainer/v2", sandbox_profile_hash: h("2"),
    authenticated_worker_identity_hash: h("3"), target_revit_version: "2024", host_adapter_manifest_hash: h("4"),
    document_fingerprint: h("5"), document_session_id: "session-1", document_revision: 10, project_context_identity_hash: h("6"),
    capability_envelope_hash: h("7"), operation_family_envelope_hash: h("8"), effect_budget_hash: h("9"), file_capability_set_hash: h("0"),
    operation_graph_hash: h("A"), preview_receipt_hash: h("B"), policy_identity_hash: h("C"), runtime_identity_hash: h("D"),
    request_family_seal_hash: h("E"), final_authorization_hash: h("F"), principal_id_hash: h("P"), principal_session_hash: h("S"),
    correlation_id: "correlation-1", replay_nonce_hash: h("N"), issued_unix_seconds: timestamp - 1, expires_unix_seconds: timestamp + 60,
    ...overrides
  };
}

function memoryReplay() {
  const used = new Set<string>();
  return { consume(key: string) { if (used.has(key)) return false; used.add(key); return true; } };
}

test("dynamic admission v1 validates trusted bindings and rejects replay", () => {
  const key = randomBytes(32); const trusted = facts(); const admission = issueDynamicProgramAdmission(trusted, key); const replay = memoryReplay();
  const accepted = validateAndConsumeDynamicProgramAdmission({ admission, trusted_facts: trusted, trusted_key: key, replay_authority: replay });
  assert.equal(accepted.document_revision, 10);
  assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission, trusted_facts: trusted, trusted_key: key, replay_authority: replay }),
    (error: unknown) => error instanceof DynamicProgramAdmissionError && error.code === "DYNAMIC_ADMISSION_REPLAY_DENIED");
});

test("dynamic admission canonical signature matches the cross-runtime golden vector", () => {
  const admission = issueDynamicProgramAdmission(facts({ issued_unix_seconds: 1000, expires_unix_seconds: 1060 }), Buffer.alloc(32, 7));
  assert.equal(admission.admission_signature, "hmac-sha256:38dcc8b3d4061dd601fb89136455ca5cf47a7c0522ff81ca922fae5d7bde2ad7");
});

test("dynamic admission rejects document, budget, policy, principal, preview, and final authorization substitution", () => {
  const fields: (keyof TrustedDynamicAdmissionFactsV1)[] = [
    "document_revision", "effect_budget_hash", "policy_identity_hash", "principal_session_hash", "preview_receipt_hash", "final_authorization_hash"
  ];
  for (const field of fields) {
    const key = randomBytes(32); const trusted = facts(); const admission = issueDynamicProgramAdmission(trusted, key);
    const changed = { ...trusted, [field]: field === "document_revision" ? 11 : h(`other-${field}`) } as TrustedDynamicAdmissionFactsV1;
    assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission, trusted_facts: changed, trusted_key: key, replay_authority: memoryReplay() }),
      (error: unknown) => error instanceof DynamicProgramAdmissionError && error.code === "DYNAMIC_ADMISSION_BINDING_DENIED");
  }
});

test("dynamic admission rejects caller-added fields, wrong signature, unsupported Revit, and expiry", () => {
  const key = randomBytes(32); const trusted = facts(); const admission = issueDynamicProgramAdmission(trusted, key);
  assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission: { ...admission, self_authorized: true }, trusted_facts: trusted, trusted_key: key, replay_authority: memoryReplay() }));
  assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission: { ...admission, admission_signature: signDynamicProgramAdmission({ ...admission, document_revision: 11 }, key) }, trusted_facts: trusted, trusted_key: key, replay_authority: memoryReplay() }));
  assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission: { ...admission, target_revit_version: "2026" }, trusted_facts: trusted, trusted_key: key, replay_authority: memoryReplay() }));
  const expiredFacts = facts({ issued_unix_seconds: now() - 20, expires_unix_seconds: now() - 1 });
  assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission: issueDynamicProgramAdmission(expiredFacts, key), trusted_facts: expiredFacts, trusted_key: key, replay_authority: memoryReplay() }));
});

test("durable replay authority rejects the same admission after process-object restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-replay-"));
  try {
    const file = path.join(root, "state.json"); const key = randomBytes(32); const trusted = facts(); const admission = issueDynamicProgramAdmission(trusted, key);
    validateAndConsumeDynamicProgramAdmission({ admission, trusted_facts: trusted, trusted_key: key, replay_authority: new DurableDynamicAdmissionReplayAuthority(file) });
    assert.throws(() => validateAndConsumeDynamicProgramAdmission({ admission, trusted_facts: trusted, trusted_key: key, replay_authority: new DurableDynamicAdmissionReplayAuthority(file) }),
      (error: unknown) => error instanceof DynamicProgramAdmissionError && error.code === "DYNAMIC_ADMISSION_REPLAY_DENIED");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("durable replay authority prunes expired entries without making the current key reusable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-replay-prune-"));
  try {
    const file = path.join(root, "state.json"); const authority = new DurableDynamicAdmissionReplayAuthority(file);
    assert.equal(authority.consume(h("old"), now() + 1, now()), true);
    assert.equal(authority.consume(h("new"), now() + 60, now() + 2), true);
    assert.equal(new DurableDynamicAdmissionReplayAuthority(file).consume(h("new"), now() + 90, now() + 3), false);
    assert.equal(new DurableDynamicAdmissionReplayAuthority(file).consume(h("old"), now() + 90, now() + 3), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
