import type { ChatRequest } from "../contracts.js";
import type { UserInput } from "../codex/generated/app_server_0_149_0/v2/UserInput.js";
import { formatCodexRequestEnvelope } from "./codex_turn_profile.js";
import { formatToolResultsForCodex } from "./codex_tool_result_formatting.js";
import { buildCodexVisualInput } from "./codex_visual_input.js";

/** A continuation is a fresh observation boundary, even when user_text is empty. */
export async function buildCodexTurnInput(req: ChatRequest, contextBlocks: string[]): Promise<UserInput[]> {
  const visual = await buildCodexVisualInput(req);
  const userText = req.user_text?.trim();
  const blocks = [
    ...contextBlocks,
    formatCodexRequestEnvelope(req),
    userText ? `USER:\n${req.user_text}` : req.user_attachments?.length
      ? "USER supplied attachments without a new written instruction. Use the existing assignment if it establishes the requested work; otherwise inspect the attachments and ask what result is wanted before changing the model."
      : "Continue the existing assignment using the current observations. Reconcile any uncertain prior write before further changes; do not repeat it to obtain a cleaner response.",
    formatToolResultsForCodex(req.tool_results, { session_id: req.session_id, model_call_id: req.message_id }),
    visual.receipts.length ? `VISUAL INPUT COVERAGE:\n${JSON.stringify(visual.receipts)}\nOnly included images/pages have been supplied as pixels. Inspect deferred material using file tools before relying on it.` : ""
  ].filter(Boolean);
  return [{ type: "text", text: blocks.join("\n\n"), text_elements: [] }, ...visual.input];
}
