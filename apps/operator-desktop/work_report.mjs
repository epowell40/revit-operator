import {nativeReadinessHealthDetail} from './native_readiness_diagnostic.mjs';
import {CANONICAL_NATIVE_TASK_GUIDANCE,UNIFIED_NATIVE_COMPLETION_GUIDANCE} from './native_task_routing.mjs';
// Claims are retained for review; this adapter never certifies a desktop effect.
export const WORK_REPORT_TOOL = {
  type: "function", name: "report_work_for_review", strict: false,
  description: "Retain an explicitly unverified advisory handoff after the requested work and inspection, or a genuine stop. Continue useful ready work while it fits the authorized budget. Honor declared ready work items. A work plan is optional: do not create a checklist solely to return a partial report. Retain specific remaining work and uncertainties in this report; they remain unresolved and the report is not task completion. Omit needs_input when no user decision is needed; uncertainties can be reported without asking a question. When the remaining work depends on a real user decision, include needs_input with the question and a stable field name in this same report. Return the useful checked work, saved file and specific ambiguity together. Do not create a plan just to ask or draw a substitute for an unresolved design decision. A progress update is not a final handoff. For advisory assignments, optional written_findings is the user-facing body of that final report; keep unfinished work and uncertainties explicit in the claim arrays. Strict assignments reject completion claims. For a strict task's requested written follow-up, the owner may supply written_findings with all three claim arrays empty, after reviewing helper material and before final inspection. That strict writing-only receipt does not complete any checklist, verify effects, or end the task. Do not copy unreviewed helper prose or repeat completed actions.",
  parameters: { type: "object", additionalProperties: false,
    properties: { needs_input:{type:"object",additionalProperties:false,required:["question","field"],properties:{question:{type:"string",minLength:1,maxLength:1200},field:{type:"string",pattern:"^[a-z][a-z0-9_]{0,63}$"}}}, ...Object.fromEntries(["claimed_completed", "remaining_work", "uncertainties"].map(key => [key, { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } }])), written_findings: {type:"string",minLength:1,maxLength:8000} },
    required: ["claimed_completed", "remaining_work", "uncertainties"] }
};
export async function submitWorkReportForReview(assignment, proposal, request, options = {}) {
  if (assignment?.kernel_version !== 2 || !assignment.session_id || !assignment.goal_id || !assignment.run_id
      || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1)
    throw new Error("work_report_current_binding_required");
  const keys = ["claimed_completed", "remaining_work", "uncertainties"];
  const writing = typeof proposal?.written_findings === 'string' && proposal.written_findings.trim() && proposal.written_findings.length <= 8000;
  if (!proposal || Object.keys(proposal).some(key => ![...keys,'written_findings','needs_input'].includes(key))
      || !keys.every(key => Array.isArray(proposal[key]) && proposal[key].length <= 24
        && proposal[key].every(item => typeof item === "string" && item.trim() && item.length <= 1000))
      || (!keys.some(key => proposal[key].length) && !writing)
      || ('written_findings' in proposal && !writing)) throw new Error("work_report_invalid");
  const binding = { session_id: assignment.session_id, assignment_id: assignment.goal_id,
    run_id: assignment.run_id, generation: assignment.generation };
  const send = body => request("/api/assignments/v2/work-plan", { method: "POST", body: JSON.stringify({ ...body, ...binding }) });
  const status = await send({ action: "status" });
  if ('needs_input' in proposal) {
    const decision = proposal.needs_input;
    if (status?.verification_policy !== 'advisory' || status.ok !== true || status.outcome !== 'active' || status.completion_proposal || typeof options.requestInput !== 'function') throw new Error('partial_input_active_advisory_required');
    if (!decision || Object.keys(decision).some(key => !['field','question'].includes(key))) throw new Error('partial_input_decision_invalid');
    const sections = [[null, proposal.claimed_completed], ['Remaining work', proposal.remaining_work], ['Uncertainties', proposal.uncertainties]];
    const summary = [proposal.written_findings?.trim(), ...sections.filter(([,items]) => items.length).map(([label,items]) => (label ? label+'\n' : '')+items.join('\n'))].filter(Boolean).join('\n\n');
    if (summary.length > 4000) throw new Error('partial_input_summary_too_long: summarize the checked result and remaining decision in 4000 characters.');
    if (options.beforePropose) await options.beforePropose();
    return options.requestInput({...decision, work_summary:summary});
  }
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

/** Consume the existing canonical progress clock at a completed tool boundary.
 * Successful read-only activity cannot bypass this pacing check. */
export function retainedDraftingProgressContinuation(assignment, retained, tracker) {
  const continuation=retained?.execution_continuation;
  if(retained?.status!=='retained'||assignment?.kernel_version!==2||!continuation)return null;
  if(continuation.schema!=='operator.execution-continuation.v1'
    ||continuation.binding?.assignment_id!==(assignment.goal_id??assignment.assignment_id)
    ||!['session_id','run_id','generation'].every(key=>continuation.binding?.[key]===assignment[key]))
    throw Error('execution_continuation_binding_mismatch');
  const noPlanAdvice=continuation.state==='hold'&&continuation.reason==='no_ready_work'&&continuation.resource_advice_only===true;
  if(continuation.state!=='ready'&&!noPlanAdvice)return null;
  const progress=continuation.construction_progress;
  if(!progress)return null;
  const calls=progress.calls_since_construction,warn=progress.warn_after,change=progress.stop_after;
  if(!Number.isSafeInteger(calls)||calls<0||!Number.isFinite(Date.parse(progress.since))
    ||!Number.isSafeInteger(warn)||warn<1||!Number.isSafeInteger(change)||change<=warn)
    throw Error('execution_continuation_progress_invalid');
  const window=progress.since;
  const stage=calls>=change?2:calls>=warn?1:0;
  if(stage<1)return null;
  if(tracker.window===window&&stage<=tracker.stage)return null;
  tracker.window=window;
  tracker.stage=stage;
  // The domain publishes pacing advice, not another call allowance. Distinct
  // useful inspections must not become a runtime failure at an arbitrary count.
  // Existing repeated-cycle, retrieval, resource and control paths still apply.
  return {role:'user',content:[{type:'input_text',text:
    'You have used '+calls+' model calls since new construction or native checked-target progress. '+
    'Choose one concrete remaining discrepancy now. Finish a supported annotation/property pass or another ready branch when a connection is blocked. '+
    'Record the specific blocked pass and continue independent work. Reuse the paired reference/model area and current readbacks. '+
    'If the next discrepancy is unclear after a construction pass, use area_backcheck with the current paired area before broader discovery; reuse an existing current review rather than requesting it again. Further inspection must answer a named missing fact needed for a specific repair. After a useful repair, check and save it before a separate uncertain investigation. Repeated successful inspections, reviews and saves do not reset this progress clock. '+
    (stage>=2?'If the bounded alternative cannot make progress, preserve an authorized useful milestone and report the checked partial with the exact blocker. ':'')+
    'This changes no budget, native admission, Pause or unknown-effect requirement.'}]};
}

/** Use the already-returned host meter; never fetch another status or create
 * another resource policy. Repeated tool calls do not spam the same warning. */
export function retainedExecutionReserveContinuation(assignment, retained, tracker) {
  const c=retained?.execution_continuation;
  if(retained?.status!=='retained'||assignment?.kernel_version!==2||!c)return null;
  if(c.schema!=='operator.execution-continuation.v1'
    ||c.binding?.assignment_id!==(assignment.goal_id??assignment.assignment_id)
    ||!['session_id','run_id','generation'].every(k=>c.binding?.[k]===assignment[k]))
    throw Error('execution_continuation_binding_mismatch');
  const resourceOnly=c.state==='hold'&&c.resource_advice_only===true
    &&['no_ready_work','ordinary_task_reporting'].includes(c.reason);
  if((c.state!=='ready'&&!resourceOnly)||c.checkpoint_recommended!==true||!c.remaining_resources)return null;
  const meters={};
  for(const key of ['provider_calls','total_tokens','operations','active_execution_ms']) {
    const m=c.remaining_resources[key];if(!m)continue;
    if(!Number.isSafeInteger(m.limit)||m.limit<0
      ||!(m.used===null&&m.remaining===null||Number.isSafeInteger(m.used)&&m.used>=0
        &&Number.isSafeInteger(m.remaining)&&m.remaining===Math.max(0,m.limit-m.used)))
      throw Error('execution_continuation_reserve_invalid');
    meters[key]=m;
  }
  if(!Object.values(meters).some(m=>m.remaining!==null))return null;
  const runway=c.token_runway;
  if(runway!=null&&(runway.basis!=='largest_of_last_eight_completed_calls'||runway.advisory_only!==true
    ||!Number.isSafeInteger(runway.sample_count)||runway.sample_count<1||runway.sample_count>8
    ||!Number.isSafeInteger(runway.tokens_per_call)||runway.tokens_per_call<1
    ||!Number.isSafeInteger(runway.estimated_calls_remaining)||runway.estimated_calls_remaining<0
    ||meters.total_tokens?.remaining==null
    ||runway.estimated_calls_remaining!==Math.floor(meters.total_tokens.remaining/runway.tokens_per_call)))
    throw Error('execution_continuation_reserve_invalid');
  const near=(key,n)=>meters[key]?.remaining!=null&&meters[key].remaining<=n;
  const urgentTokens=runway!=null&&runway.estimated_calls_remaining<=2;
  const stage=near('active_execution_ms',30000)||near('provider_calls',1)||urgentTokens?2:1;
  const window=JSON.stringify(Object.entries(meters).map(([key,m])=>[key,m.limit]));
  if(tracker.window===window&&tracker.stage>=stage)return null;
  tracker.window=window;tracker.stage=stage;
  const remaining=Object.fromEntries(Object.entries(meters).map(([key,m])=>[key,m.remaining]));
  return {role:'user',content:[{type:'input_text',text:
    'Host checkpoint warning: current remaining allocation '+JSON.stringify(remaining)+'. '+
    'These are cumulative task resources, not a fresh allowance for this response. '+
    (runway?'At recent context sizes, about '+runway.estimated_calls_remaining+' more calls fit the token reserve (estimate, not a guarantee; based on the largest of the last '+runway.sample_count+' completed calls, including cached tokens). ':'')+
    (urgentTokens?'The token reserve is nearly exhausted. Do not start another area or optional review. Prioritize focused readback of any unsaved work, an authorized useful save if needed, and an honest partial handoff using retained evidence. Do not repeat checks already supported by current evidence merely to polish the report. ':'')+
    'Before starting more drafting, leave enough for focused readback, any authorized save of useful work, and an honest partial handoff. '+
    'If that does not fit, preserve and report the current work and specific remaining items instead of beginning another batch. '+
    'A save is not verification; never call unsaved changes saved. This warning grants no extra calls, time, native permission or completion and does not override Pause or unknown effects.'}]};
}

export async function missingWorkReportContinuation(assignment, request, reminderCount = 0, progress = {}, options = {}) {
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
      +(options.unifiedNative === true ? UNIFIED_NATIVE_COMPLETION_GUIDANCE : CANONICAL_NATIVE_TASK_GUIDANCE)+' Strict tasks cannot use report_work_for_review to bypass their evidence requirements. '
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
function writingReady(s,binding,allowRecordedFailure=false) {
  return s && writingBinding(s.current_binding,binding) && Number.isSafeInteger(s.assignment_version) && s.assignment_version>0
    && s.quiescent===true && s.execution_control?.state!=='paused' && !s.provider_usage_hold && !s.completion_proposal
    && ['in_flight_operation_ids','in_flight_provider_call_ids','unresolved_unknown_operation_ids','pending_input_variable_ids','pending_review_ids']
      .every(k=>Array.isArray(s[k])&&s[k].length===0)
    && Array.isArray(s.execution_failure_ids) && (allowRecordedFailure || s.execution_failure_ids.length===0)
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
function readDraftAfterMissingOutcome(snapshot,binding,failureMessage) {
  if (typeof failureMessage !== 'string' || !failureMessage.startsWith('task_outcome_required:') || snapshot?.outcome !== 'failed' ||
      snapshot.spec?.requested_effect !== 'read' || snapshot.terminal_reason !== 'assignment_runtime_failed' ||
      snapshot.result_delivery || snapshot.execution_failure_ids?.length !== 1 ||
      !Object.values(snapshot.operations ?? {}).every(operation =>
        operation.requested_effect === 'read' && operation.persistent_effect === 'none')) return false;
  const failure = snapshot.execution_failures?.[snapshot.execution_failure_ids[0]];
  return writingBinding(failure?.binding,binding) && failure.code === 'assignment_runtime_failed' &&
    failure.error_class === 'runtime' && failure.phase === 'provider_turn';
}

export function ownerWrittenFindingsMessage(record,binding,snapshot,failureMessage) {
  const draft=readDraftAfterMissingOutcome(snapshot,binding,failureMessage);
  if(!record||!ownerWritingRecords.has(record)||!writingBinding(record.binding,binding)||!writingReady(snapshot,binding,draft)
    ||!snapshot.terminal||(!draft&&!['complete','complete_with_issues','verified_noop','blocked'].includes(snapshot.outcome))
    ||snapshot.assignment_version<record.version||writingControl(snapshot)!==record.control||writingApplies(snapshot)!==record.applies
    ||writingInvalidations(snapshot)!==record.invalidations)return '';
  if(draft)return 'Unverified draft findings from this run. The task ended before completion.\n\n'+record.text;
  return 'Requested written follow-up (owner-authored; not native verification or an approved design):\n\n'+record.text;
}
