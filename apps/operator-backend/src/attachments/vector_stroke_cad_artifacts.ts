import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {getWorkspaceRoot} from '../workspace.js';
import {readLocalWorkspaceFile} from './inline_images.js';
import {reparseRegisteredVectorPlan,type RegisteredVectorPlanRefs} from './reparse_registered_vector_plan.js';
import {canonicalVectorJson,type VectorNativePlan} from '../pdf/drafting_vector_native_plan.js';
import {compileDraftingStrokeCad} from '../pdf/drafting_curve_cad.js';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function store(relative:string,bytes:Buffer){
 if(bytes.length>64*1024*1024)throw Error('Complete source CAD artifact exceeds64MiB; no records were clipped.');
 const root=getWorkspaceRoot(),directory=path.join(root,'artifacts/drafting-vector');fs.mkdirSync(directory,{recursive:true});
 const rel=path.relative(fs.realpathSync(root),fs.realpathSync(directory));
 if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Source CAD artifact directory escapes workspace.');
 const destination=path.join(root,relative);
 try{fs.writeFileSync(destination,bytes,{flag:'wx'});}catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  const old=readLocalWorkspaceFile(destination,64*1024*1024);
  if(!old||sha(old)!==sha(bytes))throw Error('Existing immutable source CAD artifact differs; no overwrite.');
 }
 return{relative_path:relative,sha256:sha(bytes),bytes:bytes.length};
}
function descriptor(refs:RegisteredVectorPlanRefs,plan:VectorNativePlan,cad:ReturnType<typeof compileDraftingStrokeCad>){
 return{schema:'operator.vector-stroke-source.v1' as const,...refs,cadSha256:cad.dxfSha256,sourceStrokeCount:cad.selection.length,
  sourceAnnotationCount:cad.remainingEntityIds.length,viewScale:plan.layout.viewScale,importUnit:'Foot' as const};
}
/** Source-only immutable preparation shared by native-worker and Sidecar reads. */
export function storeVectorStrokeCad(refs:RegisteredVectorPlanRefs,plan:VectorNativePlan){
 const cad=compileDraftingStrokeCad(plan,refs.nativePlanSha256);
 if(refs.sourceSha256!==plan.sourceSha256)throw Error('Original PDF identity differs from the source plan.');
 const metadata=descriptor(refs,plan,cad),bytes=Buffer.from(canonicalVectorJson(metadata)),key=sha(bytes);
 const base=`artifacts/drafting-vector/strokes-${key}`;
 const artifact=store(base+'.dxf',Buffer.from(cad.dxf)),source=store(base+'.source.json',bytes);
 return{artifact,source,metadata,cad};
}
/** Reconstruct original PDF, complete native plan and every generated DXF byte.
 * Native observations, operation authority and user intent remain separate. */
export async function readReparsedVectorStrokeCad(sessionId:string,sourcePath:string,expectedCadSha256:string){
 const match=typeof sourcePath==='string'?/^artifacts\/drafting-vector\/strokes-([a-f0-9]{64})\.dxf$/.exec(sourcePath):null;
 if(!match||!/^[a-f0-9]{64}$/.test(expectedCadSha256))throw Error('Content-addressed source CAD path and expected SHA256 required.');
 const sourceRef=sourcePath.replace(/\.dxf$/,'.source.json'),bytes=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),sourceRef),64*1024);
 if(!bytes||sha(bytes)!==match[1])throw Error('Immutable CAD source descriptor is missing or its full bytes changed.');
 const metadata=JSON.parse(bytes.toString('utf8'));
 const refs:RegisteredVectorPlanRefs={sourcePath:metadata.sourcePath,sourceSha256:metadata.sourceSha256,nativePlanPath:metadata.nativePlanPath,
  nativePlanFileSha256:metadata.nativePlanFileSha256,nativePlanSha256:metadata.nativePlanSha256};
 const fresh=await reparseRegisteredVectorPlan(sessionId,refs),cad=compileDraftingStrokeCad(fresh.plan,refs.nativePlanSha256);
 if(canonicalVectorJson(metadata)!==canonicalVectorJson(descriptor(refs,fresh.plan,cad))||cad.dxfSha256!==expectedCadSha256)
  throw Error('Complete original PDF/native plan/source CAD descriptor differs.');
 const actual=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),sourcePath),64*1024*1024);
 if(!actual||sha(actual)!==expectedCadSha256||!actual.equals(Buffer.from(cad.dxf)))throw Error('Complete CAD bytes differ from fresh original-PDF compilation.');
 return{...fresh,cad,descriptor:metadata,sourceDescriptorPath:sourceRef,cadPath:sourcePath};
}
