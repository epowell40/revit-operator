import {nativeReadinessHealthDetail} from './native_readiness_diagnostic.mjs';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';
// Claims are retained for review; this adapter never certifies a desktop effect.
export const WORK_REPORT_TOOL = {
  type: "function", name: "report_work_for_review",
  description: "Retain an explicitly unverified advisory handoff after the requested work and inspection, or a genuine stop. For a persistent task with unfinished work and available budget, retain one useful next work item or a specific supported blocker in the existing work plan and continue ready work; no exhaustive upfront inventory is required. A progress update is not a final handoff. For advisory assignments, optional written_findings is the user-facing body of that final report; keep unfinished work and uncertainties explicit in the claim arrays. Strict assignments reject completion claims. For a strict task's requested written follow-up, the owner may supply written_findings with all three claim arrays empty, after reviewing helper material and before final inspection. That strict writing-only receipt does not complete any checklist, verify effects, or end the task. Do not copy unreviewed helper prose or repeat completed actions.",
  parameters: { type: "object", additionalProperties: false,
    properties: { ...Object.fromEntries(["claimed_completed", "remaining_work", "uncertainties"].map(key => [key, { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } }])), written_findings: {type:"string",minLength:1,maxLength:8000} },
    required: ["claimed_completed", "remaining_work", "uncertainties"] }
};
export async function submitWorkReportForReview(assignment, proposal, request, options = {}) {
  if (assignment?.kernel_version !== 2 || !assignment.session_id || !assignment.goal_id || !assignment.run_id
      || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1)
    throw new Error("work_report_current_binding_required");
  const keys = ["claimed_completed", "remaining_work", "uncertainties"];
  const writing = typeof proposal?.written_findings === 'string' && proposal.written_findings.trim() && proposal.written_findings.length <= 8000;
  if (!proposal || Object.keys(proposal).some(key => ![...keys,'written_findings'].includes(key))
      || !keys.every(key => Array.isArray(proposal[key]) && proposal[key].length <= 24
        && proposal[key].every(item => typeof item === "string" && item.trim() && item.length <= 1000))
      || (!keys.some(key => proposal[key].length) && !writing)
      || ('written_findings' in proposal && !writing)) throw new Error("work_report_invalid");
  const binding = { session_id: assignment.session_id, assignment_id: assignment.goal_id,
    run_id: assignment.run_id, generation: assignment.generation };
  const send = body => request("/api/assignments/v2/work-plan", { method: "POST", body: JSON.stringify({ ...body, ...binding }) });
  const status = await send({ action: "status" });
  if ('written_findings' in proposal && status?.verification_policy === 'strict') {
    if (status?.ok !== true || status.outcome !== 'active'
        || status.completion_proposal || keys.some(key=>proposal[key].length)
        || typeof options.retainWrittenFindings !== 'function') throw new Error('written_findings_owner_retention_required');
    // The host callback rechecks current controls and retains actual owner input.
    // No propose_completion, native operation, or automatic checklist transition.
    return options.retainWrittenFindings(binding, proposal.written_findings.trim());
  }
  if (status?.verification_policy !== "advisory") throw new Error("work_report_advisory_policy_required");
  if (status.completion_proposal) throw new Error("work_report_already_retained");
  if (writing && (status.ok !== true || status.outcome !== 'active')) throw new Error('work_report_active_status_required');
  // Advisory prose uses the existing canonical proposal body. It is still an
  // unverified claim, not the strict writing-only retention path or native proof.
  const {written_findings, ...claims} = proposal;
  const completionProposal = writing ? {...claims, user_facing_text: written_findings.trim()} : proposal;
  // Host-owned preconditions cannot be supplied or overridden by proposal prose.
  if (options.beforePropose) await options.beforePropose();
  // The backend rechecks binding, policy, stop/unknown state and provider drain.
  // No automatic POST retry: an interrupted reply may already have been retained.
  return send({ action: "propose_completion", completion_proposal: completionProposal });
}

// Provider termination is not a report receipt. Read current host state before
// asking the owner to finish reporting; never replay a proposal or any work.
// The existing owner also consumes retained navigation-stall feedback at a
// completed tool boundary. This is not a new executor or an execution grant.
export function retainedRetrievalStallContinuation(assignment, retained) {
  const feedback=retained?.retrieval_feedback, continuation=retained?.execution_continuation;
  if(!feedback||retained.status!=='retained'||assignment?.kernel_version!==2)return null;
  if(continuation?.schema!=='operator.execution-continuation.v1'
    ||continuation.binding?.assignment_id!==(assignment.goal_id??assignment.assignment_id)
    ||!['session_id','run_id','generation'].every(k=>continuation.binding?.[k]===assignment[k]))
    throw Error('execution_continuation_binding_mismatch');
  // Pause, pending effects/usage, reviews, input, ordinary non-drafting work
  // and terminal state keep their existing control paths. No extra model call.
  if(continuation.state!=='ready')return null;
  if(!/^ev1_[A-Za-z0-9_-]{32}$/.test(feedback.evidence_id)||![1,2,3,4].includes(feedback.failures)
    ||feedback.state!==(feedback.failures===4?'stalled':feedback.failures>=2?'change_approach':'observing'))
    throw Error('execution_continuation_retrieval_feedback_invalid');
  if(feedback.state==='observing')return null;
  if(feedback.state==='stalled')throw Error(`drafting_no_progress: Four failed selections of ${feedback.evidence_id} without a successful read. Preserved task/work/evidence require a different retrieval approach; no automatic retry or completion claim.`);
  return {role:'user',content:[{type:'input_text',text:
    `Repeated evidence navigation failure: ${feedback.failures} rejected selections of ${feedback.evidence_id}. Change approach now. `+
    'Use the actual retained path/type hints and narrow leaf fields or nested array pages; do not guess the same wrapper or request the same oversized object. '+
    'A successful read of this artifact clears this navigation stall. If it is not needed, continue another useful discrepancy using current evidence. '+
    'Keep checked partial work and save a useful verified milestone when applicable. Do not repeat mutations, invent missing values, mark work complete, or override Pause/unknown effects. Four failures without a successful read stop this loop.'}]};
}

export async function missingWorkReportContinuation(assignment, request, reminderCount = 0, progress = {}) {
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
  const continuation=status.execution_continuation;
  if(continuation) {
    if(continuation.schema!=='operator.execution-continuation.v1'
      ||continuation.binding?.assignment_id!==assignment.goal_id
      ||!['session_id','run_id','generation'].every(k=>continuation.binding?.[k]===assignment[k]))
      throw Error('execution_continuation_binding_mismatch');
    if(continuation.state==='ready'&&status.outcome==='active'&&!status.completion_proposal) {
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(continuation.progress_key)||!Array.isArray(continuation.next_items)
        ||!continuation.next_items.length||continuation.next_items.length>8
        ||!continuation.next_items.every(i=>typeof i==='string'&&/^[a-z][a-z0-9_-]{0,79}$/.test(i)))
        throw Error('execution_continuation_invalid');
      progress.repeats=progress.signature===continuation.progress_key?(progress.repeats??0)+1:0;
      progress.signature=continuation.progress_key;
      if(progress.repeats>=2)throw Error('drafting_no_progress: Three response endings retained no new work or checkoff. Preserve the saved partial and identify the specific unresolved discrepancy or tool failure; no automatic retry.');
      return {kind:'continue_work',input:{role:'user',content:[{type:'input_text',text:
        'The drafting assignment remains active. This response ending did not complete it. Continue the next useful discrepancy in '
        +continuation.next_items.join(', ')+'. Compare a readable reference crop with a fresh corresponding Revit region, retaining whole-sheet context. '
        +'Use the saved source-linked work records, current elements and prior readbacks; do not repeat successful or uncertain construction. '
        +'Perform a manageable connected branch/area or property/annotation pass, inspect the actual result, record drafted versus checked work and the next useful action, then continue. '
        +'Do not submit a final review merely to end a response. If genuinely blocked, record the specific blocker and continue independent work. '
        +'Budget, Pause, pending effects and required review remain binding. Never claim a checked or complete drawing from successful code execution alone.'
        +(progress.repeats?' The previous response also ended without new work/checkoff. Change approach now; repeated inspection or reporting is not progress.':'')} ]}};
    }
    if(continuation.state!=='ready'&&!['ordinary_task_reporting','no_ready_work'].includes(continuation.reason))return null;
  }
  if (status.verification_policy !== "advisory") {
    if(status.verification_policy!=='strict'||status.outcome!=='active')return null;
    if(reminderCount===2)throw Error('task_outcome_required: No canonical outcome or question was retained. Preserve completed work and evidence; do not replay actions.');
    return {kind:'continue',input:{role:'user',content:[{type:'input_text',text:
      'The saved task is still active; your plain-text answer did not retain an outcome. If required information is missing, call request_task_input to save the focused question. '
      +CANONICAL_NATIVE_TASK_GUIDANCE+' Strict tasks cannot use report_work_for_review to bypass their evidence requirements. '
      +'Use retained results; do not repeat completed or uncertain model, save, print or external actions, change grants, clear unknown effects or override Pause.'}]}};
  }
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

// Native control can stop before the ordinary report tool's presentation path.
// Read the current host-bound receipt rather than trusting projected tool text
// (which may be partial) or submitting another proposal. This is presentation
// only: the normal outer settlement still owns status, Pause and unknown effects.
export async function nativeStoppedWorkReportMessage(assignment, toolCall, functionOutput, request) {
  if (toolCall?.name !== 'native__operator_manage_work_plan'
      || functionOutput?.native_stop_reason !== 'advisory_completion_proposed'
      || assignment?.kernel_version !== 2 || !assignment.session_id || !assignment.goal_id || !assignment.run_id
      || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1) return null;
  try {
    if (JSON.parse(functionOutput.output)?.ok !== true) return null;
    const status = await request('/api/assignments/v2/work-plan', {method:'POST',body:JSON.stringify({
      action:'status',session_id:assignment.session_id,assignment_id:assignment.goal_id,
      run_id:assignment.run_id,generation:assignment.generation
    })});
    if (status?.outcome !== 'awaiting_user_review') return null;
    return retainedWorkReportMessage({name:'report_work_for_review'}, {output:JSON.stringify(status)});
  } catch {
    // A lost/stale read leaves the normal canonical stop presentation intact.
    // Do not retry, execute more work or turn missing presentation into success.
    return null;
  }
}

export function retainedWorkReportMessage(toolCall, functionOutput) {
  if (toolCall?.name !== "report_work_for_review") return null;
  let result; try { result = JSON.parse(functionOutput?.output || ""); } catch { return null; }
  const proposal = result?.completion_proposal;
  if (result?.ok !== true || result.verification_policy !== "advisory" || proposal?.verified !== false
      || typeof proposal.review_id !== "string" || !proposal.review_id) return null;
  const answer = proposal.user_facing_text;
  if (answer !== undefined && (typeof answer !== 'string' || !answer.trim() || answer.length > 8000)) return null;
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
    // This is the retained owner's answer, not a new verification claim. Keep
    // its complete qualifications and numbers visible above collapsed Details.
    ...(answer === undefined ? [] : ["### Reported result (not independently verified)\n\n" + answer]),
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
    throw new Error("desktop_handoff_native_readiness_unproven: Revit has not returned a fresh native context after desktop input. Inspect the current dialog or pending operation and reconcile it before ending this task. Do not resubmit the operation." + nativeReadinessHealthDetail(health));
  }
}

// Presentation-only owner records. Deserialized/helper objects never become
// reviewed writing merely by copying this shape. The host retains the actual
// owner tool input in its existing function journal; native outcome is separate.
const ownerWritingRecords = new WeakSet();
const writingBinding=(a,b)=>['assignment_id','session_id','run_id','generation'].every(k=>a?.[k]!==undefined&&a[k]===b?.[k]);
const writingControl=s=>JSON.stringify(s.execution_control??null);
const writingInvalidations=s=>JSON.stringify(s.input_invalidated_operation_ids??[]);
const writingApplies=s=>JSON.stringify(Object.entries(s.operations??{}).filter(([,o])=>o.requested_effect==='apply').map(([id,o])=>[id,o.status,o.persistent_effect,o.result?.completed_at]).sort((a,b)=>a[0].localeCompare(b[0])));
function writingReady(s,binding) {
  return s && writingBinding(s.current_binding,binding) && Number.isSafeInteger(s.assignment_version) && s.assignment_version>0
    && s.quiescent===true && s.execution_control?.state!=='paused' && !s.provider_usage_hold && !s.completion_proposal
    && ['in_flight_operation_ids','in_flight_provider_call_ids','unresolved_unknown_operation_ids','pending_input_variable_ids','pending_review_ids','execution_failure_ids']
      .every(k=>Array.isArray(s[k])&&s[k].length===0)
    && Object.values(s.operations??{}).every(o=>o.requested_effect!=='apply'||(o.persistent_effect!=='unknown'&&Number.isFinite(Date.parse(o.result?.completed_at))));
}
export function retainOwnerWrittenFindings(binding,text,snapshot) {
  if(typeof text!=='string'||!text.trim()||text.length>8000||!writingReady(snapshot,binding)
    ||snapshot.terminal||snapshot.outcome!=='active')throw Error('written_findings_current_owner_required');
  const record=Object.freeze({binding:Object.freeze({...binding}),text:text.trim(),version:snapshot.assignment_version,
    control:writingControl(snapshot),applies:writingApplies(snapshot),invalidations:writingInvalidations(snapshot)});
  ownerWritingRecords.add(record);return record;
}
export function ownerWrittenFindingsReceipt(record) {
  if(!ownerWritingRecords.has(record))throw Error('written_findings_owner_record_required');
  return {ok:true,written_findings:record.text,authority:'owner_authored_informational_text',
    native_postcondition_verified:false,whole_task_verified:false,
    guidance:'Written follow-up retained. Continue required native verification, inspection and delivery; this receipt does not end the task.'};
}
export function ownerWrittenFindingsMessage(record,binding,snapshot) {
  if(!record||!ownerWritingRecords.has(record)||!writingBinding(record.binding,binding)||!writingReady(snapshot,binding)
    ||!snapshot.terminal||!['complete','complete_with_issues','verified_noop','blocked'].includes(snapshot.outcome)
    ||snapshot.assignment_version<record.version||writingControl(snapshot)!==record.control||writingApplies(snapshot)!==record.applies
    ||writingInvalidations(snapshot)!==record.invalidations)return '';
  return 'Requested written follow-up (owner-authored; not native verification or an approved design):\n\n'+record.text;
}
