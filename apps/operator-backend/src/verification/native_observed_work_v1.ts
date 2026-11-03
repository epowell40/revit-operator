import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativeCommitProgressIdentityV2} from '../domain/assignment-kernel/progress/native_work_progress.js';
import {combinedReadFollowsSettledChanges} from './open_duct_postcondition_v2.js';
const physical=new Set(['OST_DuctCurves','OST_FlexDuctCurves','OST_DuctFitting','OST_DuctAccessory','OST_DuctTerminal','OST_MechanicalEquipment',
 'OST_PipeCurves','OST_FlexPipeCurves','OST_PipeFitting','OST_PipeAccessory','OST_PlumbingFixtures','OST_Sprinklers',
 'OST_ElectricalFixtures','OST_ElectricalEquipment','OST_LightingFixtures','OST_LightingDevices','OST_DataDevices','OST_CommunicationDevices',
 'OST_FireAlarmDevices','OST_SecurityDevices','OST_NurseCallDevices','OST_TelephoneDevices','OST_Wire','OST_CableTray','OST_CableTrayFitting','OST_Conduit','OST_ConduitFitting']);
const obj=(x:unknown):Record<string,any>=>x&&typeof x==='object'&&!Array.isArray(x)?x as any:{};
const positive=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const point=(x:unknown)=>Array.isArray(x)&&x.length===3&&x.every(v=>typeof v==='number'&&Number.isFinite(v));

/** Physical presence/geometry after an actual commit, not a comparison to the
 * requested design. This fact is for the explicitly opted-in work allowance;
 * it never links verification ownership, clears pending work or passes intent. */
export function nativeObservedPhysicalTargetsV1(snapshot:AssignmentSnapshotV2|undefined,read:OperationV2|undefined,
 result:OperationResultV2,payload:unknown):string[]{
 if(!snapshot||!read||snapshot.spec.execution_policy?.progress_allowance?.mode!=='observed_native_work_v1'
   ||snapshot.spec.requested_effect!=='apply'||snapshot.outcome!=='active'||snapshot.terminal
   ||snapshot.execution_control?.state==='paused'||snapshot.provider_usage_hold
   ||snapshot.in_flight_provider_call_ids.length||snapshot.unresolved_unknown_operation_ids.length
   ||snapshot.in_flight_operation_ids.some(id=>id!==read.operation_id)
   ||snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length
   ||snapshot.input_invalidated_operation_ids?.includes(read.operation_id)
   ||read.requested_effect!=='read'||read.admission_state!=='admitted'||!['dispatching','dispatched'].includes(read.dispatch_state)
   ||result.operation_id!==read.operation_id||result.authority!=='native-host'||result.status!=='succeeded'
   ||result.dispatch_state!=='dispatched'||result.persistent_effect!=='none'||result.native_transaction_state!=='not_applicable'
   ||result.result_semantic_gap||result.error_code||!result.receipt_id||!result.native_correlation_id
   ||!sameAssignmentBindingV2(read.binding,snapshot.current_binding)||!sameAssignmentBindingV2(result.binding,read.binding)
   ||read.target.document_fingerprint!==snapshot.current_binding.document_fingerprint
   ||read.request_identity?.method!=='POST'||read.request_identity.path!=='/revit/get-connectors'
   ||result.request_identity?.method!==read.request_identity.method||result.request_identity.path!==read.request_identity.path
   ||!read.request_identity.request_signature||result.request_identity.request_signature!==read.request_identity.request_signature
   ||payloadDigestV2(payload).digest!==result.raw_payload_hash||!combinedReadFollowsSettledChanges(snapshot,result))return[];
 const input=obj(read.input),body=obj(input.body),p=obj(payload),ids=body.elementIds;
 if(input.method!=='POST'||input.path!=='/revit/get-connectors'||!Array.isArray(ids)||!ids.length||ids.length>500
   ||!ids.every(positive)||new Set(ids).size!==ids.length||!['Ok','ok'].includes(p.status)||p.requestedCount!==ids.length
   ||p.scannedElementCount!==ids.length||p.matchedElementCount!==ids.length||p.failedElementCount!==0
   ||p.connectorScanTruncatedElementCount!==0||!Array.isArray(p.results)||p.results.length!==ids.length
   ||new Set(p.results.map((r:any)=>r?.id)).size!==ids.length||p.results.some((r:any)=>!ids.includes(r?.id)||r?.ok!==true))return[];
 const changed=new Set<string>();
 for(const mutation of Object.values(snapshot.operations)){
  if(mutation.result?.native_transaction_state!=='committed'||!nativeCommitProgressIdentityV2(snapshot,mutation)
    ||!mutation.request_identity?.request_signature||mutation.result.request_identity?.request_signature!==mutation.request_identity.request_signature
    ||Date.parse(mutation.opened_at)<Date.parse(snapshot.spec.created_at)
    ||Date.parse(mutation.result.completed_at)>Date.parse(read.opened_at))continue;
  for(const id of mutation.result.affected_target_identities??[])if(/^element_id:[1-9][0-9]*$/.test(id))changed.add(id);
 }
 return p.results.filter((r:any)=>physical.has(r.category)&&positive(r.id)&&changed.has('element_id:'+r.id)
   &&r.connectorScanTruncated===false&&Number.isSafeInteger(r.connectorCount)&&r.connectorCount>0&&r.connectorCount<=512
   &&r.returnedConnectorCount===r.connectorCount&&Array.isArray(r.connectors)&&r.connectors.length===r.connectorCount
   &&r.connectors.every((c:any)=>point(c?.origin)&&c.referenceScanComplete===true&&c.referenceReadErrorCount===0))
   .map((r:any)=>'element_id:'+r.id).sort();
}
