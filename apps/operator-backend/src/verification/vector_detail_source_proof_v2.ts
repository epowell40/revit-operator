import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readRegisteredAttachmentSource} from '../attachments/registered_attachment_source.js';
import {findSessionUploadBySource} from '../attachments/upload_index.js';
import {readLocalWorkspaceFile} from '../attachments/inline_images.js';
import {getWorkspaceRoot} from '../workspace.js';
import {buildPdfJsDocumentOptions,loadPdfJsForNode} from '../pdf/pdfjs_node.js';
import {inspectDraftingVectorSource,type PaperRegion,type SourceOmission} from '../pdf/drafting_vector_source.js';
import {compileDraftingVectorNativePlan,canonicalVectorJson,type VectorNativeLayout} from '../pdf/drafting_vector_native_plan.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {sameAssignmentBindingV2,type AssignmentBindingV2,type AssignmentSnapshotV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {explicitMcpEnvelope} from '../assignments/native_observation_inputs_v2.js';
import {storeEvidence,readAuthoritativeEvidence} from '../evidence/evidence_store.js';
import type {EvidenceRefV1} from '../evidence/evidence_ref.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const issued=new WeakSet<object>();
type SourceProofRecord=Readonly<{
 schema:'operator.vector-detail-original-source-proof.v1';readOperationId:string;nativeResultId:string;nativeRawPayloadHash:string;
 binding:AssignmentBindingV2;at:string;matches:boolean;sourceSha256?:string;sourcePlanSha256?:string;nativePlanSha256?:string;
 nativePlanFileSha256?:string;partIndex?:number;sourcePartEntityCount?:number;sourceEntityCount?:number;partsTotal?:number;error?:string;
 scope:'fresh_original_pdf_reparse_and_complete_native_plan_comparison_not_native_model_or_visual_verification';
}>;
export type PreparedVectorSourceProofV2=Readonly<{record:SourceProofRecord;evidence:EvidenceRefV1}>;
type Lease={operation_id:string;binding:AssignmentBindingV2;assignment_id:string};

/** Backend-owned source check, separate from both the working model and its native receipt.
 * Its opaque result cannot be supplied by a provider, MCP producer, or caller assertion. */
export async function prepareVectorSourceProofV2(lease:Lease,rawResult:unknown,snapshot:AssignmentSnapshotV2|null):Promise<PreparedVectorSourceProofV2|null>{
 let result:OperationResultV2,payload:Record<string,any>;
 try{
  const envelope=explicitMcpEnvelope(rawResult);result=envelope.operation_result_v2;payload=object(envelope.observation?.raw_payload);
  const op=snapshot?.operations[lease.operation_id],b=object(op?.input.body);
  if(!snapshot||!op||op.input.path!=='/revit/inspect-vector-detail'||op.input.method!=='POST'||op.requested_effect!=='read'
   ||!Number.isSafeInteger(b.manifestElementId)||!Number.isSafeInteger(b.partIndex)||b.partIndex<0||b.partIndex>1999
   ||result.status!=='succeeded'||result.authority!=='native-host'||result.persistent_effect!=='none'||result.native_transaction_state!=='not_applicable'
   ||result.dispatch_state!=='dispatched'||result.request_identity?.path!=='/revit/inspect-vector-detail'||result.operation_id!==lease.operation_id
   ||result.request_identity.request_signature!==op.request_identity?.request_signature||!sameAssignmentBindingV2(result.binding,lease.binding)
   ||!sameAssignmentBindingV2(snapshot.current_binding,lease.binding)||snapshot.unresolved_unknown_operation_ids.length
   ||payload.schema!=='operator.vector-drafting-native-inspection.v1'||payload.manifestElementId!==b.manifestElementId||payload.partIndex!==b.partIndex
   ||payloadDigestV2(payload).digest!==result.raw_payload_hash)return null;
 }catch{return null;}
 let details:Partial<SourceProofRecord>={};
 try{
  if(typeof payload.sourcePath!=='string'||!/^artifacts\/uploads\/[^/\\]+$/.test(payload.sourcePath)||!/^artifacts\/drafting-vector\/source-[a-f0-9]{64}\.json\.gz$/.test(payload.nativePlanPath))throw Error('Registered original PDF and immutable native plan paths required.');
  const upload=findSessionUploadBySource(lease.binding.session_id,payload.sourcePath,payload.sourceSha256);
  if(!upload?.id)throw Error('Original PDF is not registered in this conversation. Attach the original PDF to verify this retained detail.');
  const original=readRegisteredAttachmentSource(lease.binding.session_id,upload.id);
  if(original.bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('Original registered source is not a PDF.');
  const packed=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),payload.nativePlanPath),64*1024*1024);
  if(!packed||hash(packed)!==payload.nativePlanFileSha256)throw Error('Retained native plan bytes differ from the native inspection.');
  const retained=JSON.parse(gunzipSync(packed,{maxOutputLength:64*1024*1024}).toString('utf8'));
  const context=object(payload.sourceContext),layout=object(context.layout);
  const options:VectorNativeLayout={paperWidthInches:layout.paperWidthInches,viewScale:layout.viewScale,partSize:layout.partSize,
   ...(layout.fontMap!=null?{fontMap:layout.fontMap}:{}),...(layout.lineWeightMap!=null?{lineWeightMap:layout.lineWeightMap}:{})};
  const pdfjs=await loadPdfJsForNode(),doc=await pdfjs.getDocument({...buildPdfJsDocumentOptions(new Uint8Array(original.bytes)),isEvalSupported:false}).promise;
  let label:string|null=null;
  try{if(!Number.isSafeInteger(context.page)||context.page<1||context.page>doc.numPages)throw Error('Source page is outside the original PDF.');label=(await doc.getPageLabels())?.[context.page-1]??null;}finally{await doc.destroy();}
  const source=await inspectDraftingVectorSource(new Uint8Array(original.bytes),{expectedSourceSha256:original.sha256,page:context.page,
   sourceLabel:original.record.filename||path.basename(original.relativePath),...(label?{sourceSheet:label}:{}),region:context.region as PaperRegion});
  const expected=compileDraftingVectorNativePlan(source,source.planSha256,options,payload.sourceOmissions as SourceOmission[]);
  // Also bind the complete actual artifact. An unchanged embedded SHA string inside
  // a tampered plan is never proof that its geometry still matches the source.
  const matches=canonicalVectorJson(expected)===canonicalVectorJson(retained)&&expected.nativePlanSha256===payload.nativePlanSha256
   &&source.planSha256===context.sourcePlanSha256&&expected.selectionSha256===context.selectionSha256
   &&source.sourceLabel===context.sourceLabel&&source.sourceSheet===context.sourceSheet&&original.sha256===payload.sourceSha256
   &&payload.partsTotal===expected.partCount&&payload.expectedContentCount===expected.entities.length;
  if(readRegisteredAttachmentSource(lease.binding.session_id,upload.id).sha256!==original.sha256)throw Error('Original PDF changed during source verification.');
  details={matches,sourceSha256:original.sha256,sourcePlanSha256:source.planSha256,nativePlanSha256:expected.nativePlanSha256,
   nativePlanFileSha256:hash(packed),partIndex:payload.partIndex,sourcePartEntityCount:expected.entities.slice(payload.partIndex*expected.layout.partSize,(payload.partIndex+1)*expected.layout.partSize).length,
   sourceEntityCount:expected.entities.length,partsTotal:expected.partCount,...(!matches?{error:'Complete re-extracted PDF/native plan, source context or source counts differ.'}:{})};
 }catch(error){details={matches:false,error:error instanceof Error?error.message:String(error)};}
 const record=Object.freeze({schema:'operator.vector-detail-original-source-proof.v1' as const,readOperationId:lease.operation_id,
  nativeResultId:result!.result_id,nativeRawPayloadHash:result!.raw_payload_hash,binding:Object.freeze({...lease.binding}),at:new Date().toISOString(),matches:false,...details,
  scope:'fresh_original_pdf_reparse_and_complete_native_plan_comparison_not_native_model_or_visual_verification' as const});
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
