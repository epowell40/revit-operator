import type {AssignmentSnapshotV2,OperationV2,OperationResultV2} from '../domain/assignment-kernel/index.js';
import {vectorStrokeCadPageChainV2,settledVectorStrokeCadImportV2,VECTOR_STROKE_CAD_RENDERER_V2} from './vector_stroke_cad_readback_v2.js';
import {readReparsedVectorStrokeCad} from '../attachments/vector_stroke_cad_artifacts.js';
import {compareDraftingStrokeCadNativePages} from './drafting_stroke_cad_geometry.js';

export const VECTOR_STROKE_CAD_PROOF_SCOPE_V2='fresh_original_pdf_and_complete_native_cad_stroke_geometry_not_text_styles_visuals_or_whole_drawing';
export type VectorStrokeCadProofDetailsV2=Readonly<{
 applyOperationId:string;importElementId:number;importUniqueId:string;viewId:number;viewUniqueId:string;
 cadSha256:string;nativeSnapshotSha256:string;nativePageCount:number;sourceStrokeCount:number;nativePrimitiveCount:number;geometryMatches:boolean;
}>;
/** Returns data only. The existing vector-proof owner retains and issues the opaque evidence. */
export async function prepareVectorStrokeCadProofDetailsV2(s:AssignmentSnapshotV2,read:OperationV2,result:OperationResultV2,payload:Record<string,any>){
 const apply=s.operations[read.verification_of_operation_id??''];if(!apply)return null;
 if(!settledVectorStrokeCadImportV2(s,apply))return null;
 const chain=vectorStrokeCadPageChainV2(s,apply,{operation:read,result,payload});
 if(!chain)throw Error('Native CAD page identity, freshness, order or completeness differs. Retain the committed import; inspect existing reads before correction.');
 if(!chain?.terminal||!chain.viewUniqueId||!chain.snapshot)return null;
 const fresh=await readReparsedVectorStrokeCad(read.binding.session_id,chain.wanted.sourcePath,chain.wanted.expectedSourceSha256);
 const comparison=compareDraftingStrokeCadNativePages({plan:fresh.plan,expectedPlanSha256:fresh.plan.nativePlanSha256,
  viewId:chain.applied.viewId,viewUniqueId:chain.viewUniqueId,importElementId:chain.applied.elementId,importUniqueId:chain.applied.elementUniqueId,
  nativeReads:chain.pages.map(p=>p.payload)});
 const cad:VectorStrokeCadProofDetailsV2={applyOperationId:apply.operation_id,importElementId:chain.applied.elementId,importUniqueId:chain.applied.elementUniqueId,
  viewId:chain.applied.viewId,viewUniqueId:chain.viewUniqueId,cadSha256:fresh.cad.dxfSha256,nativeSnapshotSha256:chain.snapshot,
  nativePageCount:chain.pages.length,sourceStrokeCount:fresh.cad.selection.length,nativePrimitiveCount:comparison.nativePrimitiveCount,geometryMatches:comparison.geometryMatches};
 return{matches:comparison.geometryMatches,renderer:VECTOR_STROKE_CAD_RENDERER_V2,sourceSha256:fresh.sourceSha256,
  sourcePlanSha256:fresh.source.planSha256,nativePlanSha256:fresh.plan.nativePlanSha256,nativePlanFileSha256:fresh.nativePlanFileSha256,
  sourceEntityCount:fresh.cad.selection.length,sourcePlanEntityCount:fresh.plan.entities.length,cad,
  scope:VECTOR_STROKE_CAD_PROOF_SCOPE_V2 as typeof VECTOR_STROKE_CAD_PROOF_SCOPE_V2,...(!comparison.geometryMatches?{error:comparison.issues.join(' ').slice(0,1500)}:{})};
}
