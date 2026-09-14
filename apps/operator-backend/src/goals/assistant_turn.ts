import type { ChatRequest } from "../contracts.js";
import { classifyAgentTurn } from "../teammate_loop_runtime.js";

/** A side question may use conversation history, but never a saved task's authority. */
export function isIndependentAssistantTurn(req: Partial<ChatRequest>): boolean {
  if (req.assignment_id || req.assignment_run_id || req.assignment_generation !== undefined
    || (req.tool_results?.length ?? 0) > 0) return false;
  if (!req.user_text?.trim() || /^(?:please\s+)?(?:continue|resume|retry|try again|keep going|go on)\b/i.test(req.user_text.trim())) return false;
  return classifyAgentTurn(req.user_text, req.context) === "conversation";
}
