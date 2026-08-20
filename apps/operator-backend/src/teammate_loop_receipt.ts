import type { ChatResponse } from "./contracts.js";

type TeammateReceipt = NonNullable<ChatResponse["teammate_loop_receipt"]>;
export type SuccessfulPreviewReceipt = NonNullable<TeammateReceipt["preview_receipts"]>[number];

type TeammateReceiptState = {
  contract: Pick<TeammateReceipt, "turn_kind" | "context_state" | "stage">;
  preview_action_ids: string[];
  preview_receipts: SuccessfulPreviewReceipt[];
  apply_action_id: string | null;
  verification_action_ids: string[];
  apply_attempts: number;
  verified: boolean;
  verification_mode: TeammateReceipt["verification_mode"];
  verification_action_id: string | null;
  verification_evidence_sha256: string | null;
  blocked_reason: string | null;
};

export function successfulPreviewReceipt(actionId: string, path: string, evidenceDigest: string): SuccessfulPreviewReceipt {
  return { action_id: actionId, path, status: "success", evidence_sha256: `sha256:${evidenceDigest}` };
}

export function buildTeammateLoopReceipt(state: TeammateReceiptState): TeammateReceipt {
  const previewReceipts = state.preview_receipts.slice(-8);
  return {
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: state.contract.turn_kind,
    context_state: state.contract.context_state,
    stage: state.contract.stage,
    // The externally certified action list is a success claim, so derive it
    // from the same receipts that substantiate it. The runtime keeps attempted
    // preview IDs separately for unique action IDs and recovery history.
    preview_action_ids: previewReceipts.map(receipt => receipt.action_id),
    preview_receipts: previewReceipts,
    apply_action_id: state.apply_action_id,
    verification_action_ids: state.verification_action_ids.slice(-8),
    apply_attempts: state.apply_attempts,
    verified: state.verified,
    verification_mode: state.verification_mode,
    verification_action_id: state.verification_action_id,
    verification_evidence_sha256: state.verification_evidence_sha256,
    blocked_reason: state.blocked_reason
  };
}
