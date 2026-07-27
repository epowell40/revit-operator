import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { revitCourierTargetFromContext } from "../src/brains/codex_brain.js";
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from "../src/courier/revit_courier_context.js";
import {
  REVIT_COURIER_JOB_VERSION,
  claimNextRevitToolJob,
  completeRevitToolJob,
  failRevitToolJob
} from "../src/courier/revit_tool_jobs.js";

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
  assert.deepEqual(revitCourierTargetFromContext({ ui: { revit_document: { courier_executor_id: "wrong executor", title: "must-not-bind" } } }), {});
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
  assert.deepEqual(revitCourierTargetFromContext({
    ...canonical,
    ui: { revit_document: { courier_executor_id: "other-revit-courier-99", title: "Duke B200", path: "C:\\models\\Duke B200.rvt" } }
  }), {});
  assert.deepEqual(revitCourierTargetFromContext({
    ...canonical,
    ui: { revit_document: { courier_executor_id: "workstation-revit-courier-24024", title: "Snowdon", path: "C:\\models\\Snowdon.rvt" } }
  }), {});
});
