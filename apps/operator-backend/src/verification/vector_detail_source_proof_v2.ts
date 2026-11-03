import {canonicalVectorJson} from '../pdf/drafting_vector_native_plan.js';
import {reparseRegisteredVectorPlan} from '../attachments/reparse_registered_vector_plan.js';
import {draftingVectorAnnotations,VECTOR_ANNOTATION_RENDERER,VECTOR_ANNOTATION_PART_SIZE} from '../pdf/drafting_vector_annotations.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentBindingV2,type AssignmentSnapshotV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {explicitMcpEnvelope} from '../assignments/native_observation_inputs_v2.js';
import {storeEvidence,readAuthoritativeEvidence} from '../evidence/evidence_store.js';
import type {EvidenceRefV1} from '../evidence/evidence_ref.js';
import {prepareVectorStrokeCadProofDetailsV2,VECTOR_STROKE_CAD_PROOF_SCOPE_V2,type VectorStrokeCadProofDetailsV2} from './vector_stroke_cad_source_proof_v2.js';
import {checkedReadIsCurrentV2} from './current_postcondition_v2.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const issued=new WeakSet<object>();
export type SourceProofRecord=Readonly<{
 schema:'operator.vector-detail-original-source-proof.v1';readOperationId:string;nativeResultId:string;nativeRawPayloadHash:string;
 binding:AssignmentBindingV2;at:string;matches:boolean;sourceSha256?:string;sourcePlanSha256?:string;nativePlanSha256?:string;
 nativePlanFileSha256?:string;partIndex?:number;sourcePartEntityCount?:number;sourceEntityCount?:number;partsTotal?:number;error?:string;
 renderer?:string;sourcePlanEntityCount?:number;sourcePartEntityIds?:readonly string[];
 cad?:VectorStrokeCadProofDetailsV2;
 scope:'fresh_original_pdf_reparse_and_complete_native_plan_comparison_not_native_model_or_visual_verification'|typeof VECTOR_STROKE_CAD_PROOF_SCOPE_V2;
}>;
export type PreparedVectorSourceProofV2=Readonly<{record:SourceProofRecord;evidence:EvidenceRefV1}>;
type Lease={operation_id:string;binding:AssignmentBindingV2;assignment_id:string};

/** Backend-owned source check, separate from both the working model and its native receipt.
 * Its opaque result cannot be supplied by a provider, MCP producer, or caller assertion. */
export async function prepareVectorSourceProofV2(lease:Lease,rawResult:unknown,snapshot:AssignmentSnapshotV2|null):Promise<PreparedVectorSourceProofV2|null>{
 let result:OperationResultV2,payload:Record<string,any>;
 let cadRead=false;
 try{
  const envelope=explicitMcpEnvelope(rawResult);result=envelope.operation_result_v2;payload=object(envelope.observation?.raw_payload);
  const op=snapshot?.operations[lease.operation_id],b=object(op?.input.body);
  cadRead=op?.input.path==='/revit/view-owned-detailing'&&b.cadTargetOnly===true;
  if(!snapshot||!op||(!cadRead&&op.input.path!=='/revit/inspect-vector-detail')||op.input.method!=='POST'||op.requested_effect!=='read'
   ||!cadRead&&(!Number.isSafeInteger(b.manifestElementId)||!Number.isSafeInteger(b.partIndex)||b.partIndex<0||b.partIndex>1999)
   ||result.status!=='succeeded'||result.authority!=='native-host'||result.persistent_effect!=='none'||result.native_transaction_state!=='not_applicable'
   ||result.dispatch_state!=='dispatched'||result.request_identity?.path!==op.input.path||result.operation_id!==lease.operation_id
   ||result.request_identity?.request_signature!==op.request_identity?.request_signature||!sameAssignmentBindingV2(result.binding,lease.binding)
   ||!sameAssignmentBindingV2(snapshot.current_binding,lease.binding)||snapshot.unresolved_unknown_operation_ids.length
   ||(cadRead?payload.schema!=='revit-operator.cad-geometry-target/v1':
     !['operator.vector-drafting-native-inspection.v1','operator.vector-drafting-annotation-inspection.v1'].includes(payload.schema)
     ||payload.schema==='operator.vector-drafting-annotation-inspection.v1'&&payload.renderer!==VECTOR_ANNOTATION_RENDERER
     ||payload.manifestElementId!==b.manifestElementId||payload.partIndex!==b.partIndex)
   ||payloadDigestV2(payload).digest!==result.raw_payload_hash)return null;
 }catch{return null;}
 let details:Partial<SourceProofRecord>={};
 try{
  if(cadRead){
   const prepared=await prepareVectorStrokeCadProofDetailsV2(snapshot!,snapshot!.operations[lease.operation_id]!,result!,payload!);
   if(!prepared)return null; // A retained prefix is incomplete, not a passing or failed whole-geometry claim.
   details=prepared;
  }else{
  const fresh=await reparseRegisteredVectorPlan(lease.binding.session_id,{sourcePath:payload.sourcePath,sourceSha256:payload.sourceSha256,
   nativePlanPath:payload.nativePlanPath,nativePlanFileSha256:payload.nativePlanFileSha256,nativePlanSha256:payload.nativePlanSha256},
   {context:payload.sourceContext,omissions:payload.sourceOmissions});
  const expected=fresh.plan,source=fresh.source;
  const annotation=payload.schema==='operator.vector-drafting-annotation-inspection.v1';
  const entities=annotation?draftingVectorAnnotations(expected):expected.entities;
  const partSize=annotation?VECTOR_ANNOTATION_PART_SIZE:expected.layout.partSize,parts=Math.ceil(entities.length/partSize);
  const part=entities.slice(payload.partIndex*partSize,(payload.partIndex+1)*partSize),partIds=part.map(e=>e.id);
  const matches=payload.partsTotal===parts&&payload.expectedContentCount===entities.length&&part.length>0
   &&(!annotation||(payload.sourcePlanEntityCount===expected.entities.length&&canonicalVectorJson(payload.observedSourceEntityIds)===canonicalVectorJson(partIds)));
  details={matches,sourceSha256:fresh.sourceSha256,sourcePlanSha256:source.planSha256,nativePlanSha256:expected.nativePlanSha256,
   nativePlanFileSha256:fresh.nativePlanFileSha256,partIndex:payload.partIndex,sourcePartEntityCount:part.length,
   sourceEntityCount:entities.length,partsTotal:parts,...(annotation?{renderer:VECTOR_ANNOTATION_RENDERER,sourcePlanEntityCount:expected.entities.length,sourcePartEntityIds:partIds}:{}),
   ...(!matches?{error:'Complete re-extracted PDF/native plan, source context or source counts differ.'}:{})};
  }
 }catch(error){details={matches:false,...(cadRead?{scope:VECTOR_STROKE_CAD_PROOF_SCOPE_V2}:{}),error:error instanceof Error?error.message:String(error)};}
 const record=Object.freeze({schema:'operator.vector-detail-original-source-proof.v1' as const,readOperationId:lease.operation_id,
  nativeResultId:result!.result_id,nativeRawPayloadHash:result!.raw_payload_hash,binding:Object.freeze({...lease.binding}),at:new Date().toISOString(),matches:false,
  scope:'fresh_original_pdf_reparse_and_complete_native_plan_comparison_not_native_model_or_visual_verification' as const,...details});
 try{
  const evidence=storeEvidence({scope:{...lease.binding,attempt_id:lease.operation_id},source:'operator.vector-detail-original-source-reparse.v1',
   trust_level:'host_observed',media_type:'application/json',verification_relevance:'required',raw:record,
   bounded_summary:record.matches?'Original PDF independently re-extracted; complete retained vector plan matches. Native and visual proof are separate.':'Original PDF/source-plan verification did not pass. The native edit is not replayed; inspect the retained source issue.'},4096).ref;
  const proof=Object.freeze({record,evidence:Object.freeze(evidence)});issued.add(proof);return proof;
 }catch{return null;} // Evidence failure cannot create proof or discard the native read result.
}

export function vectorSourceProofRecordV2(proof:PreparedVectorSourceProofV2|null|undefined,result:OperationResultV2):SourceProofRecord|null{
 if(!proof||!issued.has(proof)||proof.record.readOperationId!==result.operation_id||proof.record.nativeResultId!==result.result_id
  ||proof.record.nativeRawPayloadHash!==result.raw_payload_hash||!sameAssignmentBindingV2(proof.record.binding,result.binding))return null;
 try{
  const retained=JSON.parse(readAuthoritativeEvidence(proof.evidence,{...result.binding,attempt_id:result.operation_id}).toString('utf8'));
  return canonicalVectorJson(retained)===canonicalVectorJson(proof.record)?proof.record:null;
 }catch{return null;}
}

/** Presentation of existing authorities, never a new proof or completion owner.
 * Native Revit compares retained-plan content; the backend reparses the PDF.
 * Keep those scopes explicit when their results reach the working operator. */
export function vectorVerificationHandoffV2(proof:PreparedVectorSourceProofV2|null|undefined,snapshot:AssignmentSnapshotV2|null,operationId:string){
 const result=snapshot?.operations[operationId]?.result;
 const record=result?vectorSourceProofRecordV2(proof,result):null;
 if(!record||!snapshot)return null;
 const current=checkedReadIsCurrentV2(snapshot,operationId);
 return {backend_vector_verification:{
  schema:'operator.vector-verification-handoff.v1',read_operation_id:operationId,
  original_pdf_reparse:record.matches?'matched':'mismatch',source_evidence:proof!.evidence,source_scope:record.scope,
  native_part_or_cohort_current:current,
  ...(record.partIndex===undefined?{}:{part_index:record.partIndex,part_entity_count:record.sourcePartEntityCount,
    source_entity_count:record.sourceEntityCount,parts_total:record.partsTotal}),
  whole_drawing_verified:false,visual_review_required:true,
  explanation:record.matches&&current
   ? 'Backend independently reparsed the original PDF and matched the retained source plan; the separate native part or CAD cohort check is current. The native host sourceGeometryIndependentlyReparsed:false describes only that host, not the backend proof. Continue remaining parts and required geometry, text, revision omissions, sheet placement and visual checks under normal task controls. This is not whole-drawing completion.'
   : 'The backend source check and current native check are separate. One or both required checks did not pass or are no longer current; inspect retained evidence and reconcile before continuing. Do not replay a committed edit to obtain proof. No whole-drawing or visual pass is established.'
 }};
}
