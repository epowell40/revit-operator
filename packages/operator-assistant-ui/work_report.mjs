// Claims are retained for review; this adapter never certifies a desktop effect.
export const WORK_REPORT_TOOL = {
  type: "function", name: "report_work_for_review",
  description: "After inspecting the result, retain a structured, explicitly unverified handoff for the current local advisory assignment. List concrete work performed, exact output paths or element IDs, remaining work and uncertainties. This does not verify completion, clear unknown effects, or authorize more work. Call only at the end of the task; do not repeat model or printer actions to obtain a cleaner report. Strict assignments reject this tool.",
  parameters: { type: "object", additionalProperties: false,
    properties: Object.fromEntries(["claimed_completed", "remaining_work", "uncertainties"].map(key => [key, { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } }])),
    required: ["claimed_completed", "remaining_work", "uncertainties"] }
};
export async function submitWorkReportForReview(assignment, proposal, request, options = {}) {
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
  // Host-owned preconditions cannot be supplied or overridden by proposal prose.
  if (options.beforePropose) await options.beforePropose();
  // The backend rechecks binding, policy, stop/unknown state and provider drain.
  // No automatic POST retry: an interrupted reply may already have been retained.
  return send({ action: "propose_completion", completion_proposal: proposal });
}

// Provider termination is not a report receipt. Read current host state before
// asking the owner to finish reporting; never replay a proposal or any work.
export async function missingWorkReportContinuation(assignment, request, reminderCount = 0) {
  if (assignment?.kernel_version !== 2) return null;
  if (!assignment.session_id || !assignment.goal_id || !assignment.run_id
      || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1)
    throw new Error("work_report_current_binding_required");
  if (!Number.isSafeInteger(reminderCount) || reminderCount < 0 || reminderCount > 2)
    throw new Error("work_report_reminder_count_invalid");
  const status = await request("/api/assignments/v2/work-plan", { method: "POST", body: JSON.stringify({
    action: "status", session_id: assignment.session_id, assignment_id: assignment.goal_id,
    run_id: assignment.run_id, generation: assignment.generation
  }) });
  if (status?.ok !== true) throw new Error("work_report_status_unavailable");
  if (status.verification_policy !== "advisory") return null;
  if (status.completion_proposal) {
    const message = retainedWorkReportMessage({ name: "report_work_for_review" }, { output: JSON.stringify(status) });
    if (!message) throw new Error("work_report_retained_receipt_invalid");
    return { kind: "retained", message };
  }
  if (status.outcome !== "active") return null;
  if (reminderCount === 2) throw new Error("work_report_required: No structured work report was retained after two reporting reminders. Preserve existing work and evidence; do not replay model actions.");
  return { kind: "continue", input: { role: "user", content: [{ type: "input_text", text:
    "Your text reply did not retain the required structured work report. The current host status has no accepted report. " +
    "Finish by calling report_work_for_review with inspected results, remaining work and uncertainties. This is a reporting step, not permission to repeat completed or uncertain model, save, print or external actions. " +
    "If an earlier report was rejected, it was not accepted: address its exact reason using retained evidence and the current checklist, then call report_work_for_review again. " +
    "Keep unverified claims and unresolved work explicit; do not manufacture verification, clear unknown effects, change grants or override Pause. Ordinary controls and the existing task budget still apply. " +
    "A plain-text reply cannot establish the saved assignment outcome."
  }] } };
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
  const summary = sections.filter(([,items]) => items.length).map(([title,items]) => {
    const label = title.replace(" (not independently verified)", "");
    const shown = []; let characters = 0;
    for (const item of items.slice(0,2)) {
      // Keep whole claims, including qualifications at their end. A long
      // first claim is retained in Details, never replaced by a shorter one.
      if (characters + item.length > 280) break;
      shown.push(item); characters += item.length;
    }
    if (!shown.length) return `${label}: ${items.length} ${items.length === 1 ? "item" : "items"} in Details.`;
    const omitted = items.length - shown.length;
    return `${label}: ${shown.join(" ")}${omitted ? ` (${omitted} more in Details.)` : ""}`;
  });
  return ["Work report saved for independent review (not independently verified).",
    ...(proposal.claimed_completed.length ? [] : ["No completed work was reported."]),
    ...summary, "Full handoff in Details below.", "## Details",
    ...sections.filter(([,items]) => items.length).map(([title,items]) =>
      `### ${title}\n\n` + items.map(item => "- " + item.replace(/\r?\n/g,"\n  ")).join("\n"))
  ].join("\n\n");
}

// Responsiveness is necessary for a desktop handoff, never sufficient proof
// of artifact delivery or model correctness. Capabilities alone are not idle.
export function assertDesktopHandoffNativeReady(health) {
  const context = health?.context;
  if (health?.ok !== true || !context || context.ok === false
      || context.readiness?.revit_launched !== true
      || !Number.isSafeInteger(context.process_id) || context.process_id <= 0) {
    throw new Error("desktop_handoff_native_readiness_unproven: Revit has not returned a fresh native context after desktop input. Inspect the current dialog or pending operation and reconcile it before ending this task. Do not resubmit the operation.");
  }
}
