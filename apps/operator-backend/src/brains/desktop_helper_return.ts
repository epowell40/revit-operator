import {createHash} from 'node:crypto';
import type {AssignmentBindingV2,AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2,canonicalJsonV2} from '../domain/assignment-kernel/index.js';
import {validAdvisoryProposalV1} from '../domain/assignment-kernel/execution_policy.js';
import {getAssignmentKernelSnapshotV2} from '../assignments/assignment_kernel_v2_store.js';
import {desktopHelperScopeForSnapshotV1} from '../assignments/desktop_executor_owner.js';
import {storeEvidence} from '../evidence/evidence_store.js';
import type {ChatResponse} from '../contracts.js';

export const DESKTOP_HELPER_RETURN_REASON='desktop_scoped_helper_return';
type Report={kind:'scope_report'|'proposed_question';claimed_completed:string[];remaining_work:string[];uncertainties:string[];question?:string};
export type DesktopHelperReturnV1=NonNullable<ChatResponse['desktop_helper_return']>;
const pending=new WeakMap<object,Map<string,DesktopHelperReturnV1>>();
// Only an actual consumed in-process return can stop the inner runner. A
// caller-supplied lookalike DTO or stale serialized response cannot do so.
const consumedReturns=new WeakSet<object>();
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,240}$/.test(value);
const strings=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==='string'&&s.trim()&&s.length<=1000);
function normalize(tool:string,args:Record<string,unknown>):Report|null{
 if(tool==='host_desktop_helper_call_yield'){
  const p=args.report as any;if(!validAdvisoryProposalV1(p))throw Error('desktop_helper_budget_report_invalid');
  return {kind:'scope_report',claimed_completed:[...p.claimed_completed],remaining_work:[...p.remaining_work],uncertainties:[...p.uncertainties]};
 }
 if(tool==='operator_manage_work_plan'&&args.action==='propose_completion'){
  const p=args.completionProposal as any;if(!validAdvisoryProposalV1(p))throw Error('desktop_helper_report_invalid');
  return {kind:'scope_report',claimed_completed:[...p.claimed_completed],remaining_work:[...p.remaining_work],uncertainties:[...p.uncertainties]};
 }
 if(!['operator_request_assignment_input','operator_request_clarification'].includes(tool))return null;
 if(typeof args.question!=='string'||!args.question.trim()||args.question.length>1200
   ||args.completedWork!==undefined&&!strings(args.completedWork,80))throw Error('desktop_helper_question_invalid');
 return {kind:'proposed_question',claimed_completed:(args.completedWork as string[]|undefined)??[],remaining_work:[],uncertainties:[],question:args.question};
}
export function isDesktopHelperReturnRequestV1(tool:string,args:Record<string,unknown>):boolean{
 try{return tool!=='host_desktop_helper_call_yield'&&normalize(tool,args)!==null;}catch{return false;}
}
export function peekDesktopHelperReturnV1(owner:object,turnId:unknown):DesktopHelperReturnV1|null{
 const r=typeof turnId==='string'?pending.get(owner)?.get(turnId):undefined;return r?structuredClone(r):null;
}
/** Retains helper prose as untrusted evidence. No kernel input/review/completion
 * event, approval, native fact or allowance is created by this return. */
export function retainDesktopHelperReturnV1(input:{owner:object;turn_id:unknown;binding:AssignmentBindingV2;marker:unknown;tool:string;arguments:Record<string,unknown>}):DesktopHelperReturnV1|null{
 const snapshot=getAssignmentKernelSnapshotV2(input.binding.assignment_id);
 if(!snapshot||!sameAssignmentBindingV2(snapshot.current_binding,input.binding)
   ||!desktopHelperScopeForSnapshotV1(snapshot,input.marker))return null;
 const report=normalize(input.tool,input.arguments);if(!report)return null;
 if(!id(input.turn_id))throw Error('desktop_helper_turn_invalid');
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.execution_control?.state==='paused'
   ||snapshot.completion_proposal||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted||snapshot.progress_blocker
   ||snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length||snapshot.unresolved_unknown_operation_ids.length)
  throw Error('desktop_helper_return_blocked_by_parent');
 const raw={schema:'operator.desktop-helper-report.v1',binding:snapshot.current_binding,turn_id:input.turn_id,
   source_tool:input.tool,request:input.arguments,report,verified:false};
 const json=canonicalJsonV2(raw);if(Buffer.byteLength(json)>256000)throw Error('desktop_helper_report_too_large');
 const hash=createHash('sha256').update(json).digest('hex'),existing=pending.get(input.owner)?.get(input.turn_id);
 if(existing){if(existing.request_hash===hash)return structuredClone(existing);throw Error('desktop_helper_return_already_retained');}
 const registry=pending.get(input.owner)??new Map();if(registry.size>=64)throw Error('desktop_helper_return_registry_full');
 const evidence=storeEvidence({scope:{session_id:input.binding.session_id,assignment_id:input.binding.assignment_id,
   run_id:input.binding.run_id,generation:input.binding.generation,attempt_id:'helper:'+input.turn_id},source:'operator.desktop-helper-report',
   trust_level:'untrusted_caller',verification_relevance:'supporting',bounded_summary:'Unverified scoped helper findings for its desktop owner.',raw});
 const result:DesktopHelperReturnV1={schema:'operator.desktop-helper-return.v1',binding:structuredClone(input.binding),turn_id:input.turn_id,
   source_tool:input.tool,request_hash:hash,control_command_id:snapshot.execution_control?.command_id??null,report,
   evidence_ref:evidence.ref,verified:false};
 registry.set(input.turn_id,structuredClone(result));pending.set(input.owner,registry);return structuredClone(result);
}
/** Called during provider cleanup even on failure; the private artifact remains. */
export function takeDesktopHelperReturnV1(owner:object,turnId:unknown):DesktopHelperReturnV1|null{
 const result=peekDesktopHelperReturnV1(owner,turnId);if(typeof turnId==='string')pending.get(owner)?.delete(turnId);
 if(result)consumedReturns.add(result);return result;
}
export function desktopHelperReturnMessageV1(result:DesktopHelperReturnV1):string{
 const r=result.report,all=[...r.claimed_completed,...r.remaining_work,...r.uncertainties];
 const inline=JSON.stringify(r).length<=12000?r:{kind:r.kind,question:r.question,claimed_completed:r.claimed_completed.slice(0,3),
   remaining_work:r.remaining_work.slice(0,3),uncertainties:r.uncertainties.slice(0,3),omitted_items:all.length-Math.min(3,r.claimed_completed.length)-Math.min(3,r.remaining_work.length)-Math.min(3,r.uncertainties.length)};
 return 'Scoped backend helper returned to the desktop owner. This is an unverified subtask report, not completion, approval or supplied user input. '
  +'Use these findings for the remaining work and fresh inspection. Evaluate a proposed question yourself; a helper tool limitation is not a missing human answer. '
  +'Real missing design input still requires the user; do not invent values.\n'+JSON.stringify({report:inline,evidence_ref:result.evidence_ref});
}
/** A report is deliverable only AFTER ordinary provider receipt reconciliation
 * and drain. A later user control or existing blocker always wins. */
export function desktopHelperReturnAfterDrainV1(result:DesktopHelperReturnV1|null,marker:unknown,snapshot:AssignmentSnapshotV2|null,stopReason:string|null):string|null{
 if(!result||!consumedReturns.has(result)||stopReason!==DESKTOP_HELPER_RETURN_REASON||!snapshot
   ||!sameAssignmentBindingV2(snapshot.current_binding,result.binding)||!desktopHelperScopeForSnapshotV1(snapshot,marker)
   ||snapshot.terminal||snapshot.outcome!=='active'||!snapshot.quiescent||snapshot.execution_control?.state==='paused'
   ||(snapshot.execution_control?.command_id??null)!==result.control_command_id
   ||snapshot.completion_proposal||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted||snapshot.progress_blocker
   ||snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length||snapshot.unresolved_unknown_operation_ids.length
   ||snapshot.in_flight_operation_ids.length||snapshot.in_flight_provider_call_ids.length)return null;
 return desktopHelperReturnMessageV1(result);
}
