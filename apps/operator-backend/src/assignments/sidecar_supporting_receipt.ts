import type http from "node:http";
import { readJson, writeJson } from "../http.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";

/** Retain controller reports against the exact V2 run. These are supporting,
 * caller-reported evidence, never native settlement, progress credit or proof
 * of completion. Late receipts may be retained without reopening the task. */
export function recordSidecarSupportingReceiptV2(sessionId: string, input: unknown) {
  const row = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const receipt = row.receipt && typeof row.receipt === "object" && !Array.isArray(row.receipt)
    ? row.receipt as Record<string, unknown> : {};
  if (typeof row.assignment_id !== "string" || typeof row.assignment_run_id !== "string"
    || !Number.isSafeInteger(row.assignment_generation)
    || typeof receipt.call_id !== "string" || !/^[A-Za-z0-9:._-]{1,240}$/.test(receipt.call_id)
    || typeof receipt.tool_name !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(receipt.tool_name)
    || !["success", "failed"].includes(receipt.status as string)
    || Buffer.byteLength(JSON.stringify(row), "utf8") > 32_000) {
    throw new Error("sidecar_supporting_receipt_request_invalid");
  }
  const resolved = assignmentKernelV2ForBinding({ session_id: sessionId,
    assignment_id: row.assignment_id, run_id: row.assignment_run_id,
    generation: row.assignment_generation as number });
  if (!resolved || resolved.goal.related_session_id !== sessionId
    || resolved.goal.work_budget?.mode !== "sidecar_computer"
    || resolved.goal.work_budget?.source !== "operator_desktop") {
    throw new Error("sidecar_supporting_receipt_binding_mismatch");
  }
  const retained = storeEvidence({ scope: { session_id: sessionId,
    assignment_id: resolved.binding.assignment_id, run_id: resolved.binding.run_id,
    generation: resolved.binding.generation }, source: "operator-desktop.supporting-receipt",
    trust_level: "untrusted_caller", verification_relevance: "supporting",
    bounded_summary: `Controller reported ${receipt.tool_name} ${receipt.status}.`,
    raw: { schema: "revit-operator.sidecar-supporting-receipt/v1", receipt } });
  return { evidence_ref: retained.ref, assignment_version: resolved.snapshot.assignment_version };
}

/** Authentication and session ownership are enforced by the composition. */
export async function handleSidecarSupportingReceiptHttp(
  req: http.IncomingMessage, res: http.ServerResponse,
  boundary: { normalizeSessionId(value: unknown): string; sessionAllowed(sessionId: string): boolean }
): Promise<void> {
  const body = await readJson(req, 32_000).catch(() => ({}));
  const sessionId = boundary.normalizeSessionId((body as any)?.session_id);
  if (!sessionId) return writeJson(res, 400, { error: "session_id is required." });
  if (!boundary.sessionAllowed(sessionId)) return;
  try { return writeJson(res, 200, { ok: true, ...recordSidecarSupportingReceiptV2(sessionId, body) }); }
  catch (error) { return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
}
