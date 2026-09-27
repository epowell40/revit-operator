import { retainCompletionOutboxV2, retainNativeCompletionDispatchV1 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
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

export function retainAssignmentNativeDispatchV1(lease: unknown, native: NativeCompletionDispatchV1["native"]): void {
  const key = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  if (!key) return;
  retainNativeCompletionDispatchV1(getWorkspaceRoot(), key, lease, native);
}
