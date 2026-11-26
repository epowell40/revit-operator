import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assignmentKernelV2ForBinding} from './assignment_kernel_v2_factory.js';
import {appendCurrentAssignmentKernelEventV2,createAssignmentKernelV2,getAssignmentKernelSnapshotV2} from './assignment_kernel_v2_store.js';
import type {AssignmentKernelBindingInputV2} from './assignment_kernel_v2_lifecycle.js';
import {desktopExecutorOwnsAssignmentV2} from './desktop_executor_owner.js';
import {desktopNativeResponseCall} from './desktop_native_tools.js';
import {readDesktopResponse} from '../desktop_response_store.js';
import {createGoal,getGoal} from '../goals/service.js';
import {getRequestAssignmentPrincipalId} from '../request_context.js';
import {newDocumentPhaseSpec,type NewProjectContextV1} from '../domain/assignment-kernel/new_document_handoff.js';
import {buildAssignmentKernelPublicationV2} from './assignment_kernel_v2_publication.js';
import {assignmentKernelTerminalSettlementDeferredV2} from './assignment_kernel_v2_terminal_barrier.js';

/** Read-only admission check for resuming between UI creation and handoff.
 * The acknowledged Resume and all existing stop/resource checks still apply.
 * No binding, budget, permission or model is changed here. */
export function inspectNewDocumentResume(binding:AssignmentKernelBindingInputV2,input:Record<string,any>) {
  const resolved=assignmentKernelV2ForBinding(binding);
  if(!resolved||!getRequestAssignmentPrincipalId()||!desktopExecutorOwnsAssignmentV2(resolved.snapshot))
    throw Error('new_document_owner_required');
  const raw=input.native_context,doc=raw?.document;
  const target:NewProjectContextV1={process_id:raw?.process_id,title:doc?.title,path:doc?.path,
    session_id:doc?.sessionId,fingerprint:doc?.projectIdentity?.fingerprint?.replace(/^sha256:/,''),
    created_at:doc?.createdAtUtc,is_family:doc?.isFamilyDocument};
  // Revit templates can preserve ProjectInformation.UniqueId, so two new
  // projects can share a fingerprint. The native document session, creation
  // event and exact process distinguish them; the fingerprint alone cannot.
  const originSession=resolved.goal.work_budget?.document_session_id;
  if(typeof originSession!=='string'||!/^[a-f0-9]{32}$/i.test(originSession)||target.session_id===originSession
      ||target.process_id!==resolved.goal.work_budget?.revit_process_id||raw?.readiness?.document_loaded!==true
      ||raw?.readiness?.active_view_ready!==true||assignmentKernelTerminalSettlementDeferredV2(resolved.binding))
    throw Error('new_document_process_or_readiness_mismatch');
  newDocumentPhaseSpec(resolved.snapshot,target,'resume-context',new Date().toISOString());
  return {schema:'operator.new-document-resume.v1',parent_binding:resolved.snapshot.current_binding,target};
}

/** The document data is captured by the authenticated Sidecar from protected
 * native transport, never supplied as model tool arguments. Every eventual
 * native dispatch still verifies the new fingerprint/session and write grant. */
export function continueInNewDocument(binding:AssignmentKernelBindingInputV2,input:Record<string,any>) {
  const resolved=assignmentKernelV2ForBinding(binding);
  if(!resolved||!getRequestAssignmentPrincipalId()||!desktopExecutorOwnsAssignmentV2(resolved.snapshot))
    throw Error('new_document_owner_required');
  const {goal,snapshot}=resolved;
  const stored=readDesktopResponse({...binding,kernelVersion:2},input.message_id);
  const selected=desktopNativeResponseCall(stored,input.response_id,input.call_id);
  const response=stored?.response as any;
  if(selected.tool!=='continue_in_new_revit_model'||Object.keys(selected.arguments).length
    ||response.output.filter((v:any)=>v?.type==='function_call'||v?.type==='computer_call').length!==1
    ||!Object.values(snapshot.provider_calls).some(c=>c.upstream_receipt?.call_id===input.response_id&&c.completed_at&&c.success&&c.usage))
    throw Error('new_document_accounted_single_call_required');
  if(assignmentKernelTerminalSettlementDeferredV2(resolved.binding))throw Error('new_document_receipts_pending');
  const raw=input.native_context,doc=raw?.document;
  const target:NewProjectContextV1={process_id:raw?.process_id,title:doc?.title,path:doc?.path,
    session_id:doc?.sessionId,fingerprint:doc?.projectIdentity?.fingerprint?.replace(/^sha256:/,''),
    created_at:doc?.createdAtUtc,is_family:doc?.isFamilyDocument};
  const originSession=goal.work_budget?.document_session_id;
  if(typeof originSession!=='string'||!/^[a-f0-9]{32}$/i.test(originSession)||target.session_id===originSession
    ||target.process_id!==goal.work_budget?.revit_process_id||raw?.readiness?.document_loaded!==true
    ||raw?.readiness?.active_view_ready!==true)throw Error('new_document_process_or_readiness_mismatch');
  const commandId=createHash('sha256').update(input.response_id+':'+input.call_id).digest('hex');
  let handoff=snapshot.document_handoff;
  if(handoff) {
    if(handoff.command_id!==commandId||!isDeepStrictEqual(handoff.target,target)
      ||snapshot.execution_control?.command_id!=='document:'+commandId)throw Error('new_document_handoff_changed');
  }else {
    const now=new Date().toISOString();
    handoff={command_id:commandId,observed_at:now,target,child_spec:newDocumentPhaseSpec(snapshot,target,commandId,now)};
    appendCurrentAssignmentKernelEventV2({goal_id:goal.id,binding:resolved.binding,event_id:'document:'+commandId,
      actor:'desktop-document-controller',occurred_at:now,body:{event_type:'new_document_handoff',handoff}});
  }
  const spec=handoff.child_spec,childId=spec.binding.assignment_id;
  const workBudget={...goal.work_budget,document_fingerprint:target.fingerprint,document_title:target.title,
    document_path:target.path,document_session_id:target.session_id,document_parent_assignment:goal.id};
  let child=getGoal(childId);
  if(child) {
    if(child.related_session_id!==binding.session_id||child.objective!==goal.objective
      ||!isDeepStrictEqual(child.work_budget,workBudget))throw Error('new_document_child_conflict');
  } else child=createGoal({title:goal.title,objective:goal.objective,acceptance_criteria:goal.acceptance_criteria,
    related_session_id:binding.session_id,created_by:goal.created_by,work_budget:workBudget,status:'active',
    progress_summary:'Continuing the requested work in '+target.title+'.'},childId);
  const existing=getAssignmentKernelSnapshotV2(childId);
  if(existing&&!isDeepStrictEqual(existing.spec,spec))throw Error('new_document_child_spec_conflict');
  const next=existing??createAssignmentKernelV2(childId,spec,'desktop-document-controller').snapshot;
  return {schema:'operator.new-document-handoff.v1',parent_binding:snapshot.current_binding,
    goal:child,publication:buildAssignmentKernelPublicationV2(next),
    message:'Continue the original request in '+target.title+'. The new project already exists; do not create it again. Earlier model element IDs and observations belong to the prior document. Inspect new targets before editing. No model edit or save is claimed by this handoff.'};
}
