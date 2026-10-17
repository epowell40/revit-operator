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
 +'Perform the delegated scope under the existing native controls, then return its findings, exact change/check references and remaining actions as a plain subtask report. '
 +'At a handoff, use propose_completion to report the scoped findings or a focused input tool to propose a question. The host returns that unverified report to the desktop owner without completing the parent or asking its human yet. '
 +'The desktop owner must consume this result, perform any remaining UI work and inspect it before its final report. A missing helper tool is an owner handoff, not evidence that the human must enable it. '
 +'A subtask report is unverified and creates no completion, extra budget, write authority or exemption from Pause, missing inputs or unknown-effect reconciliation.';
