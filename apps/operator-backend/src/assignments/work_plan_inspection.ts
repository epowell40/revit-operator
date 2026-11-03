import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readEvidenceRef, readAuthoritativeEvidence } from "../evidence/evidence_store.js";
import type { WorkPlanInspectionV2 } from "../domain/assignment-kernel/work_plan.js";
import { verificationOperationHasVerifiedPostconditionV2 } from "../domain/assignment-kernel/outcome.js";
import { createdViewIdsFromIdentitiesV2, duplicatedViewDetailingSatisfiedV2 } from "../verification/view_owned_detailing_v2.js";
import { nativeInspectionTargetIdsV2, WORK_PLAN_INSPECTION_PATHS, WORK_PLAN_INSPECTION_GUIDANCE } from "./native_inspection_coverage.js";
import { artifactTargetTokensV2, nativeArtifactPostconditionV2 } from "../verification/native_artifact_contract_v2.js";
import { savedDocumentPostconditionV2 } from "../verification/saved_document_postcondition_v2.js";
import { operationTargetIdentityAliasesV2 } from "../domain/assignment-kernel/operation_target_identity.js";
import {parameterScheduleReadScopeV2} from '../verification/parameter_schedule_preservation_v2.js';
import {inlineAccessoryPostconditionSatisfiedV2} from '../verification/inline_accessory_evidence_v2.js';
import {nativeAccessoryPostconditionSatisfiedV2} from '../verification/native_accessory_evidence_v2.js';
import {teeTakeoffPostconditionSatisfiedV2} from '../verification/tee_takeoff_evidence_v2.js';

/** Locate a rejected citation without echoing arbitrary caller text or changing
 * admission. Other citations have not thereby been certified or auto-selected. */
function rejectedCitation(code: string, id: string, index: number, reason?: string): Error {
  const identity = /^opv2_[a-f0-9]{64}$/.test(id) ? ` (${id})` : '';
  return Error(`${code}: Rejected operationIds[${index}]${identity}. `
    + (reason ?? WORK_PLAN_INSPECTION_GUIDANCE) + ' '
    + 'Every cited read must qualify. Adding a valid read does not repair a rejected citation. '
    + 'Reconcile the submitted operationIds with the existing inspection_read_candidates or next_native_inspection candidates before requesting more reads; candidates still require normal validation. '
    + 'Keep the inspection scope and unresolved checks; correcting citations does not prove preservation or visual correctness. Do not repeat completed edits.');
}

/** Retain evidence that an inspection actually read its targets. This certifies
 * coverage of the read, never the assistant's engineering interpretation. */
export function retainWorkPlanInspectionV2(snapshot: AssignmentSnapshotV2, operationIds: readonly string[]): WorkPlanInspectionV2 {
  const targets = new Set<string>(), observations: string[] = [];
  if (!Array.isArray(operationIds) || operationIds.length < 1 || operationIds.length > 128) throw Error("work_plan_inspection_reads_required");
  for (const [index, id] of operationIds.entries()) {
    const op = snapshot.operations[id], result = op?.result;
    if (!op || op.requested_effect !== "read" || op.persistent_effect !== "none" || op.settlement_state !== "settled"
        || result?.authority !== "native-host" || result.status !== "succeeded" || result.dispatch_state !== "dispatched"
        || !sameAssignmentBindingV2(op.binding, snapshot.current_binding) || !sameAssignmentBindingV2(result.binding, snapshot.current_binding)
        || !WORK_PLAN_INSPECTION_PATHS.includes(op.request_identity?.path as any))
      throw rejectedCitation("work_plan_inspection_native_read_required", id, index);
    let accepted = false;
    let rejectionReason: string | undefined;
    for (const oid of op.observation_ids) {
      const observation = snapshot.observations[oid];
      if (!observation || observation.operation_id !== id || observation.authority !== "native-host"
          || observation.raw_payload_hash !== result.raw_payload_hash || !sameAssignmentBindingV2(observation.binding, snapshot.current_binding)) continue;
      const ref = readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/, ""));
      if (ref.byte_count > 8_000_000) continue;
      const data = JSON.parse(readAuthoritativeEvidence(ref, { ...snapshot.current_binding, attempt_id: id }).toString("utf8"));
      if (payloadDigestV2(data).digest !== observation.raw_payload_hash) continue;
      if(op.request_identity?.path==='/revit/get-connectors'&&(op.input.body as any)?.includeNativePlacementState===true){
        const subject=op.verification_of_operation_id?snapshot.operations[op.verification_of_operation_id]:undefined;
        if(!subject||!verificationOperationHasVerifiedPostconditionV2(snapshot,id)
          ||!nativeAccessoryPostconditionSatisfiedV2(snapshot,subject,result,data))continue;
        subject.result!.affected_target_identities?.forEach(target=>targets.add(target));
        observations.push(oid);accepted=true;break;
      }
      if(op.request_identity?.path==='/revit/get-connectors'&&(op.input.body as any)?.includeInlineAccessoryState===true){
        const subject=op.verification_of_operation_id?snapshot.operations[op.verification_of_operation_id]:undefined;
        if(!subject||!verificationOperationHasVerifiedPostconditionV2(snapshot,id)
          ||!inlineAccessoryPostconditionSatisfiedV2(snapshot,subject,result,data))continue;
        subject.result!.affected_target_identities?.forEach(target=>targets.add(target));
        observations.push(oid);accepted=true;break;
      }
      if(op.request_identity?.path==='/revit/get-connectors'&&(op.input.body as any)?.includeTeeReplacementState===true){
        const subject=op.verification_of_operation_id?snapshot.operations[op.verification_of_operation_id]:undefined;
        if(!subject||!verificationOperationHasVerifiedPostconditionV2(snapshot,id)
          ||!teeTakeoffPostconditionSatisfiedV2(snapshot,subject,result,data))continue;
        subject.result!.affected_target_identities?.forEach(target=>targets.add(target));
        observations.push(oid);accepted=true;break;
      }
      if (op.request_identity?.path === '/revit/get-parameters') {
        const candidates=Object.values(snapshot.operations).filter(a=>a.request_identity?.path==='/revit/set-parameter');
        const scopes=candidates.map(a=>parameterScheduleReadScopeV2(snapshot,a,op)).filter(s=>s!==null);
        if(scopes.length!==1)continue;
        [...scopes[0]!.target_ids,...scopes[0]!.preserved_schedule_ids].forEach(n=>targets.add(`element_id:${n}`));
        observations.push(oid);accepted=true;break;
      }
      if (op.request_identity?.path === "/revit/inspect-exported-files") {
        const applied = op.verification_of_operation_id ? snapshot.operations[op.verification_of_operation_id] : undefined;
        const applyResult = applied?.result, receipt = applyResult?.native_artifact_receipt;
        if (!applied || !applyResult || !receipt || applied.requested_effect !== "apply" || applied.persistent_effect !== "applied"
            || applyResult.authority !== "native-host" || applyResult.status !== "succeeded" || applyResult.dispatch_state !== "dispatched"
            || !sameAssignmentBindingV2(applied.binding, snapshot.current_binding) || !sameAssignmentBindingV2(applyResult.binding, snapshot.current_binding)
            || snapshot.input_invalidated_operation_ids?.includes(applied.operation_id)
            || !verificationOperationHasVerifiedPostconditionV2(snapshot, id)
            || !observation.facts.some(f => f.fact_id === "verification.postcondition_satisfied" && f.fact_class === "verification" && f.value === true)
            || result.result_schema_id !== "operator-native/POST:/revit/inspect-exported-files/v2"
            || op.input.method !== "POST" || op.input.path !== op.request_identity.path
            || applied.request_identity?.method !== "POST" || applied.request_identity.path !== receipt.path
            || applied.input.method !== "POST" || applied.input.path !== receipt.path
            || !(Date.parse(op.opened_at) > Date.parse(applyResult.completed_at))) continue;
        // Reuse accepted native artifact contracts, and bind the receipt back to
        // its retained apply bytes. A fact or model-supplied path alone is not proof.
        const retainedReceipt = applied.observation_ids.some(applyOid => {
          const o = snapshot.observations[applyOid];
          if (!o || o.operation_id !== applied.operation_id || o.authority !== "native-host"
              || !sameAssignmentBindingV2(o.binding, snapshot.current_binding) || o.raw_payload_hash !== applyResult.raw_payload_hash) return false;
          const applyRef = readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/, ""));
          if (applyRef.byte_count > 8_000_000) return false;
          const raw = JSON.parse(readAuthoritativeEvidence(applyRef, { ...snapshot.current_binding, attempt_id: applied.operation_id }).toString("utf8"));
          return payloadDigestV2(raw).digest === o.raw_payload_hash && raw?.artifact_receipt
            && payloadDigestV2(raw.artifact_receipt).digest === payloadDigestV2(receipt).digest;
        });
        if (!retainedReceipt || !(receipt.path === "/revit/save-as"
            ? savedDocumentPostconditionV2(applied.input, receipt, data, op.input)
            : nativeArtifactPostconditionV2(receipt, data))) continue;
        const fileTargets = artifactTargetTokensV2(data), requested = artifactTargetTokensV2(op.input);
        const readTargets = [op.target.target_id, ...Object.values(op.target.semantic_scope ?? {})].flatMap(operationTargetIdentityAliasesV2);
        if (!fileTargets.length || fileTargets.length !== requested.length || fileTargets.some(target => !requested.includes(target) || !readTargets.includes(target))) continue;
        fileTargets.forEach(target => targets.add(target)); observations.push(oid); accepted = true; break;
      }
      if (["/revit/get-element-summary", "/revit/find-text-notes", "/revit/inspect-family-content"].includes(op.request_identity?.path ?? "")) {
        if (result.result_schema_id !== `operator-native/POST:${op.request_identity!.path}/v2`
            || op.input?.method !== "POST" || op.input.path !== op.request_identity!.path) continue;
        const ids = nativeInspectionTargetIdsV2(op.input, data);
        if (!ids) {
          // Only explain request scope after the existing authority, binding,
          // retained-byte digest and route/schema checks. This is not a verdict
          // about result completeness, absence, or the other submitted reads.
          let body: any;
          try { body = typeof op.input.body === 'string' ? JSON.parse(op.input.body) : op.input.body; } catch { body = null; }
          if (op.input.path === '/revit/find-text-notes' && body && typeof body === 'object' && !Array.isArray(body)
              && !Array.isArray(body.elementIds))
            rejectionReason = 'The retained find-text-notes request lacks an exact elementIds array. A broad inventory or single elementId selector cannot supply this inspection coverage. Use an existing fresh exact-target read if it covers the required targets; otherwise obtain the supported scoped read.';
          continue;
        }
        ids.forEach(id => targets.add(`element_id:${id}`)); observations.push(oid); accepted = true; break;
      }
      if (op.request_identity?.path === "/revit/view-owned-detailing") {
        const applied = op.verification_of_operation_id ? snapshot.operations[op.verification_of_operation_id] : null;
        const body = applied?.input?.body as Record<string, unknown> | undefined;
        const sourceId = Number(body?.viewId), name = body?.newName;
        const createdIds = createdViewIdsFromIdentitiesV2(applied?.result?.affected_target_identities ?? []);
        const targetId = Number(/^id:(\d+)$/.exec(op.target.target_id ?? "")?.[1]);
        if (applied?.request_identity?.path !== "/revit/duplicate-view" || body?.withDetailing !== true
            || !Number.isSafeInteger(sourceId) || sourceId <= 0 || typeof name !== "string"
            || !Number.isSafeInteger(targetId) || !createdIds.includes(targetId)
            || !Array.isArray(data.views) || !data.views.some((view: any) => view?.view?.id === targetId)
            || !verificationOperationHasVerifiedPostconditionV2(snapshot, id)
            || !duplicatedViewDetailingSatisfiedV2(sourceId, name, data, createdIds)) continue;
        targets.add(`element_id:${targetId}`); observations.push(oid); accepted = true; break;
      }
      if (data.status !== "Ok" || !Array.isArray(data.results)
          || data.requestedCount !== data.results.length || data.scannedElementCount !== data.results.length
          || data.matchedElementCount !== data.results.length || data.failedElementCount !== 0 || data.connectorScanTruncatedElementCount !== 0
          || !data.results.length || new Set(data.results.map((r:any)=>r?.id)).size !== data.results.length
          || data.results.some((r:any)=>!Number.isSafeInteger(r?.id)||r.id<=0||r.ok!==true||r.connectorScanTruncated!==false
            || !Array.isArray(r.connectors)||r.connectorCount!==r.connectors.length||r.returnedConnectorCount!==r.connectors.length)) continue;
      data.results.forEach((r:any)=>targets.add(`element_id:${r.id}`)); observations.push(oid); accepted=true; break;
    }
    if (!accepted) throw rejectedCitation("work_plan_inspection_incomplete_native_read", id, index, rejectionReason);
  }
  return { observation_ids: observations.sort(), target_ids: [...targets].sort() };
}
