import path from 'node:path';
import { nativeDocumentCheckpointResultV2 } from '@revitoperator/assignment-kernel-v2-contracts';
import type { AssignmentSnapshotV2,OperationV2 } from '../domain/assignment-kernel/index.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';

/** One fresh read through normal admission; never another save or a synthesized proof. */
export function committedSavedDocumentReadbackPlanV2(snapshot:AssignmentSnapshotV2, operation:OperationV2) {
 const r=operation.result, body=operation.input.body as Record<string,unknown>|undefined;
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
   ||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(operation.operation_id)
   ||!sameAssignmentBindingV2(snapshot.current_binding,operation.binding)||operation.admission_state!=='admitted'
   ||operation.dispatch_state!=='dispatched'||operation.settlement_state!=='settled'||operation.requested_effect!=='apply'
   ||operation.persistent_effect!=='applied'||operation.request_identity?.path!=='/revit/save-as'
   ||operation.input.method!=='POST'||operation.input.path!==operation.request_identity.path
   ||!r||!nativeDocumentCheckpointResultV2(r)||r.operation_id!==operation.operation_id
   ||!sameAssignmentBindingV2(r.binding,operation.binding)||r.request_identity?.request_signature!==operation.request_identity.request_signature
   ||!Number.isFinite(Date.parse(r.completed_at))||!body||body.dryRun===true||typeof body.filePath!=='string'
   ||operation.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,operation.operation_id))return null;
 const saved=r.native_artifact_receipt?.save_document, outputs=r.native_artifact_receipt?.outputs;
 if(!saved||saved.project_binding_changed||!saved.same_document
   ||saved.before.project_fingerprint!==operation.binding.document_fingerprint||saved.after?.project_fingerprint!==operation.binding.document_fingerprint
   ||!outputs||outputs.length!==1||!saved.after||!path.win32.isAbsolute(saved.after.path))return null;
 const normalized=(v:string)=>path.win32.normalize(v).replaceAll('\\','/').toLowerCase();
 const expected=path.win32.isAbsolute(body.filePath)?body.filePath:path.win32.resolve(path.win32.dirname(saved.before.path),body.filePath);
 if(normalized(expected)!==normalized(saved.after.path)||normalized(outputs[0]!.path)!==normalized(saved.after.path)
   ||Object.values(snapshot.operations).some(other=>other.operation_id!==operation.operation_id&&other.requested_effect==='apply'
     &&(other.settlement_state!=='settled'||other.persistent_effect!=='none'&&other.opened_at>=operation.opened_at)))return null;
 return {method:'POST',path:'/revit/inspect-exported-files',body:{paths:[outputs[0]!.path]}};
}
