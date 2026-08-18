import type { RevitToolJob } from "./revit_tool_jobs.js";

export const REVIT_COURIER_SETTLEMENT_RECEIPT_SCHEMA = "revit-operator.revit-courier-settlement-receipt.v1";

/**
 * Returns the bounded acknowledgement needed by the workstation after it has
 * durably settled a courier job. Request bodies, admissions, claims, and tool
 * results stay server-side and are never echoed over the slow return link.
 */
export function buildRevitCourierSettlementReceipt(job: RevitToolJob): Record<string, unknown> {
  return {
    schema: REVIT_COURIER_SETTLEMENT_RECEIPT_SCHEMA,
    job_id: job.id,
    correlation_id: job.correlation_id,
    status: job.status,
    finished_at: job.finished_at ?? null,
    error: job.error ?? null,
    request_echoed: false,
    result_echoed: false
  };
}
