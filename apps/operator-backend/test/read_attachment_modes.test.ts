import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { READ_ATTACHMENT_TOOL, readRegisteredPdfAttachment } from '../src/attachments/read_attachment.js';
import { storeAttachmentUpload } from '../src/attachments/upload_store.js';
import { McpInputValidator } from '../src/codex/mcp_input_validation.js';
import { attachmentPdf } from './pdf_attachment.fixtures.js';
import { circularLabelPdf } from './pdf_source_landmarks.fixtures.js';
function metadata(result: Awaited<ReturnType<typeof readRegisteredPdfAttachment>>, index = 0): any {
 const content = result.content[index]; assert(content && content.type === 'text'); return JSON.parse(content.text);
}
function workspace(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-overview-staged-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('operator-overview-staged-'));
  fs.rmSync(resolved,{recursive:true,force:true});});return root;
}
const upload=(data=attachmentPdf(8,true))=>storeAttachmentUpload({session_id:'owner',filename:'test.pdf',data_base64:data.toString('base64')});
test('reader schema admits explicit overview/detail and rejects invalid mode without coercion',()=>{
 const validator=new McpInputValidator();
 for(const mode of ['overview','detail'])assert.doesNotThrow(()=>validator.validate(READ_ATTACHMENT_TOOL.name,{attachment_id:'id',pages:[1],mode},[READ_ATTACHMENT_TOOL]));
 for(const mode of ['small','',1,null])assert.throws(()=>validator.validate(READ_ATTACHMENT_TOOL.name,{attachment_id:'id',pages:[1],mode},[READ_ATTACHMENT_TOOL]));
 assert.match(READ_ATTACHMENT_TOOL.description,/mode=overview/);
 assert.match(READ_ATTACHMENT_TOOL.description,/does not establish small-text review/);
 assert.match(READ_ATTACHMENT_TOOL.description,/flattened marks/);
 assert.match(READ_ATTACHMENT_TOOL.description,/Before changing the model/);
  assert.match(READ_ATTACHMENT_TOOL.description,/source filename\/hash\/page/);
  assert.match(READ_ATTACHMENT_TOOL.description,/native view ID\/name and sheet number/);
});
test('default selection preserves explicit detail pixels and metadata',async t=>{
 workspace(t);const a=upload();
 const original=await readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[6,7,8],mode:'detail'});
 const proposed=await readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[6,7,8]});
 const normalize=(r:any)=>r.content.map((c:any)=>{if(c.type!=='text')return c;const p=JSON.parse(c.text);delete p.mode;delete p.small_text_review_not_established;delete p.navigation;return {...c,text:JSON.stringify(p)};});
 assert.deepEqual(normalize(proposed),normalize(original));
});
test('overview remains bound to current upload owner and immutable bytes',async t=>{
 const root=workspace(t),a=upload();const args={attachment_id:a.id,pages:[1],mode:'overview'};
 await assert.rejects(readRegisteredPdfAttachment('other',args),/not registered/);
 const result=await readRegisteredPdfAttachment('owner',args);const h=metadata(result,0);
 assert.equal(h.sha256,a.sha256);assert.equal(h.small_text_review_not_established,true);assert.equal(h.coverage[0].text_scope,'overview_excerpts');
 fs.appendFileSync(path.join(root,a.relative_path!),'changed');await assert.rejects(readRegisteredPdfAttachment('owner',args),/changed since upload/);
});
test('region is detail-only and rotated detail retains exact source landmarks and requested geometry',async t=>{
 workspace(t);const a=upload(circularLabelPdf(90,true)),region={min_u:.2,min_v:.2,max_u:.8,max_v:.8};
 await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[1],mode:'overview',region}),/requires detail/);
 const result=await readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[1],mode:'detail',region});
 const h=metadata(result,0),page=metadata(result,1);
 assert.equal(h.coverage[0].visual_scope,'region');assert.equal(h.small_text_review_not_established,false);
 assert.deepEqual(page.image_geometry.requested_region,region);assert.equal(page.source_landmarks.items[0].label,'A');
 assert.equal(page.source,'test.pdf');assert.equal(page.attachment_id,a.id);assert.equal(page.page,1);assert.equal(page.page_count,1);
 assert.equal(page.navigation.sheet_identity,'unresolved_until_source_review');assert.match(page.navigation.coordinate_scope,/Full displayed page/);
 assert.match(page.navigation.notice,/crop-to-page transform/);
 assert.equal(page.page_geometry.rotation_degrees,90);assert.equal(page.sha256,a.sha256);
});
test('image-only overview supplies real pixels and does not infer no marks from empty text',async t=>{
 workspace(t);const a=upload(attachmentPdf(8,false));
 const result=await readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[8],mode:'overview'});
 assert.equal(result.content.filter(c=>c.type==='image').length,1);const page=metadata(result,1);
 assert.equal(page.overview.text_excerpts[0].text,'');assert.match(page.note,/Empty annotations do not mean no marks/);
});
test('invalid overview selections reject entire request rather than returning partial pages',async t=>{
 workspace(t);const a=upload();
 for(const pages of [[1,9],[1,1],[1,2,3,4]])await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages,mode:'overview'}));
 await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[1],mode:'small'}),/Mode must/);
});

test('repeated source reads retain cache-stable payloads and the same parent address across overview and crop',async t=>{
 workspace(t);const a=upload(circularLabelPdf(90,true)),region={min_u:.2,min_v:.2,max_u:.8,max_v:.8};
 const args={attachment_id:a.id,pages:[1],mode:'detail',region};
 const first=await readRegisteredPdfAttachment('owner',args),second=await readRegisteredPdfAttachment('owner',args);
 assert.deepEqual(second,first,'Immutable source/selection must not add timestamps, random IDs or reordered metadata');
 const overview=await readRegisteredPdfAttachment('owner',{attachment_id:a.id,pages:[1],mode:'overview'});
 const cropPage=metadata(first,1),overviewPage=metadata(overview,1);
 for(const field of ['source','attachment_id','sha256','page','page_count','page_geometry','navigation'])assert.deepEqual(cropPage[field],overviewPage[field],field);
 assert.equal(overviewPage.image_geometry.requested_region,null);assert.deepEqual(cropPage.image_geometry.requested_region,region);
 assert.notDeepEqual(first.content[2],overview.content[2],'Magnification changes pixels, not their parent source identity');
});
