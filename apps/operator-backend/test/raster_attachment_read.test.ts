import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';import {createCanvas,loadImage} from '@napi-rs/canvas';
import {readRegisteredPdfAttachment} from '../src/attachments/read_attachment.js';
import {storeAttachmentUpload} from '../src/attachments/upload_store.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
import {pathToFileURL} from 'node:url';
function setup(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'raster-read-')),before=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;t.after(()=>{if(before===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=before;fs.rmSync(root,{recursive:true,force:true});});return root;}
function source(){const c=createCanvas(400,200),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,400,200);x.fillStyle='red';x.fillRect(200,50,100,100);return c.toBuffer('image/png');}
test('registered PNG source crop reaches actual model image adapter with exact source and transform',async t=>{
 setup(t);const bytes=source(),u=storeAttachmentUpload({session_id:'owner',filename:'reference.png',data_base64:bytes.toString('base64')});
 const region={min_u:.5,min_v:.25,max_u:.75,max_v:.75};const r=await readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1],mode:'detail',region});
 const a=adaptMcpToolCallResultToDynamicResponse(r),summary=JSON.parse(a.contentItems.find(x=>x.type==='inputText')!.text),images=a.contentItems.filter(x=>x.type==='inputImage');
 assert.equal(images.length,1);assert.equal(summary.source_media_type,'image/png');assert.equal(summary.sha256,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(summary.fully_rendered_pages,[]);assert.equal(summary.coverage[0].visual_scope,'region');
 const page=JSON.parse(a.contentItems.filter(x=>x.type==='inputText')[1]!.text);assert.equal(page.extracted_text,null);assert.equal(page.source_landmarks.status,'not_extracted');assert.deepEqual(page.image_geometry.requested_region,region);assert.equal(page.image_geometry.pixel_to_normalized_page.u_offset,.5);
 const image=await loadImage(images[0]!.imageUrl);assert.equal(image.width,100);assert.equal(image.height,100);const c=createCanvas(100,100),ctx=c.getContext('2d');ctx.drawImage(image,0,0);assert.deepEqual([...ctx.getImageData(50,50,1,1).data],[255,0,0,255]);
 const whole=await readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1],mode:'overview'});const nav=JSON.parse(whole.content[0]!.type==='text'?whole.content[0].text:'{}');assert.deepEqual(nav.fully_rendered_pages,[1]);assert.equal(nav.small_text_review_not_established,true);
 await assert.rejects(readRegisteredPdfAttachment('other',{attachment_id:u.id,pages:[1]}),/not registered/);
 await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[2]}),/page 1/);
 await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1],mode:'overview',region}),/detail mode/);
 const ui=[path.resolve('../packages/operator-assistant-ui'),path.resolve('../../packages/operator-assistant-ui')].find(p=>fs.existsSync(path.join(p,'visual_work_review.mjs')));assert(ui);
 const {resolveAttachmentReviewImage}=await import(pathToFileURL(path.join(ui,'visual_work_review.mjs')).href);
 const selection={call_id:'call_crop',page:1},fixture={attachments:[{id:u.id,filename:u.filename,mime:'image/png',dataBase64:bytes.toString('base64')}],receipts:[{call_id:'call_crop',tool_name:'native__operator_read_attachment',status:'success',arguments:{attachment_id:u.id,pages:[1],mode:'detail',region},result:{ok:true,content:a.contentItems}}]};
 const resolved=resolveAttachmentReviewImage(selection,fixture);assert.equal(resolved.image_url,images[0]!.imageUrl);assert.equal(resolved.source_render.source_sha256,u.sha256);assert.deepEqual(resolved.source_render.requested_region,region);assert.equal(resolved.source_render.width_px,100);
 const restored=resolveAttachmentReviewImage(selection,{...fixture,attachments:[],registeredAttachmentIds:[u.id]});assert.equal(restored.image_url,resolved.image_url);
 for(const problem of ['foreign-call','changed-bytes','failed-read','wrong-mime','unregistered']){const f=structuredClone(fixture);if(problem==='foreign-call')f.receipts[0]!.call_id='other';if(problem==='changed-bytes')f.attachments[0]!.dataBase64=source().subarray(0,30).toString('base64');if(problem==='failed-read')f.receipts[0]!.status='failed';if(problem==='wrong-mime')f.attachments[0]!.mime='application/pdf';if(problem==='unregistered')f.attachments=[];assert.throws(()=>resolveAttachmentReviewImage(selection,f),Error,problem);}
});
test('PNG reader refuses malformed headers, excessive decoded dimensions, invalid regions and changed sources',async t=>{
 const root=setup(t),original=source();
 for(const [name,bytes] of [['short',original.subarray(0,20)],['dimensions',Buffer.from(original)]] as const){if(name==='dimensions')bytes.writeUInt32BE(100000,16);const u=storeAttachmentUpload({session_id:'owner',filename:name+'.png',data_base64:bytes.toString('base64')});await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1]}),/Invalid PNG|pixel budget/);}
 const u=storeAttachmentUpload({session_id:'owner',filename:'test.png',data_base64:original.toString('base64')});
 for(const region of [{min_u:0,min_v:0,max_u:0,max_v:1},{min_u:-1,min_v:0,max_u:1,max_v:1},{min_u:0,min_v:0,max_u:1,max_v:1,path:'other'}])await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1],region}),/Region|region/);
 fs.appendFileSync(path.join(root,u.relative_path!),'changed');await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1]}),/changed since upload/);
});
