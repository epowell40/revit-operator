import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { callRevitViaCourier, RevitCourierError, REVIT_COURIER_CONTEXT_STRING_LIMITS } from "./revitCourier.js";
import { callRevit } from "./revitClient.js";
import {
  canonicalToolExposureJson,
  createCertifiedCourierAdmission,
  runWithRevitToolAlias,
  type CertifiedCourierAdmission
} from "./toolExposurePolicy.js";
import {
  admitCertifiedMoveOneRequest,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH,
  CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1
} from "./certifiedMoveOneRequestFamily.js";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation } from "./certifiedMoveTargetLedger.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";
import { revitRouteEffect } from "./revitRouteEffect.js";

const sourcePolicyPath = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
  ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
  : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").normalize("NFC");
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.replace(/\r\n?/g, "\n").normalize("NFC"), item] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function policyDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function writePingPolicy(reason = "CERTIFIED"): { policyPath: string; policyHash: string } {
  const policy = JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8"));
  const ping = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/ping");
  ping.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: [reason] };
  for (const record of policy.records) {
    const { policy_record_hash: _oldRecordHash, ...payload } = record;
    record.policy_record_hash = policyDigest(payload);
  }
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = policyDigest(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-policy-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash };
}

function writeMoveFamilyPolicy(): { policyPath: string; policyHash: string } {
  const policy = JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8"));
  const template = structuredClone(policy.records[0]);
  const previewBody = {
    ids: [4821], mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, dryRun: true,
    behavior: "allOrNothing", moveTogether: false, options: { failOnPinned: true, unpinIfAllowed: false }
  };
  const routeEffect = revitRouteEffect("/revit/move-elements", "POST", previewBody);
  Object.assign(template, {
    method: "POST",
    path: "/revit/move-elements",
    request_hash: `sha256:${"0".repeat(64)}`,
    effect_hash: policyDigest({ effect: { resolved_effect: routeEffect === "apply" ? "write" : routeEffect } }),
    request_family: {
      schema: "revit-operator.certified-request-family.v1",
      id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
      validator_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH
    },
    highest_cumulative_level: "L4",
    observed_levels: ["L0", "L1", "L2", "L3", "L4"],
    visibility: "candidate",
    typed_mcp_aliases: ["revit_move_one_certified"],
    channels: {
      search: { exposed: false, required_level: "L3", reason_codes: ["CERT_CHANNEL_NOT_APPROVED"] },
      generic_call: { exposed: false, required_level: "L4", reason_codes: ["CERT_CHANNEL_NOT_APPROVED"] },
      typed_mcp: { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED_REQUEST_FAMILY"] },
      deterministic_workflow: { exposed: false, required_level: "L4", reason_codes: ["CERT_CHANNEL_NOT_APPROVED"] }
    }
  });
  delete template.execution_surface;
  const { policy_record_hash: _oldRecordHash, ...recordPayload } = template;
  template.policy_record_hash = policyDigest(recordPayload);
  policy.records = [template];
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = policyDigest(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-courier-family-policy-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash };
}

function saveEnv(): () => void {
  const names = [
    "OPERATOR_WORKSPACE_ROOT",
    "OPERATOR_REVIT_COURIER_TIMEOUT_MS",
    "OPERATOR_REVIT_TRANSPORT",
    "REVIT_OPERATOR_MODE",
    "OPERATOR_TOOL_EXPOSURE_PROFILE",
    "OPERATOR_TOOL_EXPOSURE_POLICY_PATH",
    "OPERATOR_TOOL_EXPOSURE_POLICY_SHA256"
  ] as const;
  const snapshot = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return () => {
    for (const name of names) {
      const value = snapshot[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function writeContext(root: string, input: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "revit-courier-context.json"), JSON.stringify({
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...input
  }), "utf8");
}

function startCertifiedPing<T>(body?: unknown): Promise<T> {
  return runWithRevitToolAlias("revit_ping", async () => await callRevit<T>("/revit/ping", "GET", body));
}

async function waitForJob(root: string): Promise<{ id: string; dir: string }> {
  const jobsRoot = path.join(root, "artifacts", "revit-courier", "jobs");
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(jobsRoot)) {
      const id = fs.readdirSync(jobsRoot).find(name => fs.existsSync(path.join(jobsRoot, name, "job.json")));
      if (id) return { id, dir: path.join(jobsRoot, id) };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for courier test job.");
}

async function waitForJobs(root: string, expected: number): Promise<Array<{ id: string; dir: string }>> {
  const jobsRoot = path.join(root, "artifacts", "revit-courier", "jobs");
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(jobsRoot)) {
      const jobs = fs.readdirSync(jobsRoot)
        .filter(id => fs.existsSync(path.join(jobsRoot, id, "job.json")))
        .map(id => ({ id, dir: path.join(jobsRoot, id) }));
      if (jobs.length >= expected) return jobs;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} courier test jobs.`);
}

function writeSucceededResult(job: { id: string; dir: string }, result: unknown, certifiedExecutionContext?: unknown): void {
  fs.writeFileSync(path.join(job.dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id: job.id,
    correlation_id: job.id,
    status: "succeeded",
    result,
    ...(certifiedExecutionContext === undefined ? {} : { certified_execution_context: certifiedExecutionContext }),
    retryable: false
  }), "utf8");
}

test("courier publication rejects the reserved certified namespace before reading context or writing a job", async () => {
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
      callRevitViaCourier(reservedPath, "POST", { schema: "bypass" }),
      /cannot be published through the Revit courier/
    );
  }
  for (const invalidPath of [
    "/revit/certified%2fsheets/count%zz",
    "/revit/certified%25252525252525252fsheets/count"
  ]) {
    await assert.rejects(
      callRevitViaCourier(invalidPath, "POST", { schema: "bypass" }),
      /malformed percent encoding|did not converge within the safety bound/
    );
  }
});

test("cross-runtime v2 envelope and idempotency vectors freeze canonical UTF-8 bytes", () => {
  // The expected literals and hashes were independently verified with
  // PowerShell/.NET SHA256.HashData(Encoding.UTF8.GetBytes(literal)). The
  // literals deliberately keep U+2028/U+2029 as UTF-8 code points, not
  // System.Text.Json's default escaped form.
  const envelopeInput = {
    workflow: "W \"q\" \\ root\r\nCafe\u0301 \u2028mid\u2029end",
    version: 1,
    schema: "revit-operator.revit-tool-certification-envelope.v1",
    runtime_mode: "develop\u2028ment\u2029",
    request_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    policy_trust_source: "deployment",
    policy_record_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    policy_hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    path: "/revit/context",
    method: "GET",
    evidence_record_hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    effect_hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    channel: "typed_mcp",
    canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    body_sha256: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    body_present: true,
    alias: "revit_ping"
  };
  const expectedEnvelope = "{\"alias\":\"revit_ping\",\"body_present\":true,\"body_sha256\":\"sha256:6666666666666666666666666666666666666666666666666666666666666666\",\"canonicalization\":\"revit-operator.canonical-json.nfc-key-sorted.v1\",\"channel\":\"typed_mcp\",\"effect_hash\":\"sha256:5555555555555555555555555555555555555555555555555555555555555555\",\"evidence_record_hash\":\"sha256:4444444444444444444444444444444444444444444444444444444444444444\",\"method\":\"GET\",\"path\":\"/revit/context\",\"policy_hash\":\"sha256:3333333333333333333333333333333333333333333333333333333333333333\",\"policy_record_hash\":\"sha256:2222222222222222222222222222222222222222222222222222222222222222\",\"policy_trust_source\":\"deployment\",\"request_hash\":\"sha256:1111111111111111111111111111111111111111111111111111111111111111\",\"runtime_mode\":\"develop\u2028ment\u2029\",\"schema\":\"revit-operator.revit-tool-certification-envelope.v1\",\"version\":1,\"workflow\":\"W \\\"q\\\" \\\\ root\\nCafé \u2028mid\u2029end\"}";
  const envelopeCanonical = canonicalToolExposureJson(envelopeInput);
  assert.equal(envelopeCanonical, expectedEnvelope);
  assert.equal(
    `sha256:${createHash("sha256").update(envelopeCanonical, "utf8").digest("hex")}`,
    "sha256:1af08aa7b5e8ddb26b89b65e1454bc0ee54476f6f9f3e7f382e908b6f19e5b9d"
  );

  const idempotencyInput = {
    target_document_title: "楼层 Cafe\u0301 \u2028Sheet\u2029",
    turn_token_sha256: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    target_document_path: "C:\\模型\\Cafe\u0301\\A\"B\\sheet.rvt",
    schema: "revit-operator.revit-tool-job-idempotency.v2",
    session_id: "session-α",
    path: "/revit/context",
    method: "GET",
    message_id: "message \"q\" \\ \u2028\u2029",
    expires_at: "2035-01-02T08:04:05.006Z",
    canonicalization: "revit-operator.canonical-json.nfc-key-sorted.v1",
    certification_envelope_hash: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
    body_sha256: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    body_present: true,
    target_executor_id: "executor-β"
  };
  const expectedIdempotency = "{\"body_present\":true,\"body_sha256\":\"sha256:6666666666666666666666666666666666666666666666666666666666666666\",\"canonicalization\":\"revit-operator.canonical-json.nfc-key-sorted.v1\",\"certification_envelope_hash\":\"sha256:8888888888888888888888888888888888888888888888888888888888888888\",\"expires_at\":\"2035-01-02T08:04:05.006Z\",\"message_id\":\"message \\\"q\\\" \\\\ \u2028\u2029\",\"method\":\"GET\",\"path\":\"/revit/context\",\"schema\":\"revit-operator.revit-tool-job-idempotency.v2\",\"session_id\":\"session-α\",\"target_document_path\":\"C:\\\\模型\\\\Café\\\\A\\\"B\\\\sheet.rvt\",\"target_document_title\":\"楼层 Café \u2028Sheet\u2029\",\"target_executor_id\":\"executor-β\",\"turn_token_sha256\":\"sha256:7777777777777777777777777777777777777777777777777777777777777777\"}";
  const idempotencyCanonical = canonicalToolExposureJson(idempotencyInput);
  assert.equal(idempotencyCanonical, expectedIdempotency);
  assert.equal(idempotencyCanonical.includes("raw-turn-token"), false);
  assert.equal(idempotencyCanonical.includes("created_at"), false);
  assert.equal(
    createHash("sha256").update(idempotencyCanonical, "utf8").digest("hex"),
    "d5a2bb78dfc557264c746e7bd6ca0e1b7eaaa6757bf10fa09edf8d8c2deba213"
  );
});

test("MCP courier publishes a correlated job and resolves its durable result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-"));
  const restore = saveEnv();
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "revit-courier-context.json"), JSON.stringify({
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    session_id: "session-a",
    message_id: "message-a",
    target_executor_id: "workstation-revit-courier-24024",
    target_document_title: "phase_fallback_room_location_test",
    target_document_path: "C:\\models\\phase_fallback_room_location_test.rvt",
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");

  const pending = callRevitViaCourier<{ status: string }>("/revit/ping", "GET");
  const jobRef = await waitForJob(root);
  const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
  assert.equal(job.session_id, "session-a");
  assert.equal(job.path, "/revit/ping");
  assert.equal(job.method, "GET");
  assert.equal(job.version, "revit-operator.revit-tool-job.v1");
  assert.equal(job.target_executor_id, "workstation-revit-courier-24024");
  assert.equal(job.target_document_title, "phase_fallback_room_location_test");
  assert.equal(job.target_document_path, "C:\\models\\phase_fallback_room_location_test.rvt");
  fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id: jobRef.id,
    correlation_id: jobRef.id,
    status: "succeeded",
    result: { status: "ok" },
    retryable: false
  }), "utf8");
  try {
    assert.deepEqual(await pending, { status: "ok" });
  } finally {
    restore();
  }
});

test("MCP courier preserves structured unknown-outcome metadata when resolving a durable failure receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-result-error-"));
  const restore = saveEnv();
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.REVIT_OPERATOR_MODE = "development";
    process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
    writeContext(root, {
      session_id: "session-result-error",
      message_id: "message-result-error"
    });

    const pending = callRevitViaCourier("/revit/ping", "GET");
    const jobRef = await waitForJob(root);
    const message = "The workstation execution deadline elapsed; outcome is unknown and the call was not retried automatically.";
    fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
      version: "revit-operator.revit-tool-result.v1",
      id: jobRef.id,
      correlation_id: jobRef.id,
      status: "failed",
      result: null,
      error: message,
      code: "courier_execution_deadline_elapsed_outcome_unknown",
      retryable: false,
      outcome_unknown: true
    }), "utf8");

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RevitCourierError);
      assert.equal(error.code, "courier_execution_deadline_elapsed_outcome_unknown");
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.jobId, jobRef.id);
      assert.equal(error.job_id, jobRef.id);
      assert.equal(error.message, `courier_execution_deadline_elapsed_outcome_unknown: ${message}`);
      return true;
    });
  } finally {
    restore();
  }
});

test("certified MCP courier persists a deterministic immutable v2 certification envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-certified-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_V2");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, {
      session_id: "certified-session",
      message_id: "certified-message",
      token: "raw-turn-token-must-not-persist",
      target_executor_id: "certified-workstation",
      target_document_title: "certified-model",
      target_document_path: "C:\\models\\certified-model.rvt"
    });

    const first = startCertifiedPing<{ status: string }>();
    const jobRef = await waitForJob(root);
    const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
    const persistedContext = JSON.parse(fs.readFileSync(path.join(root, "config", "revit-courier-context.json"), "utf8"));
    const envelope = job.certification_envelope;
    assert.equal(job.version, "revit-operator.revit-tool-job.v2");
    assert.equal(job.id, jobRef.id);
    assert.equal(job.idempotency_key, jobRef.id);
    assert.equal(job.correlation_id, jobRef.id);
    assert.equal(job.expires_at, new Date(persistedContext.expires_at).toISOString());
    assert.equal(job.body_present, false);
    assert.equal(job.body_json, "");
    assert.equal(envelope.schema, "revit-operator.revit-tool-certification-envelope.v1");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.canonicalization, "revit-operator.canonical-json.nfc-key-sorted.v1");
    assert.match(envelope.policy_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(envelope.policy_record_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(envelope.evidence_record_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(envelope.request_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(envelope.effect_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(envelope.method, "GET");
    assert.equal(envelope.path, "/revit/ping");
    assert.equal(envelope.body_present, false);
    assert.equal(envelope.body_sha256, `sha256:${createHash("sha256").update("", "utf8").digest("hex")}`);
    assert.equal(envelope.channel, "typed_mcp");
    assert.equal(envelope.alias, "revit_ping");
    assert.equal(envelope.runtime_mode, "hosted");
    assert.equal(envelope.exposure_profile, "certified");
    assert.equal(envelope.policy_trust_source, "deployment");
    assert.match(envelope.envelope_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(job.turn_token, undefined);
    assert.equal(job.turn_token_sha256, `sha256:${createHash("sha256").update("raw-turn-token-must-not-persist", "utf8").digest("hex")}`);
    assert.equal(JSON.stringify(job).includes("raw-turn-token-must-not-persist"), false);

    const second = startCertifiedPing<{ status: string }>();
    assert.deepEqual((await waitForJobs(root, 1)).map(item => item.id), [jobRef.id]);
    fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
      version: "revit-operator.revit-tool-result.v1",
      id: jobRef.id,
      correlation_id: jobRef.id,
      status: "succeeded",
      result: { status: "certified-ok" },
      retryable: false
    }), "utf8");
    assert.deepEqual(await Promise.all([first, second]), [{ status: "certified-ok" }, { status: "certified-ok" }]);
  } finally {
    restore();
  }
});

test("certified move family publishes one sealed v2 envelope and binds it into courier idempotency", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-family-"));
  const restore = saveEnv();
  const policy = writeMoveFamilyPolicy();
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, {
      session_id: "family-session",
      message_id: "family-message",
      token: "family-turn-token",
      target_executor_id: "family-workstation",
      target_document_title: "family-model",
      target_document_path: "C:\\models\\family-model.rvt"
    });
    clearCertifiedMoveTargetLedgerForTests();
    registerCertifiedSpatialObservation(
      { document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
      { observationId: "family-frame", viewId: 42, items: [{ elementId: 4821, sourceScopedId: "host:4821", groundingStatus: "anchored", orientation: { locationKind: "point" } }] }
    );
    const admission = admitCertifiedMoveOneRequest({
      phase: "preview", elementId: 4821, observationId: "family-frame",
      vectorFeet: { x: 1, y: 0, z: 0 }, previewReceipt: undefined
    });
    const pending = runWithRevitToolAlias("revit_move_one_certified", async () => await callRevit(
      "/revit/move-elements", "POST", admission.outboundBody,
      { channel: "typed_mcp", certifiedMoveOneAdmission: admission }
    ));
    const jobRef = await waitForJob(root);
    const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
    const envelope = job.certification_envelope;
    assert.equal(envelope.schema, "revit-operator.revit-tool-certification-envelope.v2");
    assert.equal(envelope.version, 2);
    assert.equal(envelope.request_hash, admission.requestInstanceHash);
    assert.equal(envelope.request_family_admission.request_instance_hash, admission.requestInstanceHash);
    assert.equal(envelope.request_family_admission.family_hash, CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH);
    assert.equal(envelope.request_family_admission.document_session_id, "123e4567e89b42d3a456426614174000");
    assert.equal(envelope.request_family_admission.preview_receipt, null);
    assert.equal(envelope.request_family_admission.outbound_body_sha256, envelope.body_sha256);
    assert.equal(job.id, job.idempotency_key);
    assert.equal(job.correlation_id, job.id);
    const familyResult = {
      rolledBack: true,
      certified_execution_receipt: { completion_challenge_hash: `sha256:${"9".repeat(64)}` }
    };
    const completionChallenge = `cmcc1_${"A".repeat(43)}`;
    const completionChallengeHash = `sha256:${createHash("sha256").update(completionChallenge, "utf8").digest("hex")}`;
    const executionContext = {
      schema: "revit-operator.certified-courier-execution-context.v1",
      transport_kind: "courier",
      dispatch_id: job.id,
      correlation_id: job.correlation_id,
      execution_session_id: job.session_id,
      executor_id: job.target_executor_id,
      certification_envelope_hash: envelope.envelope_hash,
      completion_challenge_hash: completionChallengeHash
    };
    const terminalResult = {
      version: "revit-operator.revit-tool-result.v1",
      id: job.id,
      correlation_id: job.id,
      status: "succeeded",
      result: familyResult,
      certified_execution_context: executionContext,
      retryable: false
    };
    const challenge = {
      schema: "revit-operator.courier-completion-challenge.v1",
      transport_kind: "courier",
      dispatch_id: job.id,
      correlation_id: job.correlation_id,
      execution_session_id: job.session_id,
      executor_id: job.target_executor_id,
      certification_envelope_hash: envelope.envelope_hash,
      completion_challenge_hash: completionChallengeHash,
      job_id: job.id,
      session_id: job.session_id,
      completion_challenge: completionChallenge,
      policy_hash: envelope.policy_hash,
      document_session_id: envelope.request_family_admission.document_session_id,
      request_instance_hash: envelope.request_family_admission.request_instance_hash,
      issued_at_utc: new Date().toISOString()
    };
    const decision = {
      schema: "revit-operator.courier-completion-terminal-decision.v1",
      kind: "success",
      job_id: job.id,
      correlation_id: job.correlation_id,
      session_id: job.session_id,
      executor_id: job.target_executor_id,
      certification_envelope_hash: envelope.envelope_hash,
      request_instance_hash: envelope.request_family_admission.request_instance_hash,
      completion_challenge_hash: completionChallengeHash,
      terminal_result_sha256: `sha256:${createHash("sha256").update(JSON.stringify(terminalResult), "utf8").digest("hex")}`,
      terminal_result: terminalResult,
      decided_at_utc: new Date().toISOString()
    };
    fs.writeFileSync(path.join(jobRef.dir, "completion-challenge-issued.v1.json"), JSON.stringify(challenge), "utf8");
    fs.writeFileSync(path.join(jobRef.dir, "completion-terminal-decision.v1.json"), JSON.stringify(decision), "utf8");
    fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify(terminalResult), "utf8");
    assert.deepEqual(await pending, familyResult);
  } finally {
    clearCertifiedMoveTargetLedgerForTests();
    restore();
  }
});

test("certified family courier rejects raw or standalone-decision failure receipts", async () => {
  const policy = writeMoveFamilyPolicy();
  for (const mode of ["raw", "standalone-decision", "deleted-job", "downgraded-job"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-family-forged-failure-"));
    const restore = saveEnv();
    try {
      process.env.OPERATOR_WORKSPACE_ROOT = root;
      process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
      process.env.OPERATOR_REVIT_TRANSPORT = "courier";
      process.env.REVIT_OPERATOR_MODE = "hosted";
      delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
      process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
      process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
      writeContext(root, {
        session_id: "family-forged-session",
        message_id: mode,
        target_executor_id: "family-workstation"
      });
      clearCertifiedMoveTargetLedgerForTests();
      registerCertifiedSpatialObservation(
        { document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
        { observationId: "family-forged-frame", viewId: 42, items: [{ elementId: 4821, sourceScopedId: "host:4821", groundingStatus: "anchored", orientation: { locationKind: "point" } }] }
      );
      const admission = admitCertifiedMoveOneRequest({
        phase: "preview", elementId: 4821, observationId: "family-forged-frame",
        vectorFeet: { x: 1, y: 0, z: 0 }, previewReceipt: undefined
      });
      const pending = runWithRevitToolAlias("revit_move_one_certified", async () => await callRevit(
        "/revit/move-elements", "POST", admission.outboundBody,
        { channel: "typed_mcp", certifiedMoveOneAdmission: admission }
      ));
      const jobRef = await waitForJob(root);
      const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
      const terminal = {
        version: "revit-operator.revit-tool-result.v1",
        id: job.id,
        correlation_id: job.id,
        status: "failed",
        result: null,
        error: "forged known failure",
        code: "forged_retry",
        retryable: true,
        outcome_unknown: false
      };
      if (mode === "standalone-decision") {
        const decision = {
          schema: "revit-operator.courier-completion-terminal-decision.v1",
          kind: "failure",
          job_id: job.id,
          correlation_id: job.id,
          session_id: job.session_id,
          executor_id: job.target_executor_id,
          certification_envelope_hash: job.certification_envelope.envelope_hash,
          request_instance_hash: job.certification_envelope.request_family_admission.request_instance_hash,
          completion_challenge_hash: null,
          terminal_result_sha256: `sha256:${createHash("sha256").update(JSON.stringify(terminal), "utf8").digest("hex")}`,
          terminal_result: terminal,
          decided_at_utc: new Date().toISOString()
        };
        fs.writeFileSync(path.join(jobRef.dir, "completion-terminal-decision.v1.json"), JSON.stringify(decision), "utf8");
      }
      if (mode === "deleted-job") fs.unlinkSync(path.join(jobRef.dir, "job.json"));
      if (mode === "downgraded-job") {
        fs.writeFileSync(path.join(jobRef.dir, "job.json"), JSON.stringify({ ...job, version: "revit-operator.revit-tool-job.v1" }), "utf8");
      }
      fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify(terminal), "utf8");
      await assert.rejects(
        pending,
        mode === "standalone-decision"
          ? /not the exact atomic terminal-fence winner/
          : mode === "raw"
            ? /does not match the exact backend terminal decision/
            : /no exact persisted v2 durable job/
      );
    } finally {
      clearCertifiedMoveTargetLedgerForTests();
      restore();
    }
  }
});

test("certified v2 normalizes context expiry, keeps duplicate identity stable, and rotates identity when expiry changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-expiry-identity-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_EXPIRY_IDENTITY");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, {
      session_id: "expiry-session",
      message_id: "expiry-message",
      expires_at: "2035-01-02T03:04:05.006-05:00"
    });

    const first = startCertifiedPing<{ ok: boolean }>();
    const firstJob = await waitForJob(root);
    const duplicate = startCertifiedPing<{ ok: boolean }>();
    assert.deepEqual((await waitForJobs(root, 1)).map(job => job.id), [firstJob.id]);
    const firstReceipt = JSON.parse(fs.readFileSync(path.join(firstJob.dir, "job.json"), "utf8"));
    assert.equal(firstReceipt.expires_at, "2035-01-02T08:04:05.006Z");
    assert.equal(firstReceipt.id, firstJob.id);
    assert.equal(firstReceipt.correlation_id, firstJob.id);

    writeContext(root, {
      session_id: "expiry-session",
      message_id: "expiry-message",
      expires_at: "2035-01-02T03:04:06.006-05:00"
    });
    const rotated = startCertifiedPing<{ ok: boolean }>();
    const jobs = await waitForJobs(root, 2);
    assert.equal(new Set(jobs.map(job => job.id)).size, 2);
    const receipts = jobs.map(job => JSON.parse(fs.readFileSync(path.join(job.dir, "job.json"), "utf8")));
    assert.deepEqual(new Set(receipts.map(job => job.expires_at)), new Set([
      "2035-01-02T08:04:05.006Z",
      "2035-01-02T08:04:06.006Z"
    ]));
    for (const [index, job] of jobs.entries()) {
      const receipt = receipts[index]!;
      assert.equal(receipt.id, job.id);
      assert.equal(receipt.correlation_id, job.id);
      writeSucceededResult(job, { ok: true });
    }
    assert.deepEqual(await Promise.all([first, duplicate, rotated]), [{ ok: true }, { ok: true }, { ok: true }]);
  } finally {
    restore();
  }
});

test("certified MCP courier separates identities when the immutable policy envelope changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-envelope-change-"));
  const restore = saveEnv();
  const policyA = writePingPolicy("CERTIFIED_A");
  const policyB = writePingPolicy("CERTIFIED_B");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    writeContext(root, { session_id: "envelope-session", message_id: "envelope-message" });

    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policyA.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policyA.policyHash;
    const first = startCertifiedPing<{ value: string }>();
    await waitForJobs(root, 1);

    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policyB.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policyB.policyHash;
    const second = startCertifiedPing<{ value: string }>();
    const jobs = await waitForJobs(root, 2);
    assert.notEqual(jobs[0]!.id, jobs[1]!.id);
    for (const [index, job] of jobs.entries()) {
      fs.writeFileSync(path.join(job.dir, "result.json"), JSON.stringify({
        version: "revit-operator.revit-tool-result.v1",
        id: job.id,
        correlation_id: job.id,
        status: "succeeded",
        result: { value: String(index) },
        retryable: false
      }), "utf8");
    }
    const results = await Promise.all([first, second]);
    assert.equal(results.length, 2);
  } finally {
    restore();
  }
});

test("certified MCP courier rejects missing or malformed admission before publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-admission-required-"));
  const restore = saveEnv();
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.REVIT_OPERATOR_MODE = "local";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    writeContext(root, { session_id: "admission-session", message_id: "admission-message" });
    await assert.rejects(
      callRevitViaCourier("/revit/ping", "GET"),
      /in-process admission capability/
    );
    await assert.rejects(
      callRevitViaCourier("/revit/ping", "GET", undefined, { certifiedAdmission: {} as CertifiedCourierAdmission }),
      /unbranded or stale admission capability/
    );
    assert.equal(fs.existsSync(path.join(root, "artifacts", "revit-courier", "jobs")), false);
  } finally {
    restore();
  }
});

test("certified MCP courier refuses to resume an existing v1 job", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-v1-reject-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_V1_REJECT");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    const context = {
      session_id: "legacy-session",
      message_id: "legacy-message",
      target_executor_id: "legacy-workstation",
      target_document_title: "legacy-model",
      target_document_path: "C:\\models\\legacy-model.rvt"
    };
    writeContext(root, context);
    const legacyId = createHash("sha256")
      .update(`${context.session_id}\n${context.message_id}\n\n${context.target_executor_id}\n${context.target_document_title}\n${context.target_document_path}\nGET\n/revit/ping\nnull`)
      .digest("hex");
    const legacyPath = path.join(root, "artifacts", "revit-courier", "jobs", legacyId, "job.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: "revit-operator.revit-tool-job.v1",
      id: legacyId,
      correlation_id: legacyId,
      idempotency_key: legacyId,
      session_id: context.session_id,
      message_id: context.message_id,
      method: "GET",
      path: "/revit/ping",
      status: "pending"
    }), "utf8");
    await assert.rejects(
      startCertifiedPing(),
      /refuses to resume a legacy v1 job/
    );
  } finally {
    restore();
  }
});

test("certified MCP courier preserves present raw JSON body bytes, order, escapes, and newlines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-raw-body-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_RAW_BODY");
  const rawBody = "{\n  \"z\": \"line\\n\\u0041\", \"a\": \"\\\\\", \"order\": [2, 1]\n}";
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, { session_id: "raw-body-session", message_id: "raw-body-message" });

    const pending = startCertifiedPing<{ ok: boolean }>(rawBody);
    const jobRef = await waitForJob(root);
    const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
    const expectedBodyHash = `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
    assert.equal(job.body_present, true);
    assert.equal(job.body_json, rawBody);
    assert.equal(job.certification_envelope.body_present, true);
    assert.equal(job.certification_envelope.body_sha256, expectedBodyHash);
    fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
      version: "revit-operator.revit-tool-result.v1",
      id: jobRef.id,
      correlation_id: jobRef.id,
      status: "succeeded",
      result: { ok: true },
      retryable: false
    }), "utf8");
    assert.deepEqual(await pending, { ok: true });
  } finally {
    restore();
  }
});

test("certified courier context accepts Unicode identity strings within the aligned limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-unicode-context-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_UNICODE_CONTEXT");
  try {
    assert.deepEqual(REVIT_COURIER_CONTEXT_STRING_LIMITS, {
      session_id: 200,
      message_id: 200,
      target_executor_id: 200,
      target_document_title: 500,
      target_document_path: 2_000
    });
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    const identity = {
      session_id: "会话-α",
      message_id: "消息-Cafe\u0301-\u2028",
      target_executor_id: "执行器-β",
      target_document_title: "楼层 Café \u2029",
      target_document_path: "C:\\模型\\Café\\图纸.rvt"
    };
    writeContext(root, identity);
    const pending = startCertifiedPing<{ ok: boolean }>();
    const job = await waitForJob(root);
    const receipt = JSON.parse(fs.readFileSync(path.join(job.dir, "job.json"), "utf8"));
    assert.equal(receipt.session_id, identity.session_id);
    assert.equal(receipt.message_id, identity.message_id);
    assert.equal(receipt.target_executor_id, identity.target_executor_id);
    assert.equal(receipt.target_document_title, identity.target_document_title);
    assert.equal(receipt.target_document_path, identity.target_document_path);
    assert.equal(receipt.correlation_id, job.id);
    writeSucceededResult(job, { ok: true });
    assert.deepEqual(await pending, { ok: true });
  } finally {
    restore();
  }
});

test("certified courier rejects unsafe or oversized context identity strings and body before publication", async () => {
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_CONTEXT_LIMITS");
  try {
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    const cases: Array<{ field: string; value: string }> = [
      { field: "session_id", value: `bad\u0000session` },
      { field: "message_id", value: `bad\rmessage` },
      { field: "target_executor_id", value: `bad\nexecutor` },
      { field: "target_document_title", value: `bad\ttitle` },
      { field: "target_document_path", value: `bad\u007Fpath` },
      { field: "session_id", value: "s".repeat(201) },
      { field: "message_id", value: "m".repeat(201) },
      { field: "target_executor_id", value: "e".repeat(201) },
      { field: "target_document_title", value: "t".repeat(501) },
      { field: "target_document_path", value: "p".repeat(2_001) }
    ];
    for (const [index, invalid] of cases.entries()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `revit-mcp-courier-invalid-context-${index}-`));
      process.env.OPERATOR_WORKSPACE_ROOT = root;
      writeContext(root, {
        session_id: "valid-session",
        message_id: "valid-message",
        [invalid.field]: invalid.value
      });
      await assert.rejects(startCertifiedPing(), new RegExp(`context ${invalid.field}`));
      assert.equal(fs.existsSync(path.join(root, "artifacts", "revit-courier", "jobs")), false);
    }

    const bodyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-body-limit-"));
    process.env.OPERATOR_WORKSPACE_ROOT = bodyRoot;
    writeContext(bodyRoot, { session_id: "body-limit-session", message_id: "body-limit-message" });
    const oversizedJsonBody = `\"${"x".repeat(2 * 1024 * 1024)}\"`;
    assert.ok(Buffer.byteLength(oversizedJsonBody, "utf8") > 2 * 1024 * 1024);
    await assert.rejects(startCertifiedPing(oversizedJsonBody), /exceeds 2 MiB/);
    assert.equal(fs.existsSync(path.join(bodyRoot, "artifacts", "revit-courier", "jobs")), false);
  } finally {
    restore();
  }
});

test("certified MCP courier binds target and raw-body identity into distinct v2 jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-target-body-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_TARGET_BODY");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, {
      session_id: "target-body-session",
      message_id: "target-body-message",
      target_document_path: "C:\\models\\target-a.rvt"
    });
    const first = startCertifiedPing<{ index: number }>("{\"a\":1,\"b\":2}");
    await waitForJobs(root, 1);

    writeContext(root, {
      session_id: "target-body-session",
      message_id: "target-body-message",
      target_document_path: "C:\\models\\target-b.rvt"
    });
    const second = startCertifiedPing<{ index: number }>("{\"a\":1,\"b\":2}");
    await waitForJobs(root, 2);
    const third = startCertifiedPing<{ index: number }>("{\"b\":2,\"a\":1}");
    const jobs = await waitForJobs(root, 3);
    assert.equal(new Set(jobs.map(job => job.id)).size, 3);
    for (const [index, job] of jobs.entries()) {
      fs.writeFileSync(path.join(job.dir, "result.json"), JSON.stringify({
        version: "revit-operator.revit-tool-result.v1",
        id: job.id,
        correlation_id: job.id,
        status: "succeeded",
        result: { index },
        retryable: false
      }), "utf8");
    }
    assert.equal((await Promise.all([first, second, third])).length, 3);
  } finally {
    restore();
  }
});

test("certified MCP courier fails closed on a tampered existing v2 receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-tamper-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_TAMPER");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, { session_id: "tamper-session", message_id: "tamper-message" });

    const first = startCertifiedPing<{ ok: boolean }>();
    const jobRef = await waitForJob(root);
    const jobPath = path.join(jobRef.dir, "job.json");
    const tampered = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    tampered.certification_envelope.envelope_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fs.writeFileSync(jobPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await assert.rejects(startCertifiedPing(), /idempotency collision detected/);
    assert.deepEqual((await waitForJobs(root, 1)).map(job => job.id), [jobRef.id]);
    fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
      version: "revit-operator.revit-tool-result.v1",
      id: jobRef.id,
      correlation_id: jobRef.id,
      status: "succeeded",
      result: { ok: true },
      retryable: false
    }), "utf8");
    assert.deepEqual(await first, { ok: true });
  } finally {
    restore();
  }
});

test("certified retry rejects altered id, correlation, expiry, and timing receipts", async () => {
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_RECEIPT_INTEGRITY");
  const mutations: Array<{ name: string; apply: (job: any) => void }> = [
    { name: "id", apply: job => { job.id = "0".repeat(64); } },
    { name: "correlation", apply: job => { job.correlation_id = "1".repeat(64); } },
    { name: "expiry", apply: job => { job.expires_at = new Date(Date.parse(job.expires_at) + 1_000).toISOString(); } },
    { name: "created-at", apply: job => { job.created_at = "not-a-canonical-instant"; } }
  ];
  try {
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    for (const mutation of mutations) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `revit-mcp-courier-receipt-${mutation.name}-`));
      process.env.OPERATOR_WORKSPACE_ROOT = root;
      writeContext(root, {
        session_id: `receipt-${mutation.name}`,
        message_id: `receipt-${mutation.name}`,
        expires_at: "2035-01-02T08:04:05.006Z"
      });
      const first = startCertifiedPing<{ ok: boolean }>();
      const job = await waitForJob(root);
      const jobPath = path.join(job.dir, "job.json");
      const tampered = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      mutation.apply(tampered);
      fs.writeFileSync(jobPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      await assert.rejects(startCertifiedPing(), /idempotency collision detected/);
      assert.deepEqual((await waitForJobs(root, 1)).map(item => item.id), [job.id]);
      writeSucceededResult(job, { ok: true });
      assert.deepEqual(await first, { ok: true });
    }
  } finally {
    restore();
  }
});

test("opaque courier admissions require the original alias context and are single-use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-capability-context-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_CAPABILITY_CONTEXT");
  const mint = () => runWithRevitToolAlias("revit_ping", () => createCertifiedCourierAdmission({
    method: "GET",
    path: "/revit/ping",
    channel: "typed_mcp"
  }));
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, { session_id: "capability-session", message_id: "capability-message" });

    const outside = mint();
    assert.ok(outside);
    await assert.rejects(
      callRevitViaCourier("/revit/ping", "GET", undefined, { certifiedAdmission: outside }),
      /active MCP alias context/
    );

    const differentAlias = mint();
    assert.ok(differentAlias);
    await runWithRevitToolAlias("revit_get_context", async () => {
      await assert.rejects(
        callRevitViaCourier("/revit/ping", "GET", undefined, { certifiedAdmission: differentAlias }),
        /different MCP alias/
      );
    });

    const once = mint();
    assert.ok(once);
    await runWithRevitToolAlias("revit_ping", async () => {
      await assert.rejects(
        callRevitViaCourier("/revit/ping", "POST", undefined, { certifiedAdmission: once }),
        /does not bind the exact requested method and path/
      );
      await assert.rejects(
        callRevitViaCourier("/revit/ping", "GET", undefined, { certifiedAdmission: once }),
        /unbranded or stale admission capability/
      );
    });
    assert.equal(fs.existsSync(path.join(root, "artifacts", "revit-courier", "jobs")), false);
  } finally {
    restore();
  }
});

test("certified MCP courier refuses a stale opaque admission before publishing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-stale-admission-"));
  const restore = saveEnv();
  const policyA = writePingPolicy("CERTIFIED_STALE_A");
  const policyB = writePingPolicy("CERTIFIED_STALE_B");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policyA.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policyA.policyHash;
    writeContext(root, { session_id: "stale-session", message_id: "stale-message" });
    const capability = runWithRevitToolAlias("revit_ping", () => createCertifiedCourierAdmission({
      method: "GET",
      path: "/revit/ping",
      channel: "typed_mcp"
    }));
    assert.ok(capability);
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policyB.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policyB.policyHash;
    await runWithRevitToolAlias("revit_ping", async () => {
      await assert.rejects(
        callRevitViaCourier("/revit/ping", "GET", undefined, { certifiedAdmission: capability }),
        /admission decision changed at policyHash/
      );
    });
    assert.equal(fs.existsSync(path.join(root, "artifacts", "revit-courier", "jobs")), false);
  } finally {
    restore();
  }
});

test("MCP courier resumes one idempotent job when the same turn retries an identical call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-idempotent-"));
  const restore = saveEnv();
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "revit-courier-context.json"), JSON.stringify({
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    session_id: "session-resume",
    message_id: "message-resume",
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");

  const first = callRevitViaCourier<{ status: string }>("/revit/set-parameter", "POST", { changes: [{ elementId: 1, parameterName: "Mark", value: "A" }] });
  const jobRef = await waitForJob(root);
  const second = callRevitViaCourier<{ status: string }>("/revit/set-parameter", "POST", { changes: [{ elementId: 1, parameterName: "Mark", value: "A" }] });
  const jobIds = fs.readdirSync(path.join(root, "artifacts", "revit-courier", "jobs"));
  assert.deepEqual(jobIds, [jobRef.id]);
  assert.equal(jobRef.id.length, 64);

  fs.writeFileSync(path.join(jobRef.dir, "result.json"), JSON.stringify({
    version: "revit-operator.revit-tool-result.v1",
    id: jobRef.id,
    correlation_id: jobRef.id,
    status: "succeeded",
    result: { status: "applied-once" },
    retryable: false
  }), "utf8");
  try {
    assert.deepEqual(await Promise.all([first, second]), [{ status: "applied-once" }, { status: "applied-once" }]);
  } finally {
    restore();
  }
});

test("MCP courier terminalizes an unclaimed timeout before the outer turn stalls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-timeout-"));
  const restore = saveEnv();
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "revit-courier-context.json"), JSON.stringify({
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    session_id: "session-timeout",
    message_id: "message-timeout",
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");

  const pending = callRevitViaCourier("/revit/ping", "GET");
  const jobRef = await waitForJob(root);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RevitCourierError);
    assert.equal(error.code, "courier_job_timed_out_before_claim");
    assert.equal(error.retryable, true);
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.outcome_unknown, false);
    assert.equal(error.jobId, jobRef.id);
    assert.equal(error.job_id, jobRef.id);
    assert.match(error.message, /courier_job_timed_out_before_claim/);
    return true;
  });

  const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
  const result = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "result.json"), "utf8"));
  assert.equal(job.status, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.code, "courier_job_timed_out_before_claim");
  assert.equal(result.retryable, true);
  assert.equal(result.outcome_unknown, false);
  restore();
});

test("MCP courier terminalizes a running deadline with a durable machine-readable unknown outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-running-timeout-"));
  const restore = saveEnv();
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.REVIT_OPERATOR_MODE = "development";
    process.env.OPERATOR_TOOL_EXPOSURE_PROFILE = "laboratory";
    writeContext(root, {
      session_id: "session-running-timeout",
      message_id: "message-running-timeout"
    });

    const pending = callRevitViaCourier("/revit/ping", "GET");
    const jobRef = await waitForJob(root);
    const jobPath = path.join(jobRef.dir, "job.json");
    const claimed = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    fs.writeFileSync(jobPath, `${JSON.stringify({
      ...claimed,
      status: "running",
      claim: {
        session_id: "session-running-timeout",
        executor_id: "executor-running-timeout"
      }
    }, null, 2)}\n`, "utf8");

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RevitCourierError);
      assert.equal(error.code, "courier_execution_deadline_elapsed_outcome_unknown");
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.jobId, jobRef.id);
      assert.equal(error.job_id, jobRef.id);
      assert.match(error.message, /outcome is unknown and the call was not retried automatically/);
      return true;
    });

    const result = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "result.json"), "utf8"));
    assert.equal(result.status, "failed");
    assert.equal(result.code, "courier_execution_deadline_elapsed_outcome_unknown");
    assert.equal(result.retryable, false);
    assert.equal(result.outcome_unknown, true);
  } finally {
    restore();
  }
});

test("certified v2 courier timeout never publishes competing terminal truth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-mcp-courier-certified-timeout-"));
  const restore = saveEnv();
  const policy = writePingPolicy("CERTIFIED_TIMEOUT_OWNER");
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_REVIT_COURIER_TIMEOUT_MS = "5000";
    process.env.OPERATOR_REVIT_TRANSPORT = "courier";
    process.env.REVIT_OPERATOR_MODE = "hosted";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_PATH = policy.policyPath;
    process.env.OPERATOR_TOOL_EXPOSURE_POLICY_SHA256 = policy.policyHash;
    writeContext(root, { session_id: "certified-timeout-session", message_id: "certified-timeout-message" });

    const pending = startCertifiedPing<{ ok: boolean }>();
    const jobRef = await waitForJob(root);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RevitCourierError);
      assert.equal(error.code, "courier_job_timed_out_before_claim");
      assert.equal(error.retryable, true);
      assert.equal(error.outcome_unknown, false);
      return true;
    });
    const job = JSON.parse(fs.readFileSync(path.join(jobRef.dir, "job.json"), "utf8"));
    assert.equal(job.version, "revit-operator.revit-tool-job.v2");
    assert.equal(job.status, "pending");
    assert.equal(fs.existsSync(path.join(jobRef.dir, "result.json")), false);
  } finally {
    restore();
  }
});
