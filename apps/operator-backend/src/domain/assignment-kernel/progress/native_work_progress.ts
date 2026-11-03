import { canonicalJsonV2 } from "../canonical.js";
import { sameAssignmentBindingV2 } from "../identity.js";
import { operationMatchesTargetIdentityV2,reportedOperationTargetIdentitiesV2,operationTargetIdentityAliasesV2 } from "../operation_target_identity.js";
import type { OperationV2 } from "../operation.js";
import type { AssignmentSnapshotV2 } from "../snapshot.js";
import { nativeDocumentCheckpointRequestMatchesV2 } from '@revitoperator/assignment-kernel-v2-contracts';
import {verificationOperationHasVerifiedPostconditionV2} from '../outcome.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../verified_work_targets.js';

/** Trusted native observation for continuation fuel only, never intent proof. */
export const NATIVE_OBSERVED_PHYSICAL_TARGETS_V1='control.native_observed_physical_targets';

export function observedNativeWorkTargetIdentitiesV1(snapshot:AssignmentSnapshotV2):string[]{
 return [...new Set(observedNativeWorkReadEventsV1(snapshot).flatMap(event=>event.targets))].sort();
}

/** Original trusted read times survive recovery. Re-reading an already seen
 * physical owner is neither another unit of fuel nor a new pacing event. */
function observedNativeWorkReadEventsV1(snapshot:AssignmentSnapshotV2):{completed_at:string;targets:string[]}[]{
 if(snapshot.spec.requested_effect!=='apply'||snapshot.spec.execution_policy?.progress_allowance?.mode!=='observed_native_work_v1')return[];
 const declared=Date.parse(snapshot.spec.created_at);
 if(!Number.isFinite(declared))return[];
 const mutations=Object.values(snapshot.operations).filter(o=>nativeModelCommitProgressIdentityV2(snapshot,o,true)!==null
   &&o.result?.native_transaction_state==='committed'&&Number.isFinite(Date.parse(o.result.completed_at))
   &&Date.parse(o.opened_at)>=declared&&!!o.request_identity?.request_signature
   &&o.result.request_identity?.request_signature===o.request_identity.request_signature);
 const events:{completed_at:string;targets:string[]}[]=[];
 for(const read of Object.values(snapshot.operations)){
  if(read.requested_effect!=='read'||read.persistent_effect!=='none'||read.result?.persistent_effect!=='none'
    ||read.result.native_transaction_state!=='not_applicable'||!retainedNativeExecutionSuccess(snapshot,read)
    ||!read.result.receipt_id||!read.result.native_correlation_id
    ||!Number.isFinite(Date.parse(read.opened_at))||Date.parse(read.opened_at)<declared
    ||!Number.isFinite(Date.parse(read.result.completed_at))||Date.parse(read.result.completed_at)<Date.parse(read.opened_at)
    ||!read.request_identity?.request_signature||read.result.request_identity?.request_signature!==read.request_identity.request_signature
    ||read.target.document_fingerprint!==snapshot.current_binding.document_fingerprint)continue;
  const targets=new Set<string>();
  for(const id of read.observation_ids){const o=snapshot.observations[id];
   if(!o||o.authority!=='native-host'||o.operation_id!==read.operation_id||!sameAssignmentBindingV2(o.binding,read.binding)
     ||o.raw_payload_hash!==read.result.raw_payload_hash||!o.raw_payload_ref||o.result_schema_id!==read.result.result_schema_id)continue;
   const facts=o.facts.filter(f=>f.fact_id===NATIVE_OBSERVED_PHYSICAL_TARGETS_V1&&f.fact_class==='control');
   if(facts.length!==1)continue;const values=facts[0]!.value;
   if(!Array.isArray(values)||!values.length||values.length>500||new Set(values).size!==values.length
     ||values.some(v=>typeof v!=='string'||!/^element_id:[1-9][0-9]*$/.test(v)))continue;
   const readTargets=new Set(reportedOperationTargetIdentitiesV2(read).flatMap(operationTargetIdentityAliasesV2));
   for(const target of values as string[]){
    if(!operationTargetIdentityAliasesV2(target).some(alias=>readTargets.has(alias)))continue;
    if(mutations.some(m=>Date.parse(m.result!.completed_at)<=Date.parse(read.opened_at)
      &&(m.result!.affected_target_identities??[]).includes(target)))targets.add(target);
   }
  }
  if(targets.size)events.push({completed_at:read.result.completed_at,targets:[...targets].sort()});
 }
 // Historical observed work survives a later direction. Currentness, Pause,
 // unknown effects and pending usage still govern dispatch in the controller.
 return events;
}

function retainedNativeExecutionSuccess(snapshot: AssignmentSnapshotV2, operation: OperationV2): boolean {
  const result = operation.result;
  return operation.admission_state === "admitted" && operation.dispatch_state === "dispatched"
    && operation.settlement_state === "settled" && sameAssignmentBindingV2(operation.binding, snapshot.current_binding)
    && result?.authority === "native-host" && result.status === "succeeded"
    && result.dispatch_state === "dispatched" && result.operation_id === operation.operation_id
    && sameAssignmentBindingV2(result.binding, operation.binding) && !result.result_semantic_gap
    && operation.observation_ids.some(id => {
      const observation = snapshot.observations[id];
      return observation?.authority === "native-host" && observation.operation_id === operation.operation_id
        && sameAssignmentBindingV2(observation.binding, operation.binding)
        && observation.capability_id === operation.capability_id
        && Boolean(observation.raw_payload_hash) && observation.raw_payload_hash === result.raw_payload_hash
        && observation.facts.some(f => f.fact_id === "control.domain_succeeded" && f.value === true);
    });
}

/** Current-use success still rejects input-invalidated evidence. Historical
 * execution custody below is reused only by the construction pacing clock;
 * it cannot renew verification, allowance, authority or task completion. */
export function retainedNativeSuccess(snapshot: AssignmentSnapshotV2, operation: OperationV2): boolean {
  return !snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
    && retainedNativeExecutionSuccess(snapshot, operation);
}

/** Proof that a separate native check actually ran, not that its postcondition
 * passed. Used only to retain an explicitly deferred, incomplete checkpoint;
 * it must never certify a criterion, work item, effect scope or completion. */
export function nativeVerificationAttemptIsRetainedV2(snapshot: AssignmentSnapshotV2, appliedOperationId: string): boolean {
  const applied = snapshot.operations[appliedOperationId];
  if (!applied || applied.requested_effect !== "apply" || applied.persistent_effect !== "applied"
      || applied.result?.persistent_effect !== "applied" || applied.result.native_transaction_state !== "committed"
      || !applied.result.receipt_id || !retainedNativeSuccess(snapshot, applied)) return false;
  const retainedEvidence = (operation: OperationV2): boolean => operation.observation_ids.some(id => {
    const observation = snapshot.observations[id], result = operation.result!;
    return observation?.authority === "native-host" && observation.operation_id === operation.operation_id
      && sameAssignmentBindingV2(observation.binding, operation.binding)
      && observation.capability_id === operation.capability_id && observation.result_schema_id === result.result_schema_id
      && Boolean(observation.raw_payload_ref) && /^[a-f0-9]{64}$/i.test(observation.raw_payload_hash)
      && observation.raw_payload_hash === result.raw_payload_hash
      && Date.parse(observation.observed_at) >= Date.parse(result.completed_at)
      && observation.facts.some(f => f.fact_id === "control.domain_succeeded" && f.value === true);
  });
  if (!retainedEvidence(applied)) return false;
  return applied.verification_operation_ids.some(id => {
    const read = snapshot.operations[id];
    if (!read || read.verification_of_operation_id !== applied.operation_id
        || read.purpose !== "verification" || read.fulfillment_role !== "verification"
        || read.requested_effect !== "read" || read.persistent_effect !== "none"
        || read.result?.persistent_effect !== "none" || read.result.native_transaction_state !== "not_applicable"
        || !retainedNativeSuccess(snapshot, read) || !retainedEvidence(read)
        || !(Date.parse(read.opened_at) >= Date.parse(applied.result!.completed_at))
        || !(Date.parse(read.result.completed_at) >= Date.parse(read.opened_at))
        || read.target.document_fingerprint !== applied.target.document_fingerprint
        || applied.target.document_fingerprint !== snapshot.current_binding.document_fingerprint) return false;
    const targets = [read.target.target_id, ...Object.values(read.target.semantic_scope ?? {})]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return targets.length > 0 && targets.every(target => operationMatchesTargetIdentityV2(applied, [target]));
  });
}

/** A native commit is useful work before its separate engineering verification.
 * This does not pass a criterion, enlarge a hard budget, or close a work item. */
function nativeModelCommitProgressIdentityV2(snapshot: AssignmentSnapshotV2, operation: OperationV2, historicalPacing = false): string | null {
  const result = operation.result;
  if (snapshot.spec.requested_effect !== "apply" || operation.requested_effect !== "apply" || operation.purpose !== "work"
      || operation.fulfillment_role !== "delegated_task_execution" || operation.persistent_effect !== "applied"
      || result?.persistent_effect !== "applied" || result.native_transaction_state !== "committed"
      || !result.receipt_id || !result.affected_target_identities?.length
      || !(historicalPacing ? retainedNativeExecutionSuccess(snapshot, operation) : retainedNativeSuccess(snapshot, operation))) return null;
  return canonicalJsonV2({ document: operation.binding.document_fingerprint, native_receipt: result.receipt_id });
}

/** A tracked native SaveAs preserves work before its separate file check.
 * Count one checkpoint per preceding canonical model change, never timestamps,
 * new paths, repeated saves or differing file hashes alone. No proof is renewed. */
export function nativeCommitProgressIdentityV2(snapshot:AssignmentSnapshotV2,operation:OperationV2):string|null {
 const model=nativeModelCommitProgressIdentityV2(snapshot,operation);if(model)return model;
 const r=operation.result,b=operation.input.body as Record<string,unknown>|undefined;
 if(snapshot.spec.requested_effect!=='apply'||operation.requested_effect!=='apply'||operation.purpose!=='work'
   ||operation.fulfillment_role!=='delegated_task_execution'||operation.persistent_effect!=='applied'
   ||!r||!nativeDocumentCheckpointRequestMatchesV2(operation,operation.binding.document_fingerprint)||!retainedNativeSuccess(snapshot,operation)
   ||operation.request_identity?.method!=='POST'||operation.request_identity.path!==operation.input.path
   ||!(/^[a-f0-9]{64}$/i).test(operation.request_identity.request_signature)
   ||r.request_identity?.request_signature!==operation.request_identity.request_signature
   ||!r.receipt_id||!r.native_correlation_id||!b||b.dryRun===true||typeof b.filePath!=='string'
   ||b.filePath.length>2000||/[\u0000-\u001f]/.test(b.filePath))return null;
 const at=Date.parse(operation.opened_at);if(!Number.isFinite(at)||!Number.isFinite(Date.parse(r.completed_at))||Date.parse(r.completed_at)<at)return null;
 const preceding=Object.values(snapshot.operations).filter(o=>o.operation_id!==operation.operation_id
   &&nativeModelCommitProgressIdentityV2(snapshot,o)!==null&&Number.isFinite(Date.parse(o.result!.completed_at))
   &&Date.parse(o.result!.completed_at)<=at)
   .sort((a,b)=>Date.parse(b.result!.completed_at)-Date.parse(a.result!.completed_at)
     ||(b.settled_assignment_version??0)-(a.settled_assignment_version??0));
 return canonicalJsonV2({document:operation.binding.document_fingerprint,saved_native_change:preceding[0]
   ?nativeModelCommitProgressIdentityV2(snapshot,preceding[0]):'initial_document'});
}

/** Count a retained, exact-target read once per native edit and selector shape.
 * Repeated reads, changed timestamps and new observation/receipt IDs add no
 * credit. The actual postcondition remains a separate, stricter contract. */
export function nativeVerificationProgressIdentityV2(
  snapshot: AssignmentSnapshotV2, operation: OperationV2, readIdentities: Readonly<Record<string, string>>
): string | null {
  const subject = operation.verification_of_operation_id ? snapshot.operations[operation.verification_of_operation_id] : undefined;
  const readIdentity = readIdentities[operation.operation_id];
  const subjectIdentity = subject && nativeCommitProgressIdentityV2(snapshot, subject);
  if (!subject || !subjectIdentity || !readIdentity || readIdentity.length > 100_000
      || operation.purpose !== "verification" || operation.requested_effect !== "read"
      || operation.fulfillment_role !== "verification" || operation.persistent_effect !== "none"
      || operation.result?.persistent_effect !== "none" || operation.result.native_transaction_state !== "not_applicable"
      || !subject.verification_operation_ids.includes(operation.operation_id) || !retainedNativeSuccess(snapshot, operation)
      || !(Date.parse(operation.opened_at) >= Date.parse(subject.result!.completed_at))
      || operation.target.document_fingerprint !== subject.target.document_fingerprint) return null;
  const targets = [operation.target.target_id, ...Object.values(operation.target.semantic_scope ?? {})]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!targets.length || !targets.every(target => operationMatchesTargetIdentityV2(subject, [target]))) return null;
  return canonicalJsonV2({ native_change: subjectIdentity, read: readIdentity });
}

/** Construction pacing for the existing continuous owner, not extra allowance
 * or completion proof. Knowledge-only epochs can be useful during orientation,
 * but cannot indefinitely reset a drafting loop's no-progress check. Derive
 * this from the journal so compaction/reopen does not reset the counter. */
export function draftingConstructionProgressV2(snapshot: AssignmentSnapshotV2, noProgressEpochs: number) {
  const policy=snapshot.spec.execution_policy;
  if(policy?.ready_work_handoff!=='continue_ready_work_v1'||snapshot.spec.requested_effect!=='apply'
    ||!policy.progress_allowance
    ||!Number.isSafeInteger(noProgressEpochs)||noProgressEpochs<1)return null;
  // Local advisory work can begin without a declared plan. The construction
  // clock belongs to the persistent write objective, not optional bookkeeping.
  let since=Date.parse(snapshot.spec.created_at),commits=0;
  if(!Number.isFinite(since))return null;
  // A settled checkpoint continued through the existing authenticated-user
  // allocation starts one bounded new work window. Reopening/compaction alone
  // cannot change this journal-derived timestamp or erase prior usage.
  const authorizedFollowup=Date.parse(snapshot.user_followup_allocation?.allocated_at??'');
  if(Number.isFinite(authorizedFollowup))since=Math.max(since,authorizedFollowup);
  const seen=new Set<string>();
  for(const operation of Object.values(snapshot.operations).sort((a,b)=>Date.parse(a.opened_at)-Date.parse(b.opened_at))){
    // SaveAs is a document checkpoint, not newly constructed drawing content.
    // A changed direction invalidates old results for CURRENT verification,
    // not the fact that those authenticated native commits actually happened.
    // Reopen still preserves their timestamps and all intervening call counts.
    const identity=nativeModelCommitProgressIdentityV2(snapshot,operation,true),signature=operation.request_identity?.request_signature;
    if(!identity||!signature||seen.has(signature))continue;
    const completed=Date.parse(operation.result!.completed_at);
    if(!Number.isFinite(completed)||completed<since)continue;
    seen.add(signature);commits++;since=completed;
  }
  const checked=new Set<string>();
  for(const read of Object.values(snapshot.operations).sort((a,b)=>Date.parse(a.result?.completed_at??'')-Date.parse(b.result?.completed_at??''))){
    const subject=read.verification_of_operation_id&&snapshot.operations[read.verification_of_operation_id];
    if(!subject||!nativeModelCommitProgressIdentityV2(snapshot,subject)
      ||!verificationOperationHasVerifiedPostconditionV2(snapshot,read.operation_id)||!retainedNativeSuccess(snapshot,read))continue;
    const targets=verifiedNativeWorkTargetIdentitiesV2(snapshot,subject.operation_id).filter(id=>!checked.has(id));
    const completed=Date.parse(read.result!.completed_at);
    if(!targets.length||!Number.isFinite(completed))continue;
    targets.forEach(id=>checked.add(id));since=Math.max(since,completed);
  }
  const observed=new Set<string>();
  for(const event of observedNativeWorkReadEventsV1(snapshot).sort((a,b)=>Date.parse(a.completed_at)-Date.parse(b.completed_at))){
    const fresh=event.targets.filter(id=>!observed.has(id));
    if(!fresh.length)continue;
    fresh.forEach(id=>observed.add(id));since=Math.max(since,Date.parse(event.completed_at));
  }
  const calls=Object.values(snapshot.provider_calls).filter(call=>sameAssignmentBindingV2(call.binding,snapshot.current_binding)
    &&call.completed_at&&Number.isFinite(Date.parse(call.admitted_at))&&Number.isFinite(Date.parse(call.completed_at))
    &&Date.parse(call.admitted_at)>=since&&Date.parse(call.completed_at)>=Date.parse(call.admitted_at)).length;
  // Reuse the configured no-progress window: orientation, then a bounded
  // changed-approach window. These do not raise any resource ceiling.
  const warnAfter=noProgressEpochs*2,stopAfter=noProgressEpochs*3;
  return {state:calls>=stopAfter?'stalled' as const:calls>=warnAfter?'change_approach' as const:'working' as const,
    calls_since_construction:calls,distinct_model_commits:commits,since:new Date(since).toISOString(),warn_after:warnAfter,stop_after:stopAfter,
    independently_checked_targets:checked.size,changes_allowance:false as const,
    ...(policy.progress_allowance.mode==='observed_native_work_v1'?{independently_observed_targets:observed.size}:{}),
    notice:(policy.progress_allowance.mode==='observed_native_work_v1'
        ?'This is a construction/checking window, not work credit. The separate observed-work allowance requires fresh native physical readback after actual commits; it is not intent verification. '
        :'This is a construction/checking window, not verified work credit. Existing distinct checked-target rules alone earn extra allowance. ')
      +(policy.progress_allowance.mode==='observed_native_work_v1'
        ?'Only first trusted observations of distinct changed physical owners advance this checking clock; repeated reads, retrievals, reviews, checklist prose and unchanged-model saves do not reset it. This pacing signal does not deny admission or certify completion.'
        :'Reads, retrievals, reviews, checklist prose and unchanged-model saves do not reset this window.')};
}
