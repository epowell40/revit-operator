import {canonicalJsonV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {nativeChildProjectionReferencesV2} from '../assignments/assignment_kernel_v2_child_projection.js';

/** One bounded separate read of every effective target/field in an explicit
 * parameter batch. This is a read plan, not proof or permission to mutate. */
export function committedParameterReadbackPlanV2(snapshot:AssignmentSnapshotV2, operation:OperationV2) {
 const r=operation.result, body=operation.input.body as Record<string,unknown>|undefined;
 if(snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal
   || snapshot.execution_control?.state==='paused' || snapshot.unresolved_unknown_operation_ids.length
   || snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
   || !sameAssignmentBindingV2(snapshot.current_binding,operation.binding)
   || operation.admission_state!=='admitted' || operation.dispatch_state!=='dispatched'
   || operation.settlement_state!=='settled' || operation.requested_effect!=='apply' || operation.persistent_effect!=='applied'
   || operation.request_identity?.path!=='/revit/set-parameter'
   || operation.input.method!=='POST' || operation.input.path!==operation.request_identity.path
   || !r || r.status!=='succeeded' || r.authority!=='native-host' || r.native_transaction_state!=='committed'
   || r.persistent_effect!=='applied' || r.operation_id!==operation.operation_id
   || !sameAssignmentBindingV2(r.binding,operation.binding)
   || r.request_identity?.request_signature!==operation.request_identity.request_signature
   || !Number.isFinite(Date.parse(r.completed_at)) || !body || body.dryRun===true || body.apply===false
   || !Array.isArray(body.changes) || !body.changes.length || body.changes.length>100
   || operation.verification_operation_ids.length || appliedOperationHasVerifiedPostconditionV2(snapshot,operation.operation_id)) return null;
 const excluded=body.excludeElementIds??[];
 if(!Array.isArray(excluded)||excluded.some(id=>!Number.isSafeInteger(id)||id<=0))return null;
 const changes=body.changes as Record<string,unknown>[];
 if(changes.some(c=>!c || !Number.isSafeInteger(c.elementId) || Number(c.elementId)<=0
   || typeof c.parameterName!=='string' || !c.parameterName.trim() || c.parameterName.length>256
   || typeof c.value!=='string'))return null;
 const effective=changes.filter(c=>!excluded.includes(c.elementId));
 const ids=[...new Set(effective.map(c=>Number(c.elementId)))].sort((a,b)=>a-b);
 const names=[...new Set(effective.map(c=>String(c.parameterName)))].sort();
 if(!ids.length||names.length>50 || ids.some(id=>!r.affected_target_identities?.includes('element_id:'+id)))return null;
 // A later edit on any target makes this recipe stale. Never replay a check
 // against an overwritten value or manufacture a pass from the apply receipt.
 if(Object.values(snapshot.operations).some(other=>other.operation_id!==operation.operation_id
   && other.requested_effect==='apply' && other.persistent_effect!=='none' && other.opened_at>=operation.opened_at
   && (other.result?.affected_target_identities?.some(id=>ids.some(n=>id==='element_id:'+n))
     || Array.isArray((other.input.body as any)?.changes) && (other.input.body as any).changes.some((c:any)=>ids.includes(c?.elementId)))))return null;
 return {method:'POST',path:'/revit/get-parameters',body:{elementIds:ids,names,limit:500}};
}

/** A typed MCP setter settles an abstract parent; its exact retained native
 * child owns the commit. Never infer a commit from the wrapper or look up an
 * unrelated prior edit. Ambiguous multi-child wrappers remain unplanned. */
export function committedTypedParameterReadbackPlanV2(
 snapshot:AssignmentSnapshotV2, parent:OperationV2, mcpResult:unknown
) {
 const result=parent.result;
 if(parent.capability_id!=='revit_set_parameters' || parent.operation_role!=='root'
   || parent.admission_state!=='admitted' || parent.settlement_state!=='settled'
   || parent.requested_effect!=='apply' || parent.persistent_effect!=='none'
   || snapshot.input_invalidated_operation_ids?.includes(parent.operation_id)
   || !sameAssignmentBindingV2(snapshot.current_binding,parent.binding)
   || !result || result.operation_id!==parent.operation_id
   || result.status!=='completed_without_native_dispatch'
   || result.authority!=='operator-mcp-transport' || result.observation_required!==false
   || result.persistent_effect!=='none' || result.native_transaction_state!=='not_applicable'
   || parent.input.dryRun===true || parent.input.apply===false
   || !sameAssignmentBindingV2(result.binding,parent.binding)
   || !parent.request_identity?.request_signature
   || result.request_identity?.request_signature!==parent.request_identity.request_signature) return null;
 const references=nativeChildProjectionReferencesV2(snapshot,parent.operation_id,mcpResult);
 if(references.length!==1)return null;
 const child=snapshot.operations[references[0]!.operation_id];
 if(!child || !sameAssignmentBindingV2(child.binding,parent.binding)
   || child.opened_at<parent.opened_at
   || !Number.isFinite(Date.parse(result.completed_at)) || !child.result?.completed_at
   || canonicalJsonV2(parent.input.changes)!==canonicalJsonV2((child.input.body as any)?.changes)
   || Date.parse(child.result.completed_at)>Date.parse(result.completed_at))return null;
 const plan=committedParameterReadbackPlanV2(snapshot,child);
 return plan?{operation_id:child.operation_id,plan}:null;
}
