// Claims are retained for review; this adapter never certifies a desktop effect.
export const WORK_REPORT_TOOL = {
  type: "function", name: "report_work_for_review",
  description: "After inspecting the result, retain a structured, explicitly unverified handoff for the current local advisory assignment. List concrete work performed, exact output paths or element IDs, remaining work and uncertainties. This does not verify completion, clear unknown effects, or authorize more work. Call only at the end of the task; do not repeat model or printer actions to obtain a cleaner report. Strict assignments reject this tool.",
  parameters: { type: "object", additionalProperties: false,
    properties: Object.fromEntries(["claimed_completed", "remaining_work", "uncertainties"].map(key => [key, { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } }])),
    required: ["claimed_completed", "remaining_work", "uncertainties"] }
};
export async function submitWorkReportForReview(assignment, proposal, request) {
  if (assignment?.kernel_version !== 2 || !assignment.session_id || !assignment.goal_id || !assignment.run_id
      || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1)
    throw new Error("work_report_current_binding_required");
  const keys = ["claimed_completed", "remaining_work", "uncertainties"];
  if (!proposal || Object.keys(proposal).some(key => !keys.includes(key))
      || !keys.every(key => Array.isArray(proposal[key]) && proposal[key].length <= 24
        && proposal[key].every(item => typeof item === "string" && item.trim() && item.length <= 1000))
      || !keys.some(key => proposal[key].length)) throw new Error("work_report_invalid");
  const binding = { session_id: assignment.session_id, assignment_id: assignment.goal_id,
    run_id: assignment.run_id, generation: assignment.generation };
  const send = body => request("/api/assignments/v2/work-plan", { method: "POST", body: JSON.stringify({ ...body, ...binding }) });
  const status = await send({ action: "status" });
  if (status?.verification_policy !== "advisory") throw new Error("work_report_advisory_policy_required");
  if (status.completion_proposal) throw new Error("work_report_already_retained");
  // The backend rechecks binding, policy, stop/unknown state and provider drain.
  // No automatic POST retry: an interrupted reply may already have been retained.
  return send({ action: "propose_completion", completion_proposal: proposal });
}

export function retainedWorkReportMessage(toolCall, functionOutput) {
  if (toolCall?.name !== "report_work_for_review") return null;
  let result; try { result = JSON.parse(functionOutput?.output || ""); } catch { return null; }
  const proposal = result?.completion_proposal;
  if (result?.ok !== true || result.verification_policy !== "advisory" || proposal?.verified !== false
      || typeof proposal.review_id !== "string" || !proposal.review_id) return null;
  const sections = [["Work reported (not independently verified)", proposal.claimed_completed],
    ["Remaining work", proposal.remaining_work], ["Uncertainties", proposal.uncertainties]];
  if (!sections.every(([,items]) => Array.isArray(items) && items.every(item => typeof item === "string"))) return null;
  return "Work report saved for independent review.\n\n" + sections.filter(([,items]) => items.length)
    .map(([title,items]) => title + ":\n" + items.map(item => "- " + item).join("\n")).join("\n\n");
}
