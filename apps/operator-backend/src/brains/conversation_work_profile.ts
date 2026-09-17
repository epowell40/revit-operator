import type { ChatRequest } from "../contracts.js";
import { retainedIntakeDecision } from "../conversation_intake.js";
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
    const decision = retainedIntakeDecision({session_id:req.session_id,message_id:req.message_id,user_text:req.user_text});
    if (decision?.route !== "inspect" || decision.requested_effect !== "read") return normal;
    const evidenceInstruction = decision.read_evidence === "model_content"
      ? " Inspect actual model objects or systems with an appropriate native query, such as a scoped /revit/quantify or /revit/find-elements read. A filename, project number, view name, or other document label cannot establish discipline, system subtype or modeled contents. Do not infer 'controls model' or another subtype from labels. Use only distinctions supported by the inspected objects; if they do not settle the question, say what they do establish and the remaining uncertainty. The criterion requires model.content_observed."
      : decision.read_evidence === "complete_collection"
        ? " Obtain the exact requested collection total or complete set through its typed native query. For sheets, revit_list_sheets action=count returns the filtered total without loading every row. A partial page is not a complete enumeration; a returned authoritative total can establish the count. The criterion requires collection.complete and collection.total."
        : "";
    return { settings: { ...settings, reasoning_effort: "low" as const }, focused: true,
      instruction: "This is a focused inspection question selected by conversational intake. Obtain the minimum sufficient fresh evidence and answer the complete question concisely. Preserve all task authority and verification requirements. For a bounded presence or identity question, select exact observed scalar facts from raw_payload for resultItems; incomplete inventory.* projections cannot establish a complete inventory or absence. Do not expand a presence question into a project-wide inventory. Put the answer and necessary uncertainty in assessment.overview (usually 1-3 sentences); use the low-priority finding to explain its evidence without repeating the overview. Broaden inspection when the evidence or the actual question requires it." + evidenceInstruction };
  } catch { return normal; }
}
