import { createHash } from "node:crypto";
import type { ChatRequest } from "../contracts.js";
import { recentCommandEvents } from "../memory/sqlite_store.js";
import { validateIntakeDecision } from "../conversation_intake.js";
import { resolveAgentModelSettings, resolveSpeedSettings } from "../speed_config.js";

/** A server-retained semantic decision tunes reasoning, never tool authority.
 * Exact message and original text prevent a caller-supplied route or stale
 * receipt from reducing the effort of a different request or continuation. */
export function conversationWorkProfile(req: ChatRequest) {
  const settings = resolveAgentModelSettings(req.context);
  const normal = { settings, instruction: "", focused: false };
  if (!resolveSpeedSettings(req.context).speed_mode || settings.reasoning_effort !== "medium"
      || !req.user_text || !req.message_id || req.user_attachments?.length || req.tool_results?.length) return normal;
  try {
    const receipt = recentCommandEvents(req.session_id, "conversation.intake", 64).find((value: any) => value?.message_id === req.message_id) as any;
    const decision = receipt?.accepted === true ? validateIntakeDecision(receipt.decision) : null;
    if (receipt?.request_sha256 !== createHash("sha256").update(req.user_text).digest("hex")
        || decision?.route !== "inspect" || decision.requested_effect !== "read" || decision.confidence < 0.85) return normal;
    return { settings: { ...settings, reasoning_effort: "low" as const }, focused: true,
      instruction: "This is a focused inspection question selected by conversational intake. Obtain the minimum sufficient fresh evidence and answer the complete question concisely. Preserve all task authority and verification requirements. For a bounded presence or identity question, select exact observed scalar facts from raw_payload for resultItems; incomplete inventory.* projections cannot establish a complete inventory or absence. Do not expand a presence question into a project-wide inventory. Put the answer and necessary uncertainty in assessment.overview (usually 1-3 sentences); use the low-priority finding to explain its evidence without repeating the overview. Broaden inspection when the evidence or the actual question requires it." };
  } catch { return normal; }
}
