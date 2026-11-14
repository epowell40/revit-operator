import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as review from './visual_work_review.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC';
function fixture(){
 const summary={source:'reference.png',attachment_id:'source',sha256:createHash('sha256').update(Buffer.from(image,'base64')).digest('hex'),source_kind:'raster_image',source_format:'png',page_count:1,pages_returned:[1],mode:'detail',coverage:[{page:1,visual_scope:'full_page',image_bytes:Buffer.from(image,'base64').length}]};
 return {attachments:[],registeredAttachmentIds:['source'],receipts:[{call_id:'call_source',tool_name:'native__operator_read_attachment',status:'success',arguments:{attachment_id:'source',pages:[1],mode:'detail'},result:{ok:true,content:[{type:'inputText',text:JSON.stringify(summary)},{type:'inputImage',imageUrl:'data:image/png;base64,'+image}]}}]};
}
test('recovered filename resolves already delivered registered full raster without another read',()=>{
 const f=fixture(),r=review.resolveNamedReferenceImage('reference.png',f);
 assert.equal(r.image_url,'data:image/png;base64,'+image);
 assert.equal(r.source_render.source_read_call_id,'call_source');
 assert.equal(r.source_render.source_identity_basis,'current_registered_attachment_read');
});
test('filename recovery cannot silently use a crop, foreign source or failed read',()=>{
 for(const mutate of [f=>f.registeredAttachmentIds=[],f=>f.receipts[0].status='error',f=>f.receipts[0].arguments.region={min_u:0,min_v:0,max_u:0.5,max_v:0.5},f=>f.receipts[0].tool_name='other']){
  const f=fixture();mutate(f);assert.throws(()=>review.resolveNamedReferenceImage('reference.png',f));
 }
});
test('conflicting present attachment never falls back to historical pixels',()=>{
 const f=fixture();f.attachments=[{id:'source',filename:'reference.png',isImage:true,mime:'image/png',dataBase64:''}];
 assert.throws(()=>review.resolveNamedReferenceImage('reference.png',f));
});
test('duplicate full reads reuse same immutable source; ambiguous source names refuse',()=>{
 const f=fixture();f.receipts.push({...structuredClone(f.receipts[0]),call_id:'call_again'});
 assert.equal(review.resolveNamedReferenceImage('reference.png',f).source_render.source_read_call_id,'call_again');
 const r=f.receipts[1],s=JSON.parse(r.result.content[0].text);s.attachment_id='second';s.sha256='b'.repeat(64);r.arguments.attachment_id='second';r.result.content[0].text=JSON.stringify(s);f.registeredAttachmentIds.push('second');
 assert.throws(()=>review.resolveNamedReferenceImage('reference.png',f),/ambiguous/);
});
