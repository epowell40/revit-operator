import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { pendingDuctVerificationRequestV2 } from "../verification/combined_duct_verification_v2.js";
import { verificationCapabilityGuidanceV2 } from "../verification/verification_capability_admission_v2.js";
import { familyLoadVerificationExclusionGuidanceV2 } from "../verification/family_session_verification_v2.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/index.js";
import { checkedEditIsCurrentV2,checkedReadIsCurrentV2 } from '../verification/current_postcondition_v2.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { resultObservationEligibilityV2 } from "../domain/assignment-kernel/result_delivery.js";
import type { assignmentWorkBudgetStatusV2 } from "../assignments/assignment_work_allowance_v2.js";
import { assignmentBudgetForPrompt } from "./assignment_budget_prompt.js";
import {NATIVE_PROPERTY_COMPARISON_FACT_V2}from '../verification/native_property_comparison_v2.js';
import {WORK_PLAN_INSPECTION_PATHS} from '../assignments/native_inspection_coverage.js';
import {projectNextNativeInspectionV2} from '../assignments/work_plan_projection.js';
import {regularSchedulePresentationCheckedScopeV2} from '../verification/regular_schedule_presentation_v2.js';
import {parameterScheduleReadScopeV2} from '../verification/parameter_schedule_preservation_v2.js';
import {nativeCommitProgressIdentityV2,observedNativeWorkTargetIdentitiesV1} from '../domain/assignment-kernel/progress/native_work_progress.js';

/** A discoverable existing read contract, not an executed check or fuel grant.
 * Candidate identities come from native receipts, not program-return claims.
 * Categories/current existence still have to be resolved by the actor. */
function observedWorkReadbackGuidance(snapshot:AssignmentSnapshotV2){
 if(snapshot.spec.requested_effect!=='apply'||snapshot.spec.execution_policy?.progress_allowance?.mode!=='observed_native_work_v1'
   ||snapshot.outcome!=='active'||snapshot.terminal||snapshot.execution_control?.state==='paused'
   ||snapshot.unresolved_unknown_operation_ids.length||snapshot.provider_usage_hold)return undefined;
 const credited=new Set(observedNativeWorkTargetIdentitiesV1(snapshot));
 const changes=Object.values(snapshot.operations).filter(op=>!snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
   &&nativeCommitProgressIdentityV2(snapshot,op)!==null)
   .sort((a,b)=>Date.parse(b.result!.completed_at)-Date.parse(a.result!.completed_at));
 const ids=[...new Set(changes.flatMap(op=>(op.result!.affected_target_identities??[])
   .filter(id=>/^element_id:[1-9][0-9]*$/.test(id)&&!credited.has(id))
   .map(id=>Number(id.slice('element_id:'.length))).filter(id=>Number.isSafeInteger(id)&&id>0)))];
 if(!ids.length)return undefined;
 return {authorizationGranted:false,completion_eligible:false,physical_category_known:false,
   candidate_element_ids:ids.slice(0,128),candidates:{total_count:ids.length,returned_count:Math.min(ids.length,128),complete:ids.length<=128},
   request:{method:'POST',path:'/revit/get-connectors',body_contract:{elementIds:'Current physical MEP owner IDs selected from the native affected candidates',includeAllRefs:true,maxConnectorsPerElement:512}},
   guidance:'Use the existing revit_call_tool through native__invoke for this structured native read after a useful construction batch. A custom C# read is useful inspection but does not earn this observed-work allowance. Select current physical MEP owners you changed; native affected candidates may also include schedules, types, deleted elements or other collateral, whose category/current existence is not established by this index. Do not include those in the physical selector. The structured read returns geometry, categories and connections; it can include several changed physical owners together for continuation fuel. Exact per-commit intent verification remains separate. Fresh successful native physical rows can earn bounded continuation resources; this hint itself earns none and does not certify intent, preservation, appearance, saved persistence or completion. Do not repeat construction to obtain credit.'};
}

function latestNativeComparison(snapshot:AssignmentSnapshotV2,operationId:string){
 const apply=snapshot.operations[operationId];
 const read=apply?.verification_operation_ids.map(id=>snapshot.operations[id]).filter(r=>r
   &&r.verification_of_operation_id===operationId&&sameAssignmentBindingV2(r.binding,snapshot.current_binding)
   &&!snapshot.input_invalidated_operation_ids?.includes(r.operation_id))
   .sort((a,b)=>(b!.settled_assignment_version??0)-(a!.settled_assignment_version??0))[0];
 if(!read)return undefined;
 if(read.result&&read.result.status!=='succeeded')return {read_operation_id:read.operation_id,state:'unavailable',reason:read.result.status};
 for(const id of read.observation_ids){const o=snapshot.observations[id];
  if(o?.authority!=='native-host'||o.raw_payload_hash!==read.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,snapshot.current_binding))continue;
  const fact=o.facts.find(f=>f.fact_id===NATIVE_PROPERTY_COMPARISON_FACT_V2&&f.fact_class==='control');
  if(typeof fact?.value!=='string'||fact.value.length>20000)continue;
  try{return {read_operation_id:read.operation_id,observation_id:id,evidence_id:o.raw_payload_ref.replace(/^evidence:/,''),as_of_read:true,...JSON.parse(fact.value)};}catch{/* malformed diagnostics never become authority */}
 }
 return {read_operation_id:read.operation_id,state:'unavailable',reason:'native_comparison_not_established'};
}

function affectedTargetIndex(snapshot:AssignmentSnapshotV2,operationId:string){
 const operation=snapshot.operations[operationId],all=operation?.result?.affected_target_identities??[];
 const observation=Object.values(snapshot.observations).find(o=>o.operation_id===operationId&&o.authority==='native-host'
   &&o.raw_payload_hash===operation?.result?.raw_payload_hash&&sameAssignmentBindingV2(o.binding,snapshot.current_binding));
 const shown=all.slice(0,16);
 return {affected_targets:shown,target_id:operation?.target.target_id,request_path:operation?.request_identity?.path,
   affected_targets_projection:{total_count:all.length,returned_count:shown.length,complete:shown.length===all.length,
     evidence_id:observation?.raw_payload_ref.replace(/^evidence:/,'' )??null,
     usage:'Index sample only when incomplete. Retrieve the retained native result for the full affected inventory; never infer unlisted targets or repeat the edit.'}};
}

/** Present an already accepted host comparison to both workers. Helper prose,
 * a complete native capture, and absence from the pending list are not this
 * proof. This index adds no verification, completion, permission or event. */
function verifiedPostconditions(snapshot:AssignmentSnapshotV2){
 if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length)return [];
 return Object.values(snapshot.operations).filter(op=>op.result?.authority==='native-host'
   &&op.result.status==='succeeded'&&checkedEditIsCurrentV2(snapshot,op.operation_id)).slice(-8).flatMap(op=>{
  const read=op.verification_operation_ids.map(id=>snapshot.operations[id]).filter(r=>r&&checkedReadIsCurrentV2(snapshot,r.operation_id))
   .sort((a,b)=>(b!.settled_assignment_version??0)-(a!.settled_assignment_version??0))[0];
  if(!read?.result?.receipt_id||!read.result.native_correlation_id)return [];
  const observation=read.observation_ids.map(id=>snapshot.observations[id]).find(o=>o?.operation_id===read.operation_id
   &&o.authority==='native-host'&&o.raw_payload_hash===read.result!.raw_payload_hash&&sameAssignmentBindingV2(o.binding,read.binding)
   &&o.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.fact_class==='verification'&&f.value===true));
  if(!observation)return [];
  const body=read.input.body as Record<string,unknown>|undefined;
  const requested=op.request_identity?.path==='/revit/create-text'&&read.request_identity?.path==='/revit/find-text-notes'
   ?body?.preservationScheduleIds:undefined;
  if(requested!==undefined&&(!Array.isArray(requested)||requested.length>32||new Set(requested).size!==requested.length
    ||!requested.every(id=>Number.isSafeInteger(id)&&Number(id)>0&&op.result!.affected_target_identities?.includes('element_id:'+id))))return [];
  const deliverable=observation.facts.find(f=>f.fact_id==='verification.deliverable_target_identities')?.value;
  const targets=Array.isArray(deliverable)&&deliverable.length<=32&&deliverable.every(id=>typeof id==='string'&&/^element_id:[1-9]\d*$/.test(id))?deliverable:undefined;
  const schedulePreservation=regularSchedulePresentationCheckedScopeV2(snapshot,op,read);
  const parameterPreservation=op.request_identity?.path==='/revit/set-parameter'?parameterScheduleReadScopeV2(snapshot,op,read):null;
  return [{operation_id:op.operation_id,request_path:op.request_identity?.path,check_state:'verified_current',
   read_operation_id:read.operation_id,observation_id:observation.observation_id,evidence_id:observation.raw_payload_ref.replace(/^evidence:/,''),
   deliverable_targets:targets,checked_preservation_ids:parameterPreservation?.preserved_schedule_ids??requested??[],
   ...(parameterPreservation?{checked_parameter_preservation:parameterPreservation}:{}),
   checked_schedule_preservation:schedulePreservation,
   scope:'Exact supported host postcondition from a current bound independent native read; not whole-model, visual, saved-file or task completion.',
   guidance:parameterPreservation?'The current independent native read checked the requested parameter values and the listed collateral schedules against actual native pre-edit flat definition/table/parameter snapshots. Do not mentally re-compare those raw arrays. For inspection after SaveAs, reuse the exact target elementIds and preservationScheduleIds in one fresh get-parameters read. This is not whole-model or visual proof; other obligations remain separate.'
    :schedulePreservation?'The current independent native comparison checked the listed target schedule content, host member identities, cell styles and placement anchors, plus the supported field/configuration postcondition and the listed unrequested schedules. Do not mentally re-compare those raw arrays. Geometric reflow, visual readability/clearance, other requested save and delivery obligations remain separate; existing controls apply.'
    :requested?'The host comparison already checked the listed schedule preservation obligations. Do not re-compare their raw arrays or request authorization solely to repeat that accepted check. Continue other already-requested visual, save and delivery obligations under existing controls.'
    :'This supported native check is current. Other requested inspections, save and delivery obligations remain separate; existing controls still apply.'}];
 });
}

/** Read pointers, never coverage certificates. The complete-work-plan action
 * still loads and validates the native bytes and checks every dependency. */
function inspectionReadCandidates(snapshot:AssignmentSnapshotV2){
 if(snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length)return [];
 const writes=Object.values(snapshot.operations).filter(op=>op.persistent_effect==='applied');
 const lastEdit=Math.max(0,...writes.map(op=>Date.parse(op.result?.completed_at??'')));
 if(!Number.isFinite(lastEdit))return [];
 return Object.values(snapshot.operations).filter(op=>op.requested_effect==='read'&&op.persistent_effect==='none'&&op.settlement_state==='settled'
  &&op.result?.authority==='native-host'&&op.result.status==='succeeded'&&op.result.dispatch_state==='dispatched'
  &&sameAssignmentBindingV2(op.binding,snapshot.current_binding)&&sameAssignmentBindingV2(op.result.binding,snapshot.current_binding)
  &&/^[a-f0-9]{64}$/.test(op.result.raw_payload_hash??'')&&op.request_identity?.request_signature
  &&op.request_identity.request_signature===op.result.request_identity?.request_signature
  &&op.observation_ids.some(id=>{const o=snapshot.observations[id];return o?.authority==='native-host'&&o.operation_id===op.operation_id
   &&o.raw_payload_hash===op.result!.raw_payload_hash&&sameAssignmentBindingV2(o.binding,snapshot.current_binding);})
  &&WORK_PLAN_INSPECTION_PATHS.includes(op.request_identity?.path as any)&&Date.parse(op.opened_at)>lastEdit
  &&(()=>{const body=op.input.body as Record<string,unknown>|undefined,ids=body?.elementIds??body?.ids;
   return Array.isArray(ids)&&ids.length>0&&ids.length<=500&&new Set(ids).size===ids.length&&ids.every(id=>Number.isSafeInteger(id)&&Number(id)>0);})())
 .sort((a,b)=>Date.parse(b.opened_at)-Date.parse(a.opened_at)).slice(0,4).map(op=>{
  const body=op.input.body as Record<string,unknown>|undefined,ids=body?.elementIds??body?.ids;
  const targets=Array.isArray(ids)?ids.map(id=>'element_id:'+id):[];
  return {read_operation_id:op.operation_id,request_path:op.request_identity?.path,opened_at:op.opened_at,
   requested_target_ids:targets.slice(0,16),requested_targets_projection:{total_count:targets.length,returned_count:Math.min(16,targets.length),complete:targets.length<=16},
   validation_required:true,usage:'Fresh bound read metadata only, not inspection proof. For a pending inspection cite an appropriate read operation to complete the checklist item; the host will still validate exact native coverage and dependencies. Saved-file proof covers artifact paths, not model elements. Do not repeat edits.'};
 });
}

/** Bounded identity mapping; native payloads remain behind focused retrieval. */
export function codexAssignmentEvidenceContextV2(snapshot: AssignmentSnapshotV2, operationId?: string,
  budgetStatus?: ReturnType<typeof assignmentWorkBudgetStatusV2>): string {
  const observations = Object.values(snapshot.observations)
    .filter(observation => {
      const operation = snapshot.operations[observation.operation_id];
      return sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
        && (!operationId || observation.operation_id === operationId || operation?.root_operation_id === operationId);
    })
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || a.observation_id.localeCompare(b.observation_id));
  if (!observations.length && !budgetStatus) return "";
  const hostBudget = budgetStatus ? { host_budget: assignmentBudgetForPrompt(budgetStatus) } : {};
  const hint=observedWorkReadbackGuidance(snapshot);
  const continuationReadback=hint?{continuation_readback:hint}:{};
  const verified_postconditions=verifiedPostconditions(snapshot);
  const inspection_read_candidates=inspectionReadCandidates(snapshot);
  const pendingOperations = Object.values(snapshot.operations)
    .filter(op => op.requested_effect === "apply" && op.persistent_effect === "applied" && op.settlement_state === "settled"
      && sameAssignmentBindingV2(op.binding, snapshot.current_binding)
      && !snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
      && !checkedEditIsCurrentV2(snapshot, op.operation_id))
    .sort((a,b)=>(b.settled_assignment_version??0)-(a.settled_assignment_version??0)
      || (b.settled_at??b.opened_at??'').localeCompare(a.settled_at??a.opened_at??'')
      || b.operation_id.localeCompare(a.operation_id));
  const pendingVerification = pendingOperations.slice(0, 8).map(op => {
    const next_inspection=pendingDuctVerificationRequestV2(op);
    const guidance=familyLoadVerificationExclusionGuidanceV2(snapshot,op)
      ?? verificationCapabilityGuidanceV2({ capability_id: op.capability_id, path: op.request_identity?.path, target_id: op.target.target_id });
    return { operation_id: op.operation_id, ...affectedTargetIndex(snapshot,op.operation_id),next_inspection,
      check_state: appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)?'previous_check_stale':'no_recognized_postcondition',
      latest_check: latestNativeComparison(snapshot,op.operation_id),
      guidance: next_inspection ? guidance+' Use next_inspection exactly for this committed operation. Do not merge its elementIds with other routes or connected equipment: a broader network read is useful observation but does not satisfy this per-commit check. Several separate calls may be emitted in one model turn. Read fresh results; never repeat a mutation to obtain proof.' : guidance };
  });
  const pending_verification_projection={total_count:pendingOperations.length,returned_count:pendingVerification.length,
    complete:pendingOperations.length===pendingVerification.length};
  if (advisoryVerificationV2(snapshot)) return JSON.stringify({ schema: "revit-operator.advisory-observation-index/v1",
    ...hostBudget,...continuationReadback,verified_postconditions,inspection_read_candidates,
    observations: observations.slice(0, 16).map(observation => ({ observation_id: observation.observation_id, operation_id: observation.operation_id,
      evidence_id: observation.raw_payload_ref.replace(/^evidence:/, ""), capability_id: snapshot.operations[observation.operation_id]?.capability_id })),
    pending_verification: pendingVerification,pending_verification_projection,
    omitted: Math.max(0, observations.length - 16), usage: "Retained actual results. Retrieve missing native fields by evidence_id; inspect useful geometry and connections. Pending verification includes stale checks and suggests fresh inspection, not replaying edits. Compare with the latest user intent before correcting a mismatch; a superseded expected value must not undo newer work. Input-invalidated history stays retained but is not a request to restore old intent. A scalar mismatch can be a unit/display difference: inspect storage and units before correcting. Missing or unavailable evidence calls for inspection, not reapplying. A missing specialized proof does not invalidate actual readback; report unresolved scope honestly. This index does not certify task completion." });
  return JSON.stringify({
    schema: "revit-operator.model-observation-index/v2",
    ...hostBudget,...continuationReadback,verified_postconditions,inspection_read_candidates,next_native_inspection:projectNextNativeInspectionV2(snapshot),
    observations: observations.slice(0, 32).map(observation => ({
      observation_id: observation.observation_id,
      operation_id: observation.operation_id,
      evidence_id: observation.raw_payload_ref.replace(/^evidence:/, ""),
      evidence_class: observation.evidence_class,
      result_item_eligibility: resultObservationEligibilityV2(snapshot, observation.observation_id),
      eligible_criterion_ids: observation.eligible_criterion_ids,
      capability_id: snapshot.operations[observation.operation_id]?.capability_id
    })),
    pending_verification: pendingVerification,pending_verification_projection,
    omitted: Math.max(0, observations.length - 32),
    usage: "Criteria use eligible_criterion_ids. resultItems require eligibility=result; diagnostic permits execution_status/diagnostics/logs only. Retrieve missing fields by evidence_id. Never substitute operation IDs."
  });
}
