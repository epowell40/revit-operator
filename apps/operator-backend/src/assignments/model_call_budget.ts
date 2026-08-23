import type { ModelCallReceipt } from "../contracts.js";
import { recordAssignmentTurnProgress } from "./turn_settlement.js";

export function assignmentModelReceiptObserver(
  sessionId: string,
  onTerminal: () => void
): (receipt: ModelCallReceipt) => void {
  let notified = false;
  return receipt => {
    const projection = recordAssignmentTurnProgress(sessionId, `model:${receipt.call_id}`);
    if (!notified && (projection?.terminal_state === "blocked" || projection?.terminal_state === "failed")) {
      notified = true;
      onTerminal();
    }
  };
}
