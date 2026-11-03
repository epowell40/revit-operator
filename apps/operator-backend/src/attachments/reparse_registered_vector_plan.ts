import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readRegisteredAttachmentSource} from './registered_attachment_source.js';
import {findSessionUploadBySource} from './upload_index.js';
import {readLocalWorkspaceFile} from './inline_images.js';
import {getWorkspaceRoot} from '../workspace.js';
import {buildPdfJsDocumentOptions,loadPdfJsForNode} from '../pdf/pdfjs_node.js';
import {inspectDraftingVectorSource,type PaperRegion,type SourceOmission} from '../pdf/drafting_vector_source.js';
import {compileDraftingVectorNativePlan,canonicalVectorJson,type VectorNativeLayout} from '../pdf/drafting_vector_native_plan.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const isHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export type RegisteredVectorPlanRefs={sourcePath:string;sourceSha256:string;nativePlanPath:string;nativePlanFileSha256:string;nativePlanSha256:string};

/** Re-read registered original bytes and reconstruct the entire retained plan.
 * This returns source data, never native-model authority or a verification fact. */
export async function reparseRegisteredVectorPlan(sessionId:string,refs:RegisteredVectorPlanRefs,claim?:{context:unknown;omissions:unknown}){
 if(typeof refs.sourcePath!=='string'||!/^artifacts\/uploads\/[^/\\\r\n]+$/.test(refs.sourcePath)
  ||typeof refs.nativePlanPath!=='string'||!/^artifacts\/drafting-vector\/source-[a-f0-9]{64}\.json\.gz$/.test(refs.nativePlanPath)
  ||![refs.sourceSha256,refs.nativePlanFileSha256,refs.nativePlanSha256].every(isHash))throw Error('Registered original PDF and immutable native plan paths/hashes required.');
 const upload=findSessionUploadBySource(sessionId,refs.sourcePath,refs.sourceSha256);
 if(!upload?.id)throw Error('Original PDF is not registered in this conversation. Attach the original PDF to verify this retained detail.');
 const original=readRegisteredAttachmentSource(sessionId,upload.id);
 if(original.bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('Original registered source is not a PDF.');
 const packed=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),refs.nativePlanPath),64*1024*1024);
 if(!packed||hash(packed)!==refs.nativePlanFileSha256)throw Error('Retained native plan bytes differ from the inspected source.');
 const unpacked=gunzipSync(packed,{maxOutputLength:64*1024*1024});
 if(path.basename(refs.nativePlanPath)!==`source-${hash(unpacked)}.json.gz`)throw Error('Immutable native plan content address differs from its complete bytes.');
 const retained=JSON.parse(unpacked.toString('utf8'));
 const context=claim?object(claim.context):{sourcePlanSha256:retained.sourcePlanSha256,selectionSha256:retained.selectionSha256,
  sourceLabel:retained.sourceLabel,sourceSheet:retained.sourceSheet,page:retained.page,region:retained.region,layout:retained.layout};
 const layout=object(context.layout),omissions=claim?claim.omissions:retained.omissions;
 const options:VectorNativeLayout={paperWidthInches:layout.paperWidthInches,viewScale:layout.viewScale,partSize:layout.partSize,
  ...(layout.fontMap!=null?{fontMap:layout.fontMap}:{}),...(layout.lineWeightMap!=null?{lineWeightMap:layout.lineWeightMap}:{})};
 const pdfjs=await loadPdfJsForNode(),doc=await pdfjs.getDocument({...buildPdfJsDocumentOptions(new Uint8Array(original.bytes)),isEvalSupported:false}).promise;
 let label:string|null=null;
 try{if(!Number.isSafeInteger(context.page)||context.page<1||context.page>doc.numPages)throw Error('Source page is outside the original PDF.');label=(await doc.getPageLabels())?.[context.page-1]??null;}finally{await doc.destroy();}
 const source=await inspectDraftingVectorSource(new Uint8Array(original.bytes),{expectedSourceSha256:original.sha256,page:context.page,
  sourceLabel:original.record.filename||path.basename(original.relativePath),...(label?{sourceSheet:label}:{}),region:context.region as PaperRegion});
 const plan=compileDraftingVectorNativePlan(source,source.planSha256,options,omissions as SourceOmission[]);
 if(canonicalVectorJson(plan)!==canonicalVectorJson(retained)||plan.nativePlanSha256!==refs.nativePlanSha256
  ||source.planSha256!==context.sourcePlanSha256||plan.selectionSha256!==context.selectionSha256
  ||source.sourceLabel!==context.sourceLabel||source.sourceSheet!==context.sourceSheet||original.sha256!==refs.sourceSha256)
  throw Error('Complete re-extracted original PDF/native plan or source context differs.');
 if(readRegisteredAttachmentSource(sessionId,upload.id).sha256!==original.sha256)throw Error('Original PDF changed during source verification.');
 return{plan,source,nativePlanFileSha256:hash(packed),sourcePath:original.relativePath,sourceSha256:original.sha256};
}
