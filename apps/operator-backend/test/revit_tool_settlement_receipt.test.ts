import test from "node:test";
import assert from "node:assert/strict";
import { buildRevitCourierSettlementReceipt } from "../src/courier/revit_tool_settlement_receipt.js";

test("courier settlement acknowledgements never echo large requests, admissions, claims, or results", () => {
  const job = {
    version: "revit-operator.revit-tool-job.v1",
    id: "job-1",
    session_id: "session-1",
    correlation_id: "job-1",
    idempotency_key: "key-1",
    method: "POST",
    path: "/revit/find-elements",
    body: { geometry: "x".repeat(500_000) },
    general_agent_admission: { bearer: "must-not-echo" },
    claim: { executor_id: "executor-1", claimed_at: "now", lease_expires_at: "later" },
    result: { inventory: "y".repeat(500_000) },
    created_at: "2026-08-18T00:00:00.000Z",
    expires_at: "2026-08-18T01:00:00.000Z",
    finished_at: "2026-08-18T00:01:00.000Z",
    status: "succeeded"
  } as any;

  const receipt = buildRevitCourierSettlementReceipt(job);
  assert.deepEqual(receipt, {
    schema: "revit-operator.revit-courier-settlement-receipt.v1",
    job_id: "job-1",
    correlation_id: "job-1",
    status: "succeeded",
    finished_at: "2026-08-18T00:01:00.000Z",
    error: null,
    request_echoed: false,
    result_echoed: false
  });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt), "utf8") < 1_000);
  assert.doesNotMatch(JSON.stringify(receipt), /must-not-echo|geometry|inventory|executor-1/);
});
