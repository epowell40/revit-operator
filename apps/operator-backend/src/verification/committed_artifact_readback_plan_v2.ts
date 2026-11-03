import {nativeArtifactResultEffectV2} from '@revitoperator/assignment-kernel-v2-contracts';
import type {AssignmentSnapshotV2,OperationV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';

/** Verify the files named by a settled native export. This never exports again,
 * supplies a proof, or certifies that the selected sheets cover the user scope. */
export function committedArtifactReadbackPlanV2(snapshot:AssignmentSnapshotV2,operation:OperationV2) {
 const result=operation.result,identity=operation.request_identity;
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
   ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
   ||!sameAssignmentBindingV2(snapshot.current_binding,operation.binding)||operation.admission_state!=='admitted'
   ||operation.dispatch_state!=='dispatched'||operation.settlement_state!=='settled'||operation.requested_effect!=='apply'
   ||operation.persistent_effect!=='applied'||!identity||identity.method!=='POST'
   ||typeof identity.path!=='string'||!['/revit/export-pdf','/revit/print','/revit/export-elements-xlsx'].includes(identity.path)
   ||operation.input.method!==identity.method||operation.input.path!==identity.path
   ||!result||result.status!=='succeeded'||result.operation_id!==operation.operation_id
   ||!sameAssignmentBindingV2(result.binding,operation.binding)||result.request_identity?.request_signature!==identity.request_signature
   ||nativeArtifactResultEffectV2(result)!=='applied'||!Number.isFinite(Date.parse(result.completed_at))
   ||operation.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,operation.operation_id))return null;
 const outputs=result.native_artifact_receipt!.outputs;
 return {method:'POST',path:'/revit/inspect-exported-files',body:{paths:outputs.map(output=>output.path)}};
}
