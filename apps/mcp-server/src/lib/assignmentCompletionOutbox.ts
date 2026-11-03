import { deliverCompletionOutboxV2, retainCompletionOutboxV2, retainNativeCompletionDispatchV1, COMPLETION_DELIVERY_BUDGET_V2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import type { NativeCompletionDispatchV1 } from "@revitoperator/assignment-kernel-v2-contracts";
import { getWorkspaceRoot } from "./workspace.js";

/** Only the backend-owned MCP child receives this producer key. Unbound or
 * independently launched MCP clients cannot publish trusted recovery records.
 */
export function retainAssignmentCompletionV2(lease: unknown, envelope: unknown): void {
  const key = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  if (!key) return;
  retainCompletionOutboxV2(getWorkspaceRoot(), key, lease, envelope);
}

export function deliverAssignmentCompletionV2(lease: unknown, envelope: unknown): unknown {
  const key = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  if (key) return deliverCompletionOutboxV2(getWorkspaceRoot(), key, lease, envelope);
  if (Buffer.byteLength(JSON.stringify(envelope)) > COMPLETION_DELIVERY_BUDGET_V2)
    throw new Error("assignment_completion_outbox_delivery_storage_unavailable");
  return envelope;
}

export function retainAssignmentNativeDispatchV1(lease: unknown, native: NativeCompletionDispatchV1["native"]): void {
  const key = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  if (!key) return;
  retainNativeCompletionDispatchV1(getWorkspaceRoot(), key, lease, native);
}
