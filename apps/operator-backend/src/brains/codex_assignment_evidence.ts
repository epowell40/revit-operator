import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { pendingDuctVerificationRequestV2 } from "../verification/combined_duct_verification_v2.js";
import { verificationCapabilityGuidanceV2 } from "../verification/verification_capability_admission_v2.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/index.js";
import { checkedEditIsCurrentV2 } from '../verification/current_postcondition_v2.js';
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { resultObservationEligibilityV2 } from "../domain/assignment-kernel/result_delivery.js";
import type { assignmentWorkBudgetStatusV2 } from "../assignments/assignment_work_allowance_v2.js";
import { assignmentBudgetForPrompt } from "./assignment_budget_prompt.js";
import {NATIVE_PROPERTY_COMPARISON_FACT_V2}from '../verification/native_property_comparison_v2.js';

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
  const pendingVerification = Object.values(snapshot.operations)
    .filter(op => op.requested_effect === "apply" && op.persistent_effect === "applied" && op.settlement_state === "settled"
      && sameAssignmentBindingV2(op.binding, snapshot.current_binding)
      && !snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
      && !checkedEditIsCurrentV2(snapshot, op.operation_id))
    .slice(0, 8).map(op => ({ operation_id: op.operation_id, ...affectedTargetIndex(snapshot,op.operation_id),
      next_inspection: pendingDuctVerificationRequestV2(op),
      check_state: appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)?'previous_check_stale':'no_recognized_postcondition',
      latest_check: latestNativeComparison(snapshot,op.operation_id),
      guidance: verificationCapabilityGuidanceV2({ capability_id: op.capability_id, path: op.request_identity?.path, target_id: op.target.target_id }) }));
  if (advisoryVerificationV2(snapshot)) return JSON.stringify({ schema: "revit-operator.advisory-observation-index/v1",
    ...hostBudget,
    observations: observations.slice(0, 16).map(observation => ({ observation_id: observation.observation_id, operation_id: observation.operation_id,
      evidence_id: observation.raw_payload_ref.replace(/^evidence:/, ""), capability_id: snapshot.operations[observation.operation_id]?.capability_id })),
    pending_verification: pendingVerification,
    omitted: Math.max(0, observations.length - 16), usage: "Retained actual results. Retrieve missing native fields by evidence_id; inspect useful geometry and connections. Pending verification includes stale checks and suggests fresh inspection, not replaying edits. Compare with the latest user intent before correcting a mismatch; a superseded expected value must not undo newer work. Input-invalidated history stays retained but is not a request to restore old intent. A scalar mismatch can be a unit/display difference: inspect storage and units before correcting. Missing or unavailable evidence calls for inspection, not reapplying. A missing specialized proof does not invalidate actual readback; report unresolved scope honestly. This index does not certify task completion." });
  return JSON.stringify({
    schema: "revit-operator.model-observation-index/v2",
    ...hostBudget,
    observations: observations.slice(0, 32).map(observation => ({
      observation_id: observation.observation_id,
      operation_id: observation.operation_id,
      evidence_id: observation.raw_payload_ref.replace(/^evidence:/, ""),
      evidence_class: observation.evidence_class,
      result_item_eligibility: resultObservationEligibilityV2(snapshot, observation.observation_id),
      eligible_criterion_ids: observation.eligible_criterion_ids,
      capability_id: snapshot.operations[observation.operation_id]?.capability_id
    })),
    pending_verification: pendingVerification,
    omitted: Math.max(0, observations.length - 32),
    usage: "Criteria use eligible_criterion_ids. resultItems require eligibility=result; diagnostic permits execution_status/diagnostics/logs only. Retrieve missing fields by evidence_id. Never substitute operation IDs."
  });
}
