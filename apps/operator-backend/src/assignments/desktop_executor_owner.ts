import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {assignmentKernelV2ForBinding} from './assignment_kernel_v2_factory.js';

export function desktopHelperScopeFromContextV1(context:unknown):unknown {
 return context&&typeof context==='object'&&!Array.isArray(context)
  ?(context as Record<string,unknown>).desktop_helper_scope_v1:undefined;
}

/** Stored host provenance, not caller context, run prefixes or model prose. */
export function desktopExecutorOwnsAssignmentV2(snapshot:AssignmentSnapshotV2):boolean {
 const resolved=assignmentKernelV2ForBinding(snapshot.current_binding);
 if(!resolved)return false;
 const {goal}=resolved,budget=goal.work_budget;
 return goal.id===snapshot.current_binding.assignment_id&&goal.related_session_id===snapshot.current_binding.session_id
  &&budget?.mode==='sidecar_computer'&&budget.source==='operator_desktop'
  &&budget.execution_substrate==='operator_desktop_outer_agent'
  &&budget.source_user_request===snapshot.spec.source_user_request
  &&typeof budget.conversation_message_id==='string'&&!!budget.conversation_message_id
  &&budget.conversation_message_id===snapshot.spec.interpreted_scope?.source_message_id;
}

/** This marker only restricts a helper's report; it grants no execution rights. */
export function desktopHelperScopeForSnapshotV1(snapshot:AssignmentSnapshotV2,marker:unknown):boolean {
 const scope=marker as {schema?:string;binding?:Record<string,unknown>}|null;
 return scope?.schema==='operator.desktop-helper-scope.v1'
  &&['assignment_id','session_id','run_id','generation'].every(k=>scope.binding?.[k]===(snapshot.current_binding as unknown as Record<string,unknown>)[k])
  &&desktopExecutorOwnsAssignmentV2(snapshot);
}

export const DESKTOP_SCOPED_HELPER_GUIDANCE='You are a scoped backend helper for the current desktop-owned assignment. '
 +'Before the first edit, retain the required work plan for the full original user request, not merely the delegated native operation. A single-effect request can have one item. For composite work, keep requested relationships/formatting, output files and final inspection as distinct pending items even if only one element is edited. Do not close those items from the existence of a newly created element. Checklist declarations earn no extra resources. '
 +'Perform the delegated scope under the existing native controls, then return its findings, exact change/check references and remaining actions as a plain subtask report. '
 +'Plan model and schedule changes before final sheet annotations when dependencies permit; preserve explicit user ordering and review checkpoints. Refresh affected checks through actual supported reads, never by dropping an overlapping target or restoring obsolete values. '
 +'For spatial placement, inspect current rendered target content before committing a location. Use existing capture/image inspection or owner-visible evidence; native note inventories and aggregate titleblock bounds do not prove unused paper or clearance from internal text, linework or images. Resolve that placement prerequisite before treating the edit as ready; do not invent a location and defer its layout decision until after saving. Final owner review and correction remain required. '
 +'Group ready native edits, native verification and checkpoint save/file inspection before handoff; keep owner visual review pending. Honor explicit user review-before-save and all actual blocking checks. After new committed edits to an already saved, authorized non-workshared result, POST /revit/save-as supports the same authorized result path with overwrite=true. This is not an uncertain save retry: reconcile prior receipts first; never overwrite the input or an unrelated file. Inspect the exact saved artifact again. Do not assume a separate ordinary-save tool is exposed or claim this checkpoint completes visual review, preservation or unresolved design. '
 +'At a handoff, use propose_completion to report the scoped findings or a focused input tool to propose a question. The host returns that unverified report to the desktop owner without completing the parent or asking its human yet. '
 +'In completionProposal.user_facing_text, provide the concise final answer the human should read: requested written findings, the completed change/location, usable artifact reference, and actual unfinished requested work or meaningful limits. Do not put operation/evidence IDs, checklist administration, suggested owner instructions or resolved tool errors in that text; retain those in the technical claimed_completed/remaining_work/uncertainties lists and evidence. Those lists remain required. Return this report even if native edit/save checks have already completed the checklist. Successful native completion does not deliver requested writing for you. The user-facing text remains unverified prose, separate from native facts; it cannot certify design, supply user input, hide actual unfinished design or override a stop. '
 +'The desktop owner must consume this result, review requested informational writing, perform any remaining UI work and inspect it before its final report. For requested written follow-ups, keep final inspection pending until the owner has retained its reviewed answer through report_work_for_review written_findings with empty claim arrays. That writing receipt cannot complete the checklist or verify native work; do not close the task first and discard the requested answer. A missing helper tool is an owner handoff, not evidence that the human must enable it. '
 +'For appearance or layout changes, leave the final inspection checklist item pending until the desktop owner has checked the affected sheet/view or schedule with review_current_work. Native attribute/read-coverage checks alone do not establish readable drawing appearance. Return the verified edits and target-view references using the scoped propose_completion handoff before closing that last inspection. The owner can inspect, correct a confirmed discrepancy, recheck, and delegate the remaining native inspection closeout afterward. Do not ask the human to supply your visual check, repeat completed edits, or claim an unavailable visual check passed. Parameter-only work can use native readback without pixels. '
 +'A subtask report is unverified and creates no completion, extra budget, write authority or exemption from Pause, missing inputs or unknown-effect reconciliation.';
