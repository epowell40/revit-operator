import fs from 'node:fs';import path from 'node:path';import {gunzipSync} from 'node:zlib';
import {storeAttachmentUpload} from '../src/attachments/upload_store.js';
import {readRegisteredPdfAttachment} from '../src/attachments/read_attachment.js';

export function vectorPdfFixture(){
 const stream=Array.from({length:120},(_,i)=>`${i+10} 10 m ${i+10} 20 l S`).join('\n')+'\nBT /F1 12 Tf 10 180 Td (Example diagram) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(pdf);
}
export async function vectorImportFixture(root:string,session='vector-session',partIndex=0){
 const attachment=storeAttachmentUpload({session_id:session,filename:'detail.pdf',data_base64:vectorPdfFixture().toString('base64')});
 const read=async(a:unknown)=>{const first=(await readRegisteredPdfAttachment(session,a)).content[0];if(first?.type!=='text')throw Error('Expected complete vector source text result.');return JSON.parse(first.text);};
 const base={attachment_id:attachment.id,mode:'vector',pages:[1]},summary=await read(base);
 const prepared=await read({...base,vector_section:'native_plan',expected_plan_sha256:summary.plan_sha256,native_layout:{paperWidthInches:4,viewScale:100,partSize:50}});
 const plan=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,prepared.native_plan_artifact.relative_path))).toString());
 const count=plan.entities.slice(partIndex*50,(partIndex+1)*50).length,created=Array.from({length:count},(_,i)=>1000+partIndex*50+i);
 const added=partIndex===0?[20,30,...created]:created,modified=partIndex===0?[]:[20,30],affected=[...added,...modified].map(id=>'element_id:'+id).sort();
 const input={method:'POST',path:'/revit/import-vector-detail',body:{...prepared.native_import_inputs,viewName:'Example diagram',partIndex,
  ...(partIndex>0?{manifestElementId:30,expectedImportSnapshotSha256:'b'.repeat(64)}:{})}};
 const applied={status:'Success',applied:true,sourcePath:attachment.relative_path,sourceSha256:attachment.sha256,nativePlanSha256:plan.nativePlanSha256,
  nativePlanFileSha256:prepared.native_plan_artifact.sha256,manifestElementId:30,viewId:20,viewName:'Example diagram',partIndex,partsTotal:plan.partCount,
  completedParts:partIndex+1,remainingPartIndices:Array.from({length:plan.partCount-partIndex-1},(_,i)=>partIndex+i+1),nextPartIndex:partIndex+1<plan.partCount?partIndex+1:null,
  createdEntityIds:created,createdContentCount:count,importSnapshotSha256:'c'.repeat(64),partNativeSnapshotSha256:'d'.repeat(64),
  transaction:{status:'committed',committed:true,added_element_ids:added,modified_element_ids:modified,deleted_element_ids:[]},changeTracking:{exhaustiveChangeInventory:true}};
 const readInput={method:'POST',path:'/revit/inspect-vector-detail',body:{manifestElementId:30,partIndex}};
 const nativeRead={schema:'operator.vector-drafting-native-inspection.v1',read_only:true,manifestElementId:30,viewId:20,viewName:'Example diagram',
  sourcePath:attachment.relative_path,sourceSha256:attachment.sha256,nativePlanSha256:plan.nativePlanSha256,nativePlanFileSha256:prepared.native_plan_artifact.sha256,
  nativePlanPath:prepared.native_plan_artifact.relative_path,sourceContext:{sourcePlanSha256:plan.sourcePlanSha256,selectionSha256:plan.selectionSha256,sourceLabel:plan.sourceLabel,
   sourceSheet:plan.sourceSheet,page:plan.page,region:plan.region,layout:{...plan.layout,fontMap:null,lineWeightMap:null}},sourceOmissions:plan.omissions,
  sourceFileCurrent:true,sourceFileError:null,nativeSnapshotMatchesImport:true,snapshotError:null,importSnapshotSha256:'c'.repeat(64),
  partIndex,partNativeSnapshotSha256:'d'.repeat(64),expectedContentCount:plan.entities.length,partsTotal:plan.partCount,
  completedPartIndices:Array.from({length:partIndex+1},(_,i)=>i),remainingPartIndices:applied.remainingPartIndices,observedEntityIds:created,totalPartContent:count,
  sourceProjection:{schema:'operator.vector-drafting-native-projection.v1',completePartRead:true,sourceNativeProjectionMatches:true,sourceEntityCount:count,nativeEntitiesInspected:count,issueCount:0,issueListTruncated:false}};
 return{attachment,prepared,plan,input,applied,readInput,nativeRead,affected};
}
