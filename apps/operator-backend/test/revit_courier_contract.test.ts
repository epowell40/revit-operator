import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { decideCodexStreaming, revitCourierTargetFromContext } from "../src/brains/codex_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from "../src/courier/revit_courier_context.js";
import {
  REVIT_COURIER_JOB_VERSION,
  authorizeRevitToolJobExecution,
  claimNextRevitToolJob,
  completeRevitToolJob,
  failRevitToolJob
} from "../src/courier/revit_tool_jobs.js";
import { canonicalJson, computeRequestHash, sha256 } from "../src/capabilities/tool_certification.js";
import {
  assertCertifiedCourierExecutionResult,
  authorizeCertifiedCourierFinalExecution,
  RevitCourierCertificationError
} from "../src/courier/revit_tool_job_certification.js";
const MOVE_PREVIEW_EFFECT_HASH = "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b";
const MOVE_APPLY_EFFECT_HASH = "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b";
const nativeAttestationKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const nativeAttestationJwk = nativeAttestationKeyPair.publicKey.export({ format: "jwk" });
if (!nativeAttestationJwk.n || !nativeAttestationJwk.e) throw new Error("Native test key is unavailable.");
const nativeAttestationKey = {
  modulus: nativeAttestationJwk.n,
  exponent: nativeAttestationJwk.e,
  keyId: sha256({
    algorithm: "RS256",
    exponent_base64url: nativeAttestationJwk.e,
    modulus_base64url: nativeAttestationJwk.n
  } as never)
};

test.beforeEach(() => {
  // Existing v1 contract fixtures model the intentionally isolated escape
  // hatch. Production/local/default execution is certified and must not claim
  // those fixtures.
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
});

function writeJob(root: string, overrides: Record<string, unknown> = {}): string {
  const id = randomUUID().replace(/-/g, "");
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    version: REVIT_COURIER_JOB_VERSION,
    id,
    session_id: "session-a",
    message_id: "message-a",
    correlation_id: id,
    idempotency_key: "a".repeat(64),
    method: "GET",
    path: "/revit/ping",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    claim: null,
    ...overrides
  }), "utf8");
  return id;
}

function writeCertifiedPolicy(root: string, options: { exposed?: boolean; policyHashSuffix?: string } = {}): {
  policyPath: string;
  policyHash: string;
  record: Record<string, unknown>;
} {
  const recordBase = {
    method: "POST",
    path: "/revit/ping",
    typed_mcp_aliases: ["revit_ping"],
    request_hash: computeRequestHash("POST", "/revit/ping", { a: 1, z: "raw" }),
    effect_hash: `sha256:${"2".repeat(64)}`,
    evidence_record_hash: `sha256:${"3".repeat(64)}`,
    highest_cumulative_level: "L4",
    observed_levels: ["L0", "L1", "L2", "L3", "L4"],
    visibility: "candidate",
    channels: {
      search: { exposed: options.exposed !== false, required_level: "L3", reason_codes: [options.exposed === false ? "CERT_EVIDENCE_REVOKED" : "CERTIFIED"] },
      generic_call: { exposed: options.exposed !== false, required_level: "L4", reason_codes: [options.exposed === false ? "CERT_EVIDENCE_REVOKED" : "CERTIFIED"] },
      typed_mcp: { exposed: options.exposed !== false, required_level: "L4", reason_codes: [options.exposed === false ? "CERT_EVIDENCE_REVOKED" : "CERTIFIED"] },
      deterministic_workflow: { exposed: options.exposed !== false, required_level: "L4", reason_codes: [options.exposed === false ? "CERT_EVIDENCE_REVOKED" : "CERTIFIED"] }
    }
  };
  const record = { ...recordBase, policy_record_hash: sha256(recordBase as any) };
  const policyBase = {
    schema: "revit-operator.tool-exposure-policy.v1",
    hash_algorithm: "sha256",
    evidence_schema: "revit-operator.tool-certification-evidence.v1",
    evidence_source_hash: `sha256:${"4".repeat(64)}`,
    records: [record]
  };
  const policy = { ...policyBase, policy_hash: sha256(policyBase as any) };
  const policyPath = path.join(root, `courier-policy-${options.policyHashSuffix ?? "current"}.json`);
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash, record };
}

function writeCertifiedV2Job(
  root: string,
  policy: ReturnType<typeof writeCertifiedPolicy>,
  overrides: Record<string, unknown> = {},
  context: Partial<{
    session_id: string;
    message_id: string | null;
    expires_at: string;
    target_executor_id: string | null;
    target_document_title: string | null;
    target_document_path: string | null;
  }> = {}
): string {
  const sessionId = context.session_id ?? "session-a";
  const messageId = context.message_id === undefined ? "message-a" : context.message_id;
  const targetExecutorId = context.target_executor_id === undefined ? "worker-1" : context.target_executor_id;
  const targetDocumentTitle = context.target_document_title === undefined ? "Snowdon" : context.target_document_title;
  const targetDocumentPath = context.target_document_path === undefined ? "C:\\models\\Snowdon.rvt" : context.target_document_path;
  const expiresAt = new Date(Date.parse(context.expires_at ?? new Date(Date.now() + 60_000).toISOString())).toISOString();
  const rawBody = "{\n  \"z\": \"raw\", \"a\": 1\n}";
  const bodyHash = `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
  const envelopeBase = {
    schema: "revit-operator.revit-tool-certification-envelope.v1",
    version: 1,
    canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    policy_hash: policy.policyHash,
    policy_record_hash: policy.record.policy_record_hash,
    evidence_record_hash: policy.record.evidence_record_hash,
    request_hash: policy.record.request_hash,
    effect_hash: policy.record.effect_hash,
    method: "POST",
    path: "/revit/ping",
    body_present: true,
    body_sha256: bodyHash,
    channel: "typed_mcp",
    alias: "revit_ping",
    runtime_mode: "local",
    exposure_profile: "certified",
    policy_trust_source: "deployment"
  };
  const envelope = {
    ...envelopeBase,
    envelope_hash: `sha256:${createHash("sha256").update(canonicalJson(envelopeBase as any), "utf8").digest("hex")}`
  };
  const identity = {
    schema: "revit-operator.revit-tool-job-idempotency.v2",
    canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    session_id: sessionId,
    message_id: messageId,
    expires_at: expiresAt,
    turn_token_sha256: null,
    target_executor_id: targetExecutorId,
    target_document_title: targetDocumentTitle,
    target_document_path: targetDocumentPath,
    method: "POST",
    path: "/revit/ping",
    body_present: true,
    body_sha256: bodyHash,
    certification_envelope_hash: envelope.envelope_hash
  };
  const id = createHash("sha256").update(canonicalJson(identity as any), "utf8").digest("hex");
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    version: "revit-operator.revit-tool-job.v2",
    id,
    session_id: sessionId,
    message_id: messageId,
    turn_token_sha256: null,
    correlation_id: id,
    idempotency_key: id,
    method: "POST",
    path: "/revit/ping",
    target_executor_id: targetExecutorId,
    target_document_title: targetDocumentTitle,
    target_document_path: targetDocumentPath,
    body: rawBody,
    body_json: rawBody,
    body_present: true,
    certification_envelope: envelope,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    status: "pending",
    claim: null,
    ...overrides
  }, null, 2), "utf8");
  return id;
}

function courierMoveBody(dryRun: boolean) {
  return {
    ids: [84], mode: "vector", vectorX: 0, vectorY: 0.5, vectorZ: 0, dryRun,
    behavior: "allOrNothing", moveTogether: false,
    options: { failOnPinned: true, unpinIfAllowed: false }
  };
}

function courierMoveAdmission(
  phase: "preview" | "apply",
  previewInstanceHash: string | null,
  body: ReturnType<typeof courierMoveBody>,
  previewReceipt: string | null = null,
  admissionSessionId = "b".repeat(32)
) {
  const familyHash = "sha256:24906494c42d86326cfba2c4b76318e8172f83f9cb65cd8aa0c84f7e1281e0de";
  const documentFingerprint = `sha256:${"b".repeat(64)}`;
  const documentSessionId = "22222222222242228222222222222222";
  const observationBindingHash = `sha256:${createHash("sha256").update([
    "observation-84", documentFingerprint, documentSessionId, "host:84", "84", nativeAttestationKey.keyId
  ].join("\n"), "utf8").digest("hex")}`;
  const previewReceiptHash = previewReceipt === null ? null
    : `sha256:${createHash("sha256").update(previewReceipt, "utf8").digest("hex")}`;
  const request = {
    phase, documentFingerprint, documentSessionId, sourceScopedId: "host:84", elementId: 84, observationId: "observation-84",
    observationBindingHash,
    nativeAttestationKeyId: nativeAttestationKey.keyId,
    nativeAttestationModulusBase64Url: nativeAttestationKey.modulus,
    nativeAttestationExponentBase64Url: nativeAttestationKey.exponent,
    vectorFeet: { x: 0, y: 0.5, z: 0 },
    ...(previewInstanceHash === null ? {} : { previewInstanceHash, previewReceiptHash })
  };
  return {
    schema: "revit-operator.certified-request-family-admission.v1",
    family_id: "revit-operator.certified-move-one.request-family.v1",
    family_hash: familyHash,
    request_instance_hash: sha256({ familyHash, admissionSessionId, request, outboundBody: body } as never),
    phase,
    preview_instance_hash: previewInstanceHash,
    preview_receipt: previewReceipt,
    preview_receipt_hash: previewReceiptHash,
    document_fingerprint: documentFingerprint,
    document_session_id: documentSessionId,
    source_scoped_id: "host:84", element_id: 84, observation_id: "observation-84",
    observation_binding_hash: observationBindingHash,
    native_attestation_key_id: nativeAttestationKey.keyId,
    native_attestation_modulus_base64url: nativeAttestationKey.modulus,
    native_attestation_exponent_base64url: nativeAttestationKey.exponent,
    admission_session_id: admissionSessionId,
    outbound_body_sha256: `sha256:${createHash("sha256").update(canonicalJson(body as never), "utf8").digest("hex")}`
  };
}

function certifiedMovePolicy(root: string) {
  const recordBase = {
    method: "POST", path: "/revit/move-elements", typed_mcp_aliases: ["revit_move_one_certified"],
    request_hash: computeRequestHash("POST", "/revit/move-elements", courierMoveBody(true)),
    effect_hash: MOVE_PREVIEW_EFFECT_HASH, evidence_record_hash: `sha256:${"8".repeat(64)}`,
    request_family: {
      schema: "revit-operator.certified-request-family.v1",
      id: "revit-operator.certified-move-one.request-family.v1",
      validator_hash: "sha256:24906494c42d86326cfba2c4b76318e8172f83f9cb65cd8aa0c84f7e1281e0de"
    },
    highest_cumulative_level: "L4", observed_levels: ["L0", "L1", "L2", "L3", "L4"], visibility: "candidate",
    channels: {
      search: { exposed: true, required_level: "L3", reason_codes: ["CERTIFIED"] },
      generic_call: { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] },
      typed_mcp: { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] },
      deterministic_workflow: { exposed: false, required_level: "L4", reason_codes: ["CERT_CHANNEL_NOT_REQUESTED"] }
    }
  };
  const record = { ...recordBase, policy_record_hash: sha256(recordBase as never) };
  const applyBase = {
    ...recordBase,
    request_hash: computeRequestHash("POST", "/revit/move-elements", courierMoveBody(false)),
    effect_hash: MOVE_APPLY_EFFECT_HASH,
    evidence_record_hash: `sha256:${"a".repeat(64)}`
  };
  const applyRecord = { ...applyBase, policy_record_hash: sha256(applyBase as never) };
  const policyBase = {
    schema: "revit-operator.tool-exposure-policy.v1", hash_algorithm: "sha256",
    evidence_schema: "revit-operator.tool-certification-evidence.v1", evidence_source_hash: `sha256:${"9".repeat(64)}`,
    records: [record, applyRecord]
  };
  const policy = { ...policyBase, policy_hash: sha256(policyBase as never) };
  const policyPath = path.join(root, "move-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy), "utf8");
  return { policy, record, applyRecord, policyPath };
}

function certifiedMoveJob(
  policy: ReturnType<typeof certifiedMovePolicy>,
  body: ReturnType<typeof courierMoveBody>,
  admission: ReturnType<typeof courierMoveAdmission>,
  forcedEffect?: "preview" | "apply"
) {
  const bodyJson = canonicalJson(body as never);
  const policyRecord = (forcedEffect ?? admission.phase) === "preview" ? policy.record : policy.applyRecord;
  const envelopeBase = {
    schema: "revit-operator.revit-tool-certification-envelope.v2", version: 2,
    canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    policy_hash: policy.policy.policy_hash, policy_record_hash: policyRecord.policy_record_hash,
    evidence_record_hash: policyRecord.evidence_record_hash,
    request_hash: admission.request_instance_hash, effect_hash: policyRecord.effect_hash,
    method: "POST", path: "/revit/move-elements", body_present: true,
    body_sha256: `sha256:${createHash("sha256").update(bodyJson).digest("hex")}`,
    channel: "typed_mcp", alias: "revit_move_one_certified", runtime_mode: "local",
    exposure_profile: "certified", policy_trust_source: "deployment", request_family_admission: admission
  };
  const envelope = { ...envelopeBase, envelope_hash: `sha256:${createHash("sha256").update(canonicalJson(envelopeBase as never)).digest("hex")}` };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const identity = {
    schema: "revit-operator.revit-tool-job-idempotency.v2", canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    session_id: "session-move", message_id: "message-move", expires_at: expiresAt, turn_token_sha256: null,
    target_executor_id: "worker-1", target_document_title: "Snowdon Mechanical",
    target_document_path: "C:\\models\\SnowdonMechanical.rvt", method: "POST", path: "/revit/move-elements",
    body_present: true, body_sha256: envelope.body_sha256, certification_envelope_hash: envelope.envelope_hash
  };
  const id = createHash("sha256").update(canonicalJson(identity as never)).digest("hex");
  return {
    version: "revit-operator.revit-tool-job.v2", id, session_id: "session-move", message_id: "message-move",
    turn_token_sha256: null, correlation_id: id, idempotency_key: id, method: "POST", path: "/revit/move-elements",
    target_executor_id: "worker-1", target_document_title: "Snowdon Mechanical",
    target_document_path: "C:\\models\\SnowdonMechanical.rvt", body: bodyJson, body_json: bodyJson, body_present: true,
    certification_envelope: envelope, created_at: new Date().toISOString(), expires_at: expiresAt, status: "pending", claim: null
  };
}

function certifiedMoveExecutionResult(
  job: ReturnType<typeof certifiedMoveJob>,
  admission: ReturnType<typeof courierMoveAdmission>,
  executionContext: {
    executor_id: string;
    completion_challenge_hash: string;
  },
  previewReceipt: string | null = null,
  transportKind: "courier" | "direct" = "courier"
) {
  const envelope = job.certification_envelope;
  const nativeResult: Record<string, unknown> = {
    status: admission.phase === "preview" ? "Dry Run" : "Moved",
    movedIds: [admission.element_id],
    skipped: [],
    warnings: [],
    snapshots: [{
      id: admission.element_id,
      before: { kind: "LocationPoint", pointXyz: [0, 0, 0] },
      after: { kind: "LocationPoint", pointXyz: [0, 0.5, 0] }
    }],
    movedTogether: false,
    rolledBack: admission.phase === "preview"
  };
  const resultProjection = {
    ...nativeResult,
    snapshots: [{
      id: admission.element_id,
      before: { kind: "LocationPoint", point_bits: ["0000000000000000", "0000000000000000", "0000000000000000"] },
      after: { kind: "LocationPoint", point_bits: ["0000000000000000", "3fe0000000000000", "0000000000000000"] }
    }]
  };
  const preview = admission.phase === "preview" ? {
    schema: "revit-operator.certified-move-preview-receipt.v1",
    preview_receipt: previewReceipt ?? `cmpr1_${"C".repeat(43)}`,
    preview_instance_hash: admission.request_instance_hash,
    admission_session_id: admission.admission_session_id,
    issued_at_utc: "2026-08-08T12:00:00.000Z"
  } : null;
  const previewWithHash = preview === null ? null : {
    ...preview,
    preview_receipt_hash: `sha256:${createHash("sha256").update(preview.preview_receipt, "utf8").digest("hex")}`
  };
  const receipt: Record<string, unknown> = {
    schema: "revit-operator.certified-family-execution-receipt.v1", phase: admission.phase,
    request_instance_hash: admission.request_instance_hash, family_id: admission.family_id, family_hash: admission.family_hash,
    document_fingerprint: admission.document_fingerprint, document_session_id: admission.document_session_id,
    source_scoped_id: admission.source_scoped_id, element_id: admission.element_id, observation_id: admission.observation_id,
    observation_binding_hash: admission.observation_binding_hash, admission_session_id: admission.admission_session_id,
    policy_hash: envelope.policy_hash, policy_record_hash: envelope.policy_record_hash,
    evidence_record_hash: envelope.evidence_record_hash, effect_hash: envelope.effect_hash,
    channel: envelope.channel, alias: envelope.alias,
    transport_kind: transportKind, dispatch_id: job.id, correlation_id: job.correlation_id,
    execution_session_id: job.session_id, executor_id: executionContext.executor_id,
    certification_envelope_hash: envelope.envelope_hash,
    completion_challenge_hash: executionContext.completion_challenge_hash,
    preview_receipt_schema: previewWithHash?.schema ?? null,
    preview_receipt_hash: previewWithHash?.preview_receipt_hash ?? null,
    preview_instance_hash: previewWithHash?.preview_instance_hash ?? null,
    preview_admission_session_id: previewWithHash?.admission_session_id ?? null,
    preview_issued_at_utc: previewWithHash?.issued_at_utc ?? null,
    outcome: admission.phase === "preview" ? "rolled_back" : "committed",
    affected_element_ids: [admission.element_id], outcome_unknown: false,
    result_hash: `sha256:${createHash("sha256").update(canonicalJson(resultProjection as never), "utf8").digest("hex")}`,
    native_attestation_key_id: nativeAttestationKey.keyId
  };
  receipt.native_attestation_signature = sign(
    "sha256",
    Buffer.from(canonicalJson(receipt as never), "utf8"),
    nativeAttestationKeyPair.privateKey
  ).toString("base64url");
  const result: Record<string, unknown> = {
    ...nativeResult,
    certified_execution_receipt: receipt
  };
  if (previewWithHash) result.certified_preview_receipt = previewWithHash;
  return result;
}

function testCompletionChallenge(seed = "D") {
  const completion_challenge = `cmcc1_${seed.repeat(43)}`;
  return {
    completion_challenge,
    completion_challenge_hash: `sha256:${createHash("sha256").update(completion_challenge, "utf8").digest("hex")}`
  };
}

function testExecutionContext(job: ReturnType<typeof certifiedMoveJob>, challenge = testCompletionChallenge()) {
  return {
    schema: "revit-operator.certified-courier-execution-context.v1" as const,
    transport_kind: "courier" as const,
    dispatch_id: job.id,
    correlation_id: job.correlation_id,
    execution_session_id: job.session_id,
    executor_id: "worker-1",
    certification_envelope_hash: job.certification_envelope.envelope_hash,
    completion_challenge_hash: challenge.completion_challenge_hash
  };
}

test("legacy v1 courier escape requires exact ordinal development laboratory environment values", () => {
  const deniedRuntimes = [
    { label: "default local", mode: "local", profile: undefined },
    { label: "local laboratory", mode: "local", profile: "laboratory" },
    { label: "hosted laboratory", mode: "hosted", profile: "laboratory" },
    { label: "mode case variant", mode: "Development", profile: "laboratory" },
    { label: "mode leading whitespace", mode: " development", profile: "laboratory" },
    { label: "mode trailing whitespace", mode: "development ", profile: "laboratory" },
    { label: "profile case variant", mode: "development", profile: "Laboratory" },
    { label: "profile leading whitespace", mode: "development", profile: " laboratory" },
    { label: "profile trailing whitespace", mode: "development", profile: "laboratory " }
  ] as const;

  for (const runtime of deniedRuntimes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v1-certification-denied-"));
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.REVIT_OPERATOR_MODE = runtime.mode;
    if (runtime.profile === undefined) delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    else process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = runtime.profile;

    const deniedId = writeJob(root);
    assert.equal(
      claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job,
      null,
      runtime.label
    );
    const denied = JSON.parse(fs.readFileSync(
      path.join(root, "artifacts", "revit-courier", "jobs", deniedId, "result.json"),
      "utf8"
    ));
    assert.equal(denied.status, "failed", runtime.label);
    assert.equal(denied.code, "CERTIFICATION_LEGACY_V1_DENIED", runtime.label);
    assert.equal(denied.retryable, false, runtime.label);
    assert.equal(denied.phase, "certification_final_execution", runtime.label);
    assert.equal(denied.outcome_unknown, false, runtime.label);
  }

  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v1-certification-allowed-"));
  process.env.OPERATOR_WORKSPACE_ROOT = allowedRoot;
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  const allowedId = writeJob(allowedRoot);
  assert.equal(
    claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id,
    allowedId,
    "exact development laboratory"
  );
});

test("v2 courier claim and final authorization bind the raw body, session, executor, target, and current pinned policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-authorize-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = writeCertifiedPolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
  const id = writeCertifiedV2Job(root, policy);

  const claim = claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job;
  assert.equal(claim?.id, id);
  const authorized = authorizeRevitToolJobExecution({ session_id: "session-a", job_id: id, executor_id: "worker-1" });
  assert.equal(authorized.authorization.phase, "certification_final_execution");
  assert.equal(authorized.authorization.body_json, "{\n  \"z\": \"raw\", \"a\": 1\n}");
  assert.equal(authorized.authorization.target_document_path, "C:\\models\\Snowdon.rvt");
  assert.equal(authorized.authorization.policy_hash, policy.policyHash);
});

test("courier final authorization independently validates and consumes the same sealed move-family lineage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-"));
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;

  const previewBody = courierMoveBody(true);
  const previewAdmission = courierMoveAdmission("preview", null, previewBody);
  const previewJob = certifiedMoveJob(policy, previewBody, previewAdmission);
  const preflight = authorizeCertifiedCourierFinalExecution(previewJob, "worker-1", "preflight", {
    completion_challenge: null, completion_challenge_hash: null
  });
  assert.equal(preflight.authorization_stage, "preflight");
  const preview = authorizeCertifiedCourierFinalExecution(previewJob, "worker-1", "final", testCompletionChallenge("E"));
  assert.deepEqual(preview.request_family_admission, previewAdmission);
  assert.equal(preview.version, "revit-operator.revit-tool-final-authorization.v2");
  assert.equal(preview.authorization_stage, "final");
  assert.equal(preview.target_document_title, "Snowdon Mechanical");

  const applyBody = courierMoveBody(false);
  const applyAdmission = courierMoveAdmission("apply", previewAdmission.request_instance_hash, applyBody, `cmpr1_${"B".repeat(43)}`);
  const broadenedApply = certifiedMoveJob(policy, applyBody, applyAdmission, "preview");
  assert.throws(
    () => authorizeCertifiedCourierFinalExecution(broadenedApply, "worker-1", "final", testCompletionChallenge("F")),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_REQUEST_FAMILY_DENIED"
  );
  const applyJob = certifiedMoveJob(policy, applyBody, applyAdmission);
  const apply = authorizeCertifiedCourierFinalExecution(applyJob, "worker-1", "final", testCompletionChallenge("G"));
  assert.equal(apply.request_family_admission?.preview_instance_hash, previewAdmission.request_instance_hash);
  assert.equal(apply.request_family_admission?.document_session_id, "22222222222242228222222222222222");
  assert.equal(apply.request_hash, applyAdmission.request_instance_hash);
  assert.equal(apply.effect_hash, MOVE_APPLY_EFFECT_HASH);

  assert.throws(
    () => authorizeCertifiedCourierFinalExecution(applyJob, "worker-1", "final", testCompletionChallenge("H")),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED"
  );
});

test("courier family envelope rejects forged instance/body and stale policy bindings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-adversarial-"));
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);
  const admission = courierMoveAdmission("preview", null, body, null, "f".repeat(32));
  const forged = certifiedMoveJob(policy, body, { ...admission, request_instance_hash: `sha256:${"0".repeat(64)}` });
  assert.throws(
    () => authorizeCertifiedCourierFinalExecution(forged, "worker-1", "final", testCompletionChallenge("I")),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_REQUEST_FAMILY_DENIED"
  );

  const stale = certifiedMoveJob(policy, body, admission) as any;
  stale.certification_envelope.policy_hash = `sha256:${"1".repeat(64)}`;
  // Re-seal the outer envelope so the test reaches the current-policy check.
  const { envelope_hash: _old, ...payload } = stale.certification_envelope;
  stale.certification_envelope.envelope_hash = `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
  assert.throws(
    () => authorizeCertifiedCourierFinalExecution(stale, "worker-1", "final", testCompletionChallenge("J")),
    (error: unknown) => error instanceof RevitCourierCertificationError
  );
});

test("durable courier family authorization separates non-consuming preflight from one consuming final stage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-stages-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);
  const admission = courierMoveAdmission("preview", null, body, null, "d".repeat(32));
  const job = certifiedMoveJob(policy, body, admission);
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: "session-move", executor_id: "worker-1" }).job?.id, job.id);
  const preflight = authorizeRevitToolJobExecution({
    session_id: "session-move", job_id: job.id, executor_id: "worker-1", authorization_stage: "preflight"
  }).authorization;
  assert.equal(preflight.authorization_stage, "preflight");
  assert.equal(preflight.completion_challenge, null);
  assert.equal(preflight.completion_challenge_hash, null);
  const final = authorizeRevitToolJobExecution({
    session_id: "session-move", job_id: job.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  assert.equal(final.authorization_stage, "final");
  assert.match(final.completion_challenge!, /^cmcc1_[A-Za-z0-9_-]{43}$/);
  assert.equal(final.completion_challenge_hash, `sha256:${createHash("sha256").update(final.completion_challenge!, "utf8").digest("hex")}`);
  assert.throws(
    () => authorizeRevitToolJobExecution({
      session_id: "session-move", job_id: job.id, executor_id: "worker-1", authorization_stage: "final"
    }),
    /CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED/
  );
  const terminal = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(terminal.retryable, false);
  assert.equal(terminal.outcome_unknown, true);
});

test("courier completion requires an exact native family outcome receipt and terminalizes mismatch as unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-receipt-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);
  const admission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const job = certifiedMoveJob(policy, body, admission);
  const context = testExecutionContext(job);
  const result = certifiedMoveExecutionResult(job, admission, context);
  assert.doesNotThrow(() => assertCertifiedCourierExecutionResult(job, result, context));
  assert.throws(
    () => assertCertifiedCourierExecutionResult(job, {
      ...result,
      certified_execution_receipt: { ...(result.certified_execution_receipt as object), affected_element_ids: [85] }
    }, context),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_EXECUTION_RECEIPT_INVALID"
  );
  assert.throws(
    () => assertCertifiedCourierExecutionResult(job, {
      ...result,
      certified_execution_receipt: {
        ...(result.certified_execution_receipt as object),
        native_attestation_signature: "A".repeat(342)
      }
    }, context),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_EXECUTION_ATTESTATION_INVALID"
  );
  assert.throws(
    () => assertCertifiedCourierExecutionResult(job, { ...result, status: "caller-forged" }, context),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_EXECUTION_ATTESTATION_INVALID"
  );

  const dir = path.join(root, "artifacts", "revit-courier", "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: "session-move", executor_id: "worker-1" }).job?.id, job.id);
  const mismatchAuthorization = authorizeRevitToolJobExecution({
    session_id: "session-move", job_id: job.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  const mismatchContext = {
    ...context,
    completion_challenge_hash: mismatchAuthorization.completion_challenge_hash!
  };
  const mismatchResult = certifiedMoveExecutionResult(job, admission, mismatchContext);
  const terminal = completeRevitToolJob({
    session_id: "session-move", job_id: job.id, executor_id: "worker-1",
    result: { ...mismatchResult, certified_preview_receipt: undefined }
  });
  assert.equal(terminal.status, "failed");
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(receipt.code, "CERTIFICATION_JOB_MALFORMED");
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.outcome_unknown, true);
  assert.equal(receipt.phase, "certification_execution_receipt");

  const successRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-receipt-success-"));
  process.env.OPERATOR_WORKSPACE_ROOT = successRoot;
  const successAdmission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const successJob = certifiedMoveJob(policy, body, successAdmission);
  const successDir = path.join(successRoot, "artifacts", "revit-courier", "jobs", successJob.id);
  fs.mkdirSync(successDir, { recursive: true });
  fs.writeFileSync(path.join(successDir, "job.json"), JSON.stringify(successJob), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: "session-move", executor_id: "worker-1" }).job?.id, successJob.id);
  const successAuthorization = authorizeRevitToolJobExecution({
    session_id: "session-move", job_id: successJob.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  const successContext = testExecutionContext(successJob, {
    completion_challenge: successAuthorization.completion_challenge!,
    completion_challenge_hash: successAuthorization.completion_challenge_hash!
  });
  const successResult = certifiedMoveExecutionResult(successJob, successAdmission, successContext);
  const succeeded = completeRevitToolJob({
    session_id: "session-move", job_id: successJob.id, executor_id: "worker-1", result: successResult
  });
  assert.equal(succeeded.status, "succeeded");
  const successReceipt = JSON.parse(fs.readFileSync(path.join(successDir, "result.json"), "utf8"));
  assert.equal(successReceipt.status, "succeeded");
  assert.equal(successReceipt.result.certified_execution_receipt.request_instance_hash, successAdmission.request_instance_hash);
  assert.deepEqual(successReceipt.certified_execution_context, successContext);
  assert.equal(fs.existsSync(path.join(successDir, "completion-challenge-consumed.v1.json")), true);
});

test("courier completion challenge rejects cross-job, cross-workspace, and direct-transport replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-completion-replay-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);

  const firstAdmission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const firstJob = certifiedMoveJob(policy, body, firstAdmission);
  const firstDir = path.join(root, "artifacts", "revit-courier", "jobs", firstJob.id);
  fs.mkdirSync(firstDir, { recursive: true });
  fs.writeFileSync(path.join(firstDir, "job.json"), JSON.stringify(firstJob), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: firstJob.session_id, executor_id: "worker-1" }).job?.id, firstJob.id);
  const firstAuthorization = authorizeRevitToolJobExecution({
    session_id: firstJob.session_id, job_id: firstJob.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  const firstContext = testExecutionContext(firstJob, {
    completion_challenge: firstAuthorization.completion_challenge!,
    completion_challenge_hash: firstAuthorization.completion_challenge_hash!
  });
  const firstResult = certifiedMoveExecutionResult(firstJob, firstAdmission, firstContext);

  const directResult = certifiedMoveExecutionResult(firstJob, firstAdmission, firstContext, null, "direct");
  assert.throws(
    () => assertCertifiedCourierExecutionResult(firstJob, directResult, firstContext),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_EXECUTION_RECEIPT_INVALID"
  );

  const secondAdmission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const secondJob = certifiedMoveJob(policy, body, secondAdmission);
  const secondDir = path.join(root, "artifacts", "revit-courier", "jobs", secondJob.id);
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, "job.json"), JSON.stringify(secondJob), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: secondJob.session_id, executor_id: "worker-1" }).job?.id, secondJob.id);
  authorizeRevitToolJobExecution({
    session_id: secondJob.session_id, job_id: secondJob.id, executor_id: "worker-1", authorization_stage: "final"
  });
  const crossJob = completeRevitToolJob({
    session_id: secondJob.session_id, job_id: secondJob.id, executor_id: "worker-1", result: firstResult
  });
  assert.equal(crossJob.status, "failed");
  const crossJobReceipt = JSON.parse(fs.readFileSync(path.join(secondDir, "result.json"), "utf8"));
  assert.equal(crossJobReceipt.code, "CERTIFICATION_EXECUTION_RECEIPT_INVALID");
  assert.equal(crossJobReceipt.outcome_unknown, true);
  assert.equal(fs.existsSync(path.join(secondDir, "completion-challenge-consumed.v1.json")), false);

  const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-completion-foreign-workspace-"));
  process.env.OPERATOR_WORKSPACE_ROOT = foreignRoot;
  const foreignDir = path.join(foreignRoot, "artifacts", "revit-courier", "jobs", firstJob.id);
  fs.mkdirSync(foreignDir, { recursive: true });
  const runningFirstJob = JSON.parse(fs.readFileSync(path.join(firstDir, "job.json"), "utf8"));
  fs.writeFileSync(path.join(foreignDir, "job.json"), JSON.stringify(runningFirstJob), "utf8");
  const crossWorkspace = completeRevitToolJob({
    session_id: firstJob.session_id, job_id: firstJob.id, executor_id: "worker-1", result: firstResult
  });
  assert.equal(crossWorkspace.status, "failed");
  const crossWorkspaceReceipt = JSON.parse(fs.readFileSync(path.join(foreignDir, "result.json"), "utf8"));
  assert.equal(crossWorkspaceReceipt.code, "CERTIFICATION_COMPLETION_CHALLENGE_INVALID");
  assert.equal(crossWorkspaceReceipt.outcome_unknown, true);
});

test("courier completion survives a backend process restart using only its durable one-use challenge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-completion-restart-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);
  const admission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const job = certifiedMoveJob(policy, body, admission);
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: job.session_id, executor_id: "worker-1" }).job?.id, job.id);
  const authorization = authorizeRevitToolJobExecution({
    session_id: job.session_id, job_id: job.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  const runningJob = fs.readFileSync(path.join(dir, "job.json"), "utf8");
  const context = testExecutionContext(job, {
    completion_challenge: authorization.completion_challenge!,
    completion_challenge_hash: authorization.completion_challenge_hash!
  });
  const result = certifiedMoveExecutionResult(job, admission, context);
  assert.equal(fs.existsSync(path.join(dir, "completion-challenge-issued.v1.json")), true);

  const completionInput = {
    session_id: job.session_id, job_id: job.id, executor_id: "worker-1", result
  };
  const completionInputPath = path.join(root, "restart-completion-input.json");
  fs.writeFileSync(completionInputPath, JSON.stringify(completionInput), "utf8");
  const restarted = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import fs from 'node:fs'; import { completeRevitToolJob } from './dist/src/courier/revit_tool_jobs.js'; const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); completeRevitToolJob(input);",
    completionInputPath
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(restarted.status, 0, `${restarted.stderr}\n${restarted.stdout}`);
  assert.equal(fs.existsSync(path.join(dir, "completion-challenge-consumed.v1.json")), true);
  const durable = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(durable.status, "succeeded");
  assert.deepEqual(durable.certified_execution_context, context);

  // Model a crash/corruption after challenge consumption but before a durable
  // success receipt can be trusted. A fresh process must not replay execution.
  fs.unlinkSync(path.join(dir, "result.json"));
  fs.writeFileSync(path.join(dir, "job.json"), runningJob, "utf8");
  const competingFailure = failRevitToolJob({
    session_id: job.session_id, job_id: job.id, executor_id: "worker-1",
    result: { code: "late_competing_failure" }, error: "late competing failure"
  });
  assert.equal(competingFailure.status, "running");
  assert.equal(fs.existsSync(path.join(dir, "result.json")), false);
  const replayed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import fs from 'node:fs'; import { completeRevitToolJob } from './dist/src/courier/revit_tool_jobs.js'; const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); completeRevitToolJob(input);",
    completionInputPath
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(replayed.status, 0, `${replayed.stderr}\n${replayed.stdout}`);
  const recovered = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(recovered.status, "succeeded");
  assert.deepEqual(recovered.certified_execution_context, context);
  const recoveredBytes = fs.readFileSync(path.join(dir, "result.json"), "utf8");
  assert.equal(completeRevitToolJob({
    session_id: job.session_id, job_id: job.id, executor_id: "worker-1", result: { forged: true }
  }).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(dir, "result.json"), "utf8"), recoveredBytes);
});

test("concurrent terminal publishers use first-writer CAS and never overwrite durable truth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-terminal-cas-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  const id = writeJob(root);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, id);
  const completeInputPath = path.join(root, "complete-input.json");
  const failInputPath = path.join(root, "fail-input.json");
  fs.writeFileSync(completeInputPath, JSON.stringify({
    session_id: "session-a", job_id: id, executor_id: "worker-1", result: { winner: "success" }
  }), "utf8");
  fs.writeFileSync(failInputPath, JSON.stringify({
    session_id: "session-a", job_id: id, executor_id: "worker-1", result: { code: "racing_failure" }, error: "racing failure"
  }), "utf8");
  const run = (operation: "completeRevitToolJob" | "failRevitToolJob", inputPath: string) => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, [
      "--input-type=module", "-e",
      `import fs from 'node:fs'; import { ${operation} as finish } from './dist/src/courier/revit_tool_jobs.js'; const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); try { finish(input); } catch {}`,
      inputPath
    ], { cwd: process.cwd(), env: process.env, stdio: "ignore" });
    child.on("exit", code => resolve(code));
  });
  await Promise.all([run("completeRevitToolJob", completeInputPath), run("failRevitToolJob", failInputPath)]);
  const resultFile = path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json");
  const firstWinnerBytes = fs.readFileSync(resultFile, "utf8");
  const firstWinner = JSON.parse(firstWinnerBytes);
  assert.ok(firstWinner.status === "succeeded" || firstWinner.status === "failed");
  try {
    if (firstWinner.status === "succeeded") failRevitToolJob({
      session_id: "session-a", job_id: id, executor_id: "worker-1", error: "late failure"
    });
    else completeRevitToolJob({
      session_id: "session-a", job_id: id, executor_id: "worker-1", result: { late: "success" }
    });
  } catch { /* a contradictory loser may reject after reconciling terminal truth */ }
  assert.equal(fs.readFileSync(resultFile, "utf8"), firstWinnerBytes);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);
});

test("concurrent invalid family completion cannot overwrite the signed-success decision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-concurrent-success-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const body = courierMoveBody(true);
  const admission = courierMoveAdmission("preview", null, body, null, randomUUID().replace(/-/g, ""));
  const job = certifiedMoveJob(policy, body, admission);
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: job.session_id, executor_id: "worker-1" }).job?.id, job.id);
  const authorization = authorizeRevitToolJobExecution({
    session_id: job.session_id, job_id: job.id, executor_id: "worker-1", authorization_stage: "final"
  }).authorization;
  const context = testExecutionContext(job, {
    completion_challenge: authorization.completion_challenge!,
    completion_challenge_hash: authorization.completion_challenge_hash!
  });
  const validResult = certifiedMoveExecutionResult(job, admission, context);
  const invalidResult = certifiedMoveExecutionResult(job, admission, context, null, "direct");
  const validInputPath = path.join(root, "valid-completion.json");
  const invalidInputPath = path.join(root, "invalid-completion.json");
  const baseInput = { session_id: job.session_id, job_id: job.id, executor_id: "worker-1" };
  fs.writeFileSync(validInputPath, JSON.stringify({ ...baseInput, result: validResult }), "utf8");
  fs.writeFileSync(invalidInputPath, JSON.stringify({ ...baseInput, result: invalidResult }), "utf8");
  const decisionPath = path.join(dir, "completion-terminal-decision.v1.json");
  const runChild = (script: string, inputPath: string) => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, inputPath, decisionPath], {
      cwd: process.cwd(), env: process.env, stdio: "ignore"
    });
    child.on("exit", code => resolve(code));
  });
  const completeScript = "import fs from 'node:fs'; import { completeRevitToolJob } from './dist/src/courier/revit_tool_jobs.js'; const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); completeRevitToolJob(input);";
  const invalidAfterDecisionScript = "import fs from 'node:fs'; import { completeRevitToolJob } from './dist/src/courier/revit_tool_jobs.js'; const signal=new Int32Array(new SharedArrayBuffer(4)); const deadline=Date.now()+2000; while(!fs.existsSync(process.argv[2])&&Date.now()<deadline) Atomics.wait(signal,0,0,5); const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); try { completeRevitToolJob(input); } catch {}";
  await Promise.all([
    runChild(completeScript, validInputPath),
    runChild(invalidAfterDecisionScript, invalidInputPath)
  ]);
  const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  const durableBytes = fs.readFileSync(path.join(dir, "result.json"), "utf8");
  const durable = JSON.parse(durableBytes);
  assert.equal(decision.kind, "success");
  assert.equal(durable.status, "succeeded");
  assert.equal(durable.result.certified_execution_receipt.transport_kind, "courier");
  assert.equal(durable.result.certified_execution_receipt.completion_challenge_hash, context.completion_challenge_hash);
  assert.equal(fs.readFileSync(path.join(dir, "result.json"), "utf8"), durableBytes);
});

test("signed courier preview lineage is exact and apply receipts carry explicit null lineage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-preview-lineage-"));
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = certifiedMovePolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policy.policy_hash;
  const previewBody = courierMoveBody(true);
  const previewAdmission = courierMoveAdmission("preview", null, previewBody, null, randomUUID().replace(/-/g, ""));
  const previewJob = certifiedMoveJob(policy, previewBody, previewAdmission);
  const previewContext = testExecutionContext(previewJob);
  const previewResult = certifiedMoveExecutionResult(previewJob, previewAdmission, previewContext);
  const mismatchedNested = {
    ...previewResult,
    certified_preview_receipt: {
      ...(previewResult.certified_preview_receipt as Record<string, unknown>),
      issued_at_utc: "2026-08-08T12:00:01.000Z"
    }
  };
  assert.throws(
    () => assertCertifiedCourierExecutionResult(previewJob, mismatchedNested, previewContext),
    (error: unknown) => error instanceof RevitCourierCertificationError
      && error.code === "CERTIFICATION_EXECUTION_RECEIPT_INVALID"
  );

  const applyBody = courierMoveBody(false);
  const applyAdmission = courierMoveAdmission(
    "apply", previewAdmission.request_instance_hash, applyBody, `cmpr1_${"K".repeat(43)}`, randomUUID().replace(/-/g, "")
  );
  const applyJob = certifiedMoveJob(policy, applyBody, applyAdmission);
  const applyContext = testExecutionContext(applyJob, testCompletionChallenge("L"));
  const applyResult = certifiedMoveExecutionResult(applyJob, applyAdmission, applyContext);
  const applyReceipt = applyResult.certified_execution_receipt as Record<string, unknown>;
  assert.equal(applyReceipt.preview_receipt_schema, null);
  assert.equal(applyReceipt.preview_receipt_hash, null);
  assert.equal(applyReceipt.preview_instance_hash, null);
  assert.equal(applyReceipt.preview_admission_session_id, null);
  assert.equal(applyReceipt.preview_issued_at_utc, null);
  assert.doesNotThrow(() => assertCertifiedCourierExecutionResult(applyJob, applyResult, applyContext));
});

test("v2 final authorization terminalizes known job and claim-lease expiry without an outcome-unknown replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-final-expiry-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = writeCertifiedPolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;

  const jobExpiredId = writeCertifiedV2Job(root, policy, {}, {
    expires_at: new Date(Date.now() + 150).toISOString()
  });
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, jobExpiredId);
  await new Promise(resolve => setTimeout(resolve, 225));
  assert.throws(
    () => authorizeRevitToolJobExecution({ session_id: "session-a", job_id: jobExpiredId, executor_id: "worker-1" }),
    /CERTIFICATION_FINAL_JOB_EXPIRED/
  );
  const jobExpiredReceipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", jobExpiredId, "result.json"), "utf8"));
  assert.equal(jobExpiredReceipt.code, "CERTIFICATION_FINAL_JOB_EXPIRED");
  assert.equal(jobExpiredReceipt.retryable, false);
  assert.equal(jobExpiredReceipt.outcome_unknown, false);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);

  const leaseExpiredId = writeCertifiedV2Job(root, policy, {}, { target_document_path: "C:\\models\\lease-expired.rvt" });
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, leaseExpiredId);
  const leaseExpiredPath = path.join(root, "artifacts", "revit-courier", "jobs", leaseExpiredId, "job.json");
  const leaseExpired = JSON.parse(fs.readFileSync(leaseExpiredPath, "utf8"));
  leaseExpired.claim.claimed_at = new Date(Date.now() - 120_000).toISOString();
  leaseExpired.claim.lease_expires_at = new Date(Date.now() - 1_000).toISOString();
  fs.writeFileSync(leaseExpiredPath, JSON.stringify(leaseExpired), "utf8");
  assert.throws(
    () => authorizeRevitToolJobExecution({ session_id: "session-a", job_id: leaseExpiredId, executor_id: "worker-1" }),
    /CERTIFICATION_FINAL_CLAIM_LEASE_EXPIRED/
  );
  const leaseExpiredReceipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", leaseExpiredId, "result.json"), "utf8"));
  assert.equal(leaseExpiredReceipt.code, "CERTIFICATION_FINAL_CLAIM_LEASE_EXPIRED");
  assert.equal(leaseExpiredReceipt.retryable, false);
  assert.equal(leaseExpiredReceipt.outcome_unknown, false);
  assert.notEqual(leaseExpiredReceipt.code, "execution_lease_expired_outcome_unknown");
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);
});

test("v2 context identity accepts safe Unicode and terminally rejects control-bearing producer values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-unicode-context-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = writeCertifiedPolicy(root);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
  const context = {
    session_id: "session-α",
    target_executor_id: "workstation-β",
    target_document_title: "楼层 Café",
    target_document_path: "C:\\模型\\Café\\Snowdon.rvt"
  };
  const unicodeId = writeCertifiedV2Job(root, policy, {}, context);
  assert.equal(claimNextRevitToolJob({ session_id: context.session_id, executor_id: context.target_executor_id }).job?.id, unicodeId);
  assert.equal(
    authorizeRevitToolJobExecution({ session_id: context.session_id, job_id: unicodeId, executor_id: context.target_executor_id }).authorization.target_document_title,
    context.target_document_title
  );

  const unsafeId = writeCertifiedV2Job(root, policy, {}, { target_document_title: "Snowdon\tunsafe" });
  assert.equal(claimNextRevitToolJob({ executor_id: "worker-1" }).job, null);
  const unsafeReceipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", unsafeId, "result.json"), "utf8"));
  assert.equal(unsafeReceipt.code, "CERTIFICATION_JOB_MALFORMED");
  assert.equal(unsafeReceipt.outcome_unknown, false);
});

test("v2 courier terminalizes malformed envelopes and policy revocation after claim without an outcome-unknown lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-revocation-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const policy = writeCertifiedPolicy(root, { policyHashSuffix: "allowed" });
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
  const id = writeCertifiedV2Job(root, policy);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, id);

  const revoked = writeCertifiedPolicy(root, { exposed: false, policyHashSuffix: "revoked" });
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = revoked.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = revoked.policyHash;
  assert.throws(
    () => authorizeRevitToolJobExecution({ session_id: "session-a", job_id: id, executor_id: "worker-1" }),
    /CERTIFICATION_POLICY_CHANGED|CERTIFICATION_POLICY_DENIED/
  );
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.phase, "certification_final_execution");
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.outcome_unknown, false);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);

  const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-malformed-"));
  process.env.OPERATOR_WORKSPACE_ROOT = malformedRoot;
  const current = writeCertifiedPolicy(malformedRoot);
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = current.policyPath;
  process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = current.policyHash;
  const malformedId = writeCertifiedV2Job(malformedRoot, current);
  const jobPath = path.join(malformedRoot, "artifacts", "revit-courier", "jobs", malformedId, "job.json");
  const malformed = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  malformed.turn_token = "must-never-persist";
  fs.writeFileSync(jobPath, JSON.stringify(malformed), "utf8");
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);
  const malformedReceipt = JSON.parse(fs.readFileSync(path.join(malformedRoot, "artifacts", "revit-courier", "jobs", malformedId, "result.json"), "utf8"));
  assert.equal(malformedReceipt.phase, "certification_final_execution");
  assert.equal(malformedReceipt.outcome_unknown, false);
});

test("v2 claim quarantines every immutable publisher-contract mismatch before a workstation can execute", () => {
  const cases: Array<[string, (job: any) => void]> = [
    ["unknown version", job => { job.version = "revit-operator.revit-tool-job.v3"; }],
    ["unknown field", job => { job.unexpected = true; }],
    ["raw token", job => { job.turn_token = "never-persist"; }],
    ["compatibility body", job => { job.body = "{}"; }],
    ["raw body", job => { job.body_json = "{}"; }],
    ["envelope hash", job => { job.certification_envelope.alias = "revit_context"; }],
    ["idempotency", job => { job.idempotency_key = "a".repeat(64); }],
    ["correlation", job => { job.correlation_id = "b".repeat(64); }],
    ["expiry identity", job => { job.expires_at = new Date(Date.parse(job.expires_at) + 1_000).toISOString(); }]
  ];
  for (const [label, mutate] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-mismatch-"));
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.REVIT_OPERATOR_MODE = "local";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    const policy = writeCertifiedPolicy(root, { policyHashSuffix: label.replace(/\W/g, "-") });
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    const id = writeCertifiedV2Job(root, policy);
    const jobPath = path.join(root, "artifacts", "revit-courier", "jobs", id, "job.json");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    mutate(job);
    fs.writeFileSync(jobPath, JSON.stringify(job), "utf8");
    assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null, label);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
    assert.equal(receipt.status, "failed", label);
    assert.equal(receipt.phase, "certification_final_execution", label);
    assert.equal(receipt.retryable, false, label);
    assert.equal(receipt.outcome_unknown, false, label);
  }
});

test("final v2 authorization terminalizes unavailable, malformed, and anchor-mismatched current policies", () => {
  const cases: Array<[string, (root: string) => { policyPath: string; policyHash: string }]> = [
    ["unavailable", root => ({ policyPath: path.join(root, "missing-policy.json"), policyHash: `sha256:${"1".repeat(64)}` })],
    ["malformed", root => {
      const policyPath = path.join(root, "malformed-policy.json");
      fs.writeFileSync(policyPath, "{", "utf8");
      return { policyPath, policyHash: `sha256:${"1".repeat(64)}` };
    }],
    ["anchor mismatch", root => {
      const policy = writeCertifiedPolicy(root, { policyHashSuffix: "anchor-mismatch" });
      return { policyPath: policy.policyPath, policyHash: `sha256:${"0".repeat(64)}` };
    }]
  ];
  for (const [label, replaceCurrent] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v2-policy-"));
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.REVIT_OPERATOR_MODE = "local";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    const published = writeCertifiedPolicy(root, { policyHashSuffix: `${label}-published` });
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = published.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = published.policyHash;
    const id = writeCertifiedV2Job(root, published);
    assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, id, label);
    const current = replaceCurrent(root);
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = current.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = current.policyHash;
    assert.throws(() => authorizeRevitToolJobExecution({ session_id: "session-a", job_id: id, executor_id: "worker-1" }), /CERTIFICATION_POLICY_/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
    assert.equal(receipt.phase, "certification_final_execution", label);
    assert.equal(receipt.outcome_unknown, false, label);
  }
});

test("courier claims only the bound session and writes a durable terminal result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-store-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root);
  assert.equal(claimNextRevitToolJob({ session_id: "session-b", executor_id: "worker-1" }).job, null);
  const claimed = claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job;
  assert.equal(claimed?.id, id);
  assert.equal(claimed?.status, "running");
  assert.throws(() => completeRevitToolJob({ session_id: "session-a", job_id: id, executor_id: "worker-2", result: {} }), /not claimed/i);
  completeRevitToolJob({ session_id: "session-a", job_id: id, executor_id: "worker-1", result: { status: "ok" } });
  const replayed = completeRevitToolJob({ session_id: "session-a", job_id: id, executor_id: "worker-1", result: { status: "different" } });
  assert.equal(replayed.status, "succeeded");
  assert.throws(
    () => failRevitToolJob({ session_id: "session-a", job_id: id, executor_id: "worker-1", error: "contradictory" }),
    /contradictory failure/i
  );
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(receipt.result, { status: "ok" });
});

test("courier treats a durable result as authoritative and never reclaims its stale job summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-reconcile-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root);
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", id);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id,
    correlation_id: id,
    status: "succeeded",
    finished_at: "2026-07-25T12:00:00.000Z",
    result: { status: "already-applied" },
    retryable: false
  }), "utf8");

  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-2" }).job, null);
  const reconciled = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  assert.equal(reconciled.status, "succeeded");
  assert.equal(reconciled.finished_at, "2026-07-25T12:00:00.000Z");
});

test("courier quarantines a mismatched durable result instead of replaying the job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-corrupt-result-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root);
  const dir = path.join(root, "artifacts", "revit-courier", "jobs", id);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id: "different-job",
    correlation_id: "different-job",
    status: "succeeded"
  }), "utf8");

  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-2" }).job, null);
  const quarantined = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  assert.equal(quarantined.status, "failed");
  assert.match(quarantined.error, /quarantined without replay/i);
});

test("courier can claim an accessible job across Native and Sidecar session boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-cross-surface-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const nativeId = writeJob(root, { session_id: "native-session", created_at: "2026-01-01T00:00:00.000Z" });
  const sidecarId = writeJob(root, { session_id: "sidecar-session", created_at: "2026-01-01T00:00:01.000Z" });
  const claimed = claimNextRevitToolJob({
    executor_id: "workstation-1",
    session_allowed: sessionId => sessionId === "sidecar-session"
  }).job;
  assert.equal(claimed?.id, sidecarId);
  assert.equal(claimed?.session_id, "sidecar-session");
  assert.equal(claimNextRevitToolJob({ session_id: "native-session", executor_id: "workstation-2" }).job?.id, nativeId);
});

test("courier pins a targeted job to the exact Revit executor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-target-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root, {
    target_executor_id: "workstation-revit-courier-24024",
    target_document_title: "phase_fallback_room_location_test",
    target_document_path: "C:\\models\\phase_fallback_room_location_test.rvt"
  });
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "workstation-revit-courier-24025" }).job, null);
  const claimed = claimNextRevitToolJob({ session_id: "session-a", executor_id: "workstation-revit-courier-24024" }).job;
  assert.equal(claimed?.id, id);
  assert.equal(claimed?.target_document_title, "phase_fallback_room_location_test");
});

test("courier never automatically replays a job whose execution lease expired", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-lease-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root, {
    status: "running",
    claim: {
      executor_id: "dead-worker",
      claimed_at: new Date(Date.now() - 120_000).toISOString(),
      lease_expires_at: new Date(Date.now() - 60_000).toISOString()
    }
  });
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-2" }).job, null);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "execution_lease_expired_outcome_unknown");
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.outcome_unknown, true);
  assert.equal(Object.hasOwn(receipt, "outcomeUnknown"), false);
  const persistedJob = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "job.json"), "utf8"));
  assert.equal(persistedJob.status, "failed");
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-3" }).job, null);
});

test("courier promotes a bounded workstation failure code into the authoritative result receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-failure-code-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const id = writeJob(root);
  claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" });
  failRevitToolJob({
    session_id: "session-a",
    job_id: id,
    executor_id: "worker-1",
    error: "The Revit action deadline elapsed.",
    retryable: true,
    result: {
      code: "revit_action_deadline_elapsed_outcome_unknown",
      phase: "revit_external_event",
      hostHealth: "unavailable",
      outcomeUnknown: true,
      correlationId: id,
      deadlineClass: "bounded_read",
      deadlineMs: 60_000
    }
  });
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
  assert.equal(receipt.code, "revit_action_deadline_elapsed_outcome_unknown");
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.outcome_unknown, true);
  assert.equal(Object.hasOwn(receipt, "outcomeUnknown"), false);
  assert.equal(receipt.result.hostHealth, "unavailable");
  assert.equal(receipt.result.outcomeUnknown, true);
  assert.equal(receipt.result.correlationId, id);
  assert.equal(receipt.result.deadlineClass, "bounded_read");
  assert.equal(receipt.result.deadlineMs, 60_000);
  const persistedJob = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "job.json"), "utf8"));
  assert.equal(persistedJob.status, "failed");
  assert.equal(failRevitToolJob({
    session_id: "session-a",
    job_id: id,
    executor_id: "worker-1",
    error: "must not replace authoritative unknown outcome",
    retryable: true,
    result: { outcomeUnknown: false }
  }).status, "failed");
  const replayedReceipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
  assert.equal(replayedReceipt.outcome_unknown, true);
  assert.equal(replayedReceipt.retryable, false);
});

test("courier does not promote omitted, false, malformed, or nested outcome-unknown metadata", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["omitted", { code: "native_failure" }],
    ["false", { code: "native_failure", outcomeUnknown: false }],
    ["string", { code: "native_failure", outcomeUnknown: "true" }],
    ["numeric", { code: "native_failure", outcomeUnknown: 1 }],
    ["nested", { code: "native_failure", metadata: { outcomeUnknown: true } }]
  ];

  for (const [label, result] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `revit-courier-known-failure-${label}-`));
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    const id = writeJob(root);
    claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" });
    failRevitToolJob({
      session_id: "session-a",
      job_id: id,
      executor_id: "worker-1",
      error: "Known native failure.",
      retryable: true,
      result
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", id, "result.json"), "utf8"));
    assert.equal(receipt.status, "failed", label);
    assert.equal(receipt.code, "native_failure", label);
    assert.equal(receipt.outcome_unknown, false, label);
    assert.equal(receipt.retryable, true, label);
  }

  const successRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-known-success-"));
  process.env.OPERATOR_WORKSPACE_ROOT = successRoot;
  const successId = writeJob(successRoot);
  claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" });
  completeRevitToolJob({
    session_id: "session-a",
    job_id: successId,
    executor_id: "worker-1",
    result: { outcomeUnknown: true, metadata: { outcomeUnknown: true } }
  });
  const successReceipt = JSON.parse(fs.readFileSync(path.join(successRoot, "artifacts", "revit-courier", "jobs", successId, "result.json"), "utf8"));
  assert.equal(successReceipt.status, "succeeded");
  assert.equal(successReceipt.outcome_unknown, false);
  assert.equal(successReceipt.retryable, false);
});

test("courier context is explicit, target-pinned, exclusive per workspace, and closed without deleting its receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-context-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_TRANSPORT = "courier";
  const lease = beginRevitCourierTurnContext({
    session_id: "session-a",
    message_id: "message-a",
    ttl_ms: 60_000,
    target_executor_id: "workstation-revit-courier-24024",
    target_document_title: "phase_fallback_room_location_test",
    target_document_path: "C:\\models\\phase_fallback_room_location_test.rvt"
  });
  assert.ok(lease);
  assert.throws(
    () => beginRevitCourierTurnContext({ session_id: "session-b", message_id: "message-b", ttl_ms: 60_000 }),
    /busy/i
  );
  endRevitCourierTurnContext(lease);
  const context = JSON.parse(fs.readFileSync(path.join(root, "config", "revit-courier-context.json"), "utf8"));
  assert.equal(context.active, false);
  assert.equal(context.target_executor_id, "workstation-revit-courier-24024");
  assert.equal(context.target_document_title, "phase_fallback_room_location_test");
  assert.equal(context.target_document_path, "C:\\models\\phase_fallback_room_location_test.rvt");
  delete process.env.OPERATOR_REVIT_TRANSPORT;
});

test("Codex courier target extraction accepts bounded Sidecar identity and rejects malformed executors", () => {
  assert.deepEqual(revitCourierTargetFromContext({
    ui: {
      revit_document: {
        courier_executor_id: "workstation-revit-courier-24024",
        title: "phase_fallback_room_location_test",
        path: "C:\\models\\phase_fallback_room_location_test.rvt"
      }
    }
  }), {
    target_executor_id: "workstation-revit-courier-24024",
    target_document_title: "phase_fallback_room_location_test",
    target_document_path: "C:\\models\\phase_fallback_room_location_test.rvt"
  });
  assert.throws(
    () => revitCourierTargetFromContext({ ui: { revit_document: { courier_executor_id: "wrong executor", title: "must-not-bind" } } }),
    /context integrity.*malformed/i
  );
});

test("Codex courier target extraction accepts canonical context and rejects identity disagreement", () => {
  const canonical = {
    revit: {
      courier_executor_id: "workstation-revit-courier-24024",
      document: { title: "Duke B200", path: "C:\\models\\Duke B200.rvt" }
    }
  };
  assert.deepEqual(revitCourierTargetFromContext(canonical), {
    target_executor_id: "workstation-revit-courier-24024",
    target_document_title: "Duke B200",
    target_document_path: "C:\\models\\Duke B200.rvt"
  });
  assert.throws(() => revitCourierTargetFromContext({
    ...canonical,
    ui: { revit_document: { courier_executor_id: "other-revit-courier-99", title: "Duke B200", path: "C:\\models\\Duke B200.rvt" } }
  }), /context integrity.*executors disagree/i);
  assert.throws(() => revitCourierTargetFromContext({
    ...canonical,
    ui: { revit_document: { courier_executor_id: "workstation-revit-courier-24024", title: "Snowdon", path: "C:\\models\\Snowdon.rvt" } }
  }), /context integrity.*titles disagree/i);
});

test("conflicting Sidecar identity cannot open an unbound courier lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-conflicting-context-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_TRANSPORT = "courier";
  try {
    assert.throws(() => beginRevitCourierTurnContext({
      session_id: "session-conflict",
      message_id: "message-conflict",
      ttl_ms: 60_000,
      ...revitCourierTargetFromContext({
        revit: {
          courier_executor_id: "workstation-revit-courier-24024",
          document: { title: "Duke B200", path: "C:\\models\\Duke B200.rvt" }
        },
        ui: {
          revit_document: {
            courier_executor_id: "other-revit-courier-99",
            title: "Duke B200",
            path: "C:\\models\\Duke B200.rvt"
          }
        }
      })
    }), /context integrity.*executors disagree/i);
    assert.equal(fs.existsSync(path.join(root, "config", "revit-courier-context.json")), false);
  } finally {
    delete process.env.OPERATOR_REVIT_TRANSPORT;
  }
});

test("malformed declared courier fields return no actions before any courier lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-malformed-context-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_TRANSPORT = "courier";
  const contexts = [
    { revit: { courier_executor_id: "worker\nother", document: { title: "Duke B200", path: "C:\\models\\Duke B200.rvt" } } },
    { revit: { courier_executor_id: "worker-1\n", document: { title: "Duke B200", path: "C:\\models\\Duke B200.rvt" } } },
    { revit: { courier_executor_id: "\n", document: { title: "Duke B200", path: "C:\\models\\Duke B200.rvt" } } },
    { revit: { courier_executor_id: "worker-1", document: { title: "x".repeat(513), path: "C:\\models\\Duke B200.rvt" } } },
    { revit: { courier_executor_id: "worker-1", document: { title: ` ${"x".repeat(512)} `, path: "C:\\models\\Duke B200.rvt" } } },
    { revit: { courier_executor_id: "worker-1", document: { title: "Duke B200", path: 42 } } }
  ];
  try {
    for (const [index, context] of contexts.entries()) {
      const response = await decideCodexStreaming({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        session_id: `malformed-session-${index}`,
        message_id: `malformed-message-${index}`,
        user_text: "Inspect this model.",
        context
      }, {});
      assert.deepEqual(response.actions, []);
      assert.match(response.assistant_message, /context integrity.*malformed.*stopped before planning/i);
    }
    assert.equal(fs.existsSync(path.join(root, "config", "revit-courier-context.json")), false);
  } finally {
    delete process.env.OPERATOR_REVIT_TRANSPORT;
  }
});
