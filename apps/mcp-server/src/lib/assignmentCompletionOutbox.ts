import { retainCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { getWorkspaceRoot } from "./workspace.js";

/** Only the backend-owned MCP child receives this producer key. Unbound or
 * independently launched MCP clients cannot publish trusted recovery records.
 */
export function retainAssignmentCompletionV2(lease: unknown, envelope: unknown): void {
  const key = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  if (!key) return;
  retainCompletionOutboxV2(getWorkspaceRoot(), key, lease, envelope);
}
