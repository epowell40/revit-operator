import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';
import test from 'node:test';import assert from 'node:assert/strict';
import {readRegisteredPdfAttachment,READ_ATTACHMENT_TOOL} from '../src/attachments/read_attachment.js';
import {storeAttachmentUpload} from '../src/attachments/upload_store.js';
import {readReparsedVectorStrokeCad} from '../src/attachments/vector_stroke_cad_artifacts.js';
import {canonicalVectorJson} from '../src/pdf/drafting_vector_native_plan.js';
import {McpInputValidator} from '../src/codex/mcp_input_validation.js';
import {attachmentPdf} from './pdf_attachment.fixtures.js';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function workspace(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-stroke-cad-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;t.after(()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});});return root;}
async function fixture(root:string,pdf=attachmentPdf(1),name='detail.pdf'){
 const upload=storeAttachmentUpload({session_id:'owner',filename:name,data_base64:pdf.toString('base64')});
 const read=async(args:unknown)=>{const response=await readRegisteredPdfAttachment('owner',args);return JSON.parse((response.content[0]as {text:string}).text);};
 const base={attachment_id:upload.id,mode:'vector',pages:[1]},summary=await read(base),request={...base,vector_section:'stroke_cad',expected_plan_sha256:summary.plan_sha256,
  native_layout:{paperWidthInches:4,viewScale:100,partSize:50}},prepared=await read(request);
 const readBack=()=>readReparsedVectorStrokeCad('owner',prepared.stroke_cad_artifact.relative_path,prepared.stroke_cad_artifact.sha256);
 return{root,upload,read,base,request,prepared,readBack};
}
test('registered stroke preparation retains whole vectors, native annotations and source context without placing geometry into provider context',async t=>{
 const f=await fixture(workspace(t)),p=f.prepared;new McpInputValidator().validate(READ_ATTACHMENT_TOOL.name,f.request,[READ_ATTACHMENT_TOOL]);
 assert.equal(p.stroke_cad_summary.source_strokes,1);assert.equal(p.stroke_cad_summary.remaining_annotations,1);assert.equal(p.native_annotation_summary.entities,1);
 assert.equal(p.stroke_cad_summary.whole_drawing_verified,false);assert.equal(p.native_write_allowed,false);assert.equal(p.native_import_available,false);
 assert.equal(p.source,'detail.pdf');assert.equal(p.page,1);assert.deepEqual(p.region,[0,0,200,200]);
 assert.equal(p.cad_import_inputs.expectedSourceSha256,p.stroke_cad_artifact.sha256);assert.equal(p.cad_import_inputs.link,false);
 assert.equal(p.cad_import_inputs.placement,'origin');assert.equal(p.cad_import_inputs.importUnit,'Foot');assert.equal(p.cad_import_inputs.autoCorrectAlmostVHLines,false);
 assert.equal(p.cad_import_requires.required_view_scale,100);assert.equal(p.cad_import_requires.exact_existing_drafting_view,true);
 assert(!('dxf'in p));assert(!('selection'in p));assert(!('entities'in p));assert(Buffer.byteLength(JSON.stringify(p))<12000);
 const restored=await f.readBack();assert.equal(restored.plan.entities.length,2);assert.equal(restored.cad.selection.length,1);
 assert.equal(restored.cad.remainingEntityIds.length,1);assert.equal(restored.sourceSha256,f.upload.sha256);
 assert.deepEqual((await f.read(f.request)).stroke_cad_artifact,p.stroke_cad_artifact);
 const next=await f.read({...f.request,vector_offset:1,vector_limit:1});assert.deepEqual(next.stroke_cad_style_page.items,[]);assert.equal(next.stroke_cad_style_page.nextOffset,null);
 await assert.rejects(f.read({...f.request,vector_offset:2}),/style cursor/);
 await assert.rejects(f.read({...f.request,vector_filter_region:{min_u:0,min_v:0,max_u:1,max_v:1}}),/layer-style paging/);
});
test('identical source strokes with different PDF text retain distinct source descriptors and cannot collide',async t=>{
 const root=workspace(t),a=await fixture(root),pdf=Buffer.from(attachmentPdf(1).toString('latin1').replace('Fixture page 1','Fixture page X'),'latin1');
 const b=await fixture(root,pdf,'another-detail.pdf');assert.equal(a.prepared.stroke_cad_artifact.sha256,b.prepared.stroke_cad_artifact.sha256);
 assert.notEqual(a.prepared.stroke_cad_artifact.relative_path,b.prepared.stroke_cad_artifact.relative_path);
 assert.notEqual(a.prepared.stroke_cad_source_descriptor.sha256,b.prepared.stroke_cad_source_descriptor.sha256);
 assert.equal((await a.readBack()).plan.entities[1].text,'Fixture page 1');assert.equal((await b.readBack()).plan.entities[1].text,'Fixture page X');
});
for(const variant of ['changed_cad','changed_descriptor','changed_original','foreign_conversation','wrong_expected_cad_hash','resealed_wrong_plan','forged_completion']as const)
test('original PDF/source-CAD boundary rejects '+variant,async t=>{
 const root=workspace(t),f=await fixture(root),p=f.prepared;let cadPath=p.stroke_cad_artifact.relative_path,expected=p.stroke_cad_artifact.sha256;
 if(variant==='changed_cad')fs.appendFileSync(path.join(root,cadPath),'changed bytes');
 if(variant==='changed_descriptor')fs.appendFileSync(path.join(root,p.stroke_cad_source_descriptor.relative_path),' ');
 if(variant==='changed_original')fs.appendFileSync(path.join(root,f.upload.relative_path!),'changed bytes');
 if(variant==='wrong_expected_cad_hash')expected='f'.repeat(64);
 if(variant==='resealed_wrong_plan'||variant==='forged_completion'){
  const meta=JSON.parse(fs.readFileSync(path.join(root,p.stroke_cad_source_descriptor.relative_path),'utf8'));
  if(variant==='resealed_wrong_plan'){
   const plan=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,meta.nativePlanPath))).toString());plan.entities[0].points[1][0]+=1;
   const{nativePlanSha256,...unsigned}=plan;plan.nativePlanSha256=sha(Buffer.from(canonicalVectorJson(unsigned)));
   const raw=Buffer.from(JSON.stringify(plan)),packed=gzipSync(raw);meta.nativePlanPath=`artifacts/drafting-vector/source-${sha(raw)}.json.gz`;
   fs.writeFileSync(path.join(root,meta.nativePlanPath),packed);meta.nativePlanFileSha256=sha(packed);meta.nativePlanSha256=plan.nativePlanSha256;
  }else meta.verified=true;
  const bytes=Buffer.from(canonicalVectorJson(meta)),key=sha(bytes);cadPath=`artifacts/drafting-vector/strokes-${key}.dxf`;
  fs.writeFileSync(path.join(root,cadPath),fs.readFileSync(path.join(root,p.stroke_cad_artifact.relative_path)));
  fs.writeFileSync(path.join(root,cadPath.replace(/\.dxf$/,'.source.json')),bytes);
 }
 await assert.rejects(readReparsedVectorStrokeCad(variant==='foreign_conversation'?'another-owner':'owner',cadPath,expected));
 if(variant==='changed_cad'||variant==='changed_descriptor'){
  const file=path.join(root,variant==='changed_cad'?cadPath:p.stroke_cad_source_descriptor.relative_path),before=fs.readFileSync(file);
  await assert.rejects(f.read(f.request),/no overwrite/);assert.deepEqual(fs.readFileSync(file),before);
 }
});
