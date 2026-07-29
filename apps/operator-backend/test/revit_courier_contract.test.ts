import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

function writeCertifiedV2Job(root: string, policy: ReturnType<typeof writeCertifiedPolicy>, overrides: Record<string, unknown> = {}): string {
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
    session_id: "session-a",
    message_id: "message-a",
    turn_token_sha256: null,
    target_executor_id: "worker-1",
    target_document_title: "Snowdon",
    target_document_path: "C:\\models\\Snowdon.rvt",
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
    session_id: "session-a",
    message_id: "message-a",
    turn_token_sha256: null,
    correlation_id: id,
    idempotency_key: id,
    method: "POST",
    path: "/revit/ping",
    target_executor_id: "worker-1",
    target_document_title: "Snowdon",
    target_document_path: "C:\\models\\Snowdon.rvt",
    body: rawBody,
    body_json: rawBody,
    body_present: true,
    certification_envelope: envelope,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    claim: null,
    ...overrides
  }, null, 2), "utf8");
  return id;
}

test("legacy v1 courier jobs terminal-deny by default and only claim in the explicit development laboratory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-v1-certification-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.REVIT_OPERATOR_MODE = "local";
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  const deniedId = writeJob(root);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job, null);
  const denied = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "revit-courier", "jobs", deniedId, "result.json"), "utf8"));
  assert.equal(denied.status, "failed");
  assert.equal(denied.retryable, false);
  assert.equal(denied.phase, "certification_final_execution");
  assert.equal(denied.outcome_unknown, false);

  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  const allowedId = writeJob(root);
  assert.equal(claimNextRevitToolJob({ session_id: "session-a", executor_id: "worker-1" }).job?.id, allowedId);
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
    ["idempotency", job => { job.idempotency_key = "a".repeat(64); }]
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
    retryable: false,
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
  assert.equal(receipt.result.hostHealth, "unavailable");
  assert.equal(receipt.result.outcomeUnknown, true);
  assert.equal(receipt.result.correlationId, id);
  assert.equal(receipt.result.deadlineClass, "bounded_read");
  assert.equal(receipt.result.deadlineMs, 60_000);
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
