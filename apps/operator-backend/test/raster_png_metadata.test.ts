import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {readRegisteredPdfAttachment} from '../src/attachments/read_attachment.js';
import {storeAttachmentUpload} from '../src/attachments/upload_store.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';

function setup(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'png-metadata-')),before=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{if(before===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=before;fs.rmSync(root,{recursive:true,force:true});});
 return root;
}
function pixels(){const c=createCanvas(8,4),ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(4,0,4,4);return c.toBuffer('image/png');}
function chunk(kind:string,data:Buffer){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(kind,4,'ascii');data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,b.length-4)),b.length-4);return b;}
function annotated(kind='caBX'){
 const original=pixels(),text=Buffer.from('<svg this-is-metadata-not-an-image');
 const data=kind==='zTXt'?Buffer.concat([Buffer.from('provenance\0\0'),deflateSync(text,{level:0})]):
  kind==='iTXt'?Buffer.concat([Buffer.from('provenance\0\0\0\0\0'),text]):Buffer.concat([Buffer.from('provenance\0'),text]);
 const metadata=chunk(kind,data);return {original,bytes:Buffer.concat([original.subarray(0,33),metadata,original.subarray(33)])};
}
const upload=(bytes:Buffer)=>storeAttachmentUpload({session_id:'owner',filename:'reference.png',data_base64:bytes.toString('base64')});

for(const kind of ['caBX','tEXt','iTXt','zTXt'])test(`PNG ${kind} metadata cannot redirect the raster decoder to SVG`,async t=>{
 const root=setup(t),{original,bytes}=annotated(kind),u=upload(bytes);
 const result=await readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1],mode:'detail'});
 const originalUpload=upload(original),control=await readRegisteredPdfAttachment('owner',{attachment_id:originalUpload.id,pages:[1],mode:'detail'});
 const image=result.content.find(x=>x.type==='image');assert(image&&image.type==='image');
 assert.deepEqual(image,control.content.find(x=>x.type==='image'),'RGB and transparency must be identical');
 const meta=JSON.parse(result.content[0]!.type==='text'?result.content[0].text:'{}');
 assert.equal(meta.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.deepEqual(fs.readFileSync(path.join(root,u.relative_path!)),bytes,'Never rewrite the registered source or provenance');
});

test('PNG metadata source crop reaches actor image input with immutable source identity',async t=>{
 setup(t);const {bytes}=annotated(),u=upload(bytes),args={attachment_id:u.id,pages:[1],mode:'detail',region:{min_u:.5,min_v:0,max_u:1,max_v:1}};
 const result=await readRegisteredPdfAttachment('owner',args),again=await readRegisteredPdfAttachment('owner',args);
 assert.deepEqual(again,result,'Repeated immutable reads stay cache stable');
 const adapted=adaptMcpToolCallResultToDynamicResponse(result),images=adapted.contentItems.filter(x=>x.type==='inputImage');assert.equal(images.length,1);
 const im=await loadImage(images[0]!.imageUrl);assert.equal(im.width,4);assert.equal(im.height,4);
 const c=createCanvas(4,4),ctx=c.getContext('2d');ctx.drawImage(im,0,0);assert.deepEqual([...ctx.getImageData(1,1,1,1).data],[255,0,0,255]);
 const meta=JSON.parse(adapted.contentItems.find(x=>x.type==='inputText')!.text);assert.equal(meta.sha256,u.sha256);assert.equal(meta.image_geometry.pixel_to_normalized_page.u_offset,.5);assert.equal(meta.coverage[0].visual_scope,'region');
 await assert.rejects(readRegisteredPdfAttachment('foreign',args),/not registered/);
});

test('Omitted PNG metadata still requires intact original CRC, complete framing and immutable upload',async t=>{
 const root=setup(t),{bytes}=annotated();
 for(const bad of [Buffer.from(bytes),bytes.subarray(0,bytes.length-4),Buffer.concat([bytes,Buffer.from('extra')])]){
  if(bad.length===bytes.length)bad[45]^=1;
  const u=upload(bad);await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1]}),/Malformed|truncated/);
 }
 const u=upload(bytes);fs.appendFileSync(path.join(root,u.relative_path!),'changed');await assert.rejects(readRegisteredPdfAttachment('owner',{attachment_id:u.id,pages:[1]}),/changed since upload/);
});
