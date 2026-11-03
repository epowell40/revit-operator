import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{retainedPdfInput,summarizeInputEnvelope}from'./retained_pdf_input.mjs';
const bytes=Buffer.from('%PDF-1.7\nfixture');
const attachment={id:'pdf-one',filename:'Plans.pdf',mime:'application/pdf',isImage:false,bytes:bytes.length,dataBase64:bytes.toString('base64'),backendAttachment:{id:'pdf-one',filename:'Plans.pdf',mime:'application/pdf',session_id:'session-one',relative_path:'artifacts/uploads/plans.pdf',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
const context={sessionId:'session-one',tools:[{type:'function',name:'native__operator_read_attachment',parameters:{type:'object',properties:{attachment_id:{type:'string'},pages:{type:'array',minItems:1,maxItems:3,items:{type:'integer'}},mode:{enum:['overview','detail']}}}}]};
test('registered same-conversation PDF uses existing page reader without claiming inspection',()=>{
 const result=retainedPdfInput(attachment,context);assert.equal(result.type,'input_text');
 assert(result.text.includes('native__operator_read_attachment'));assert(result.text.includes('flattened marks'));
 assert(result.text.includes('"original_access_verified":false'));assert(!result.text.includes(attachment.dataBase64));
 assert.equal(attachment.dataBase64,bytes.toString('base64'));
});
for(const [name,change] of Object.entries({foreign:a=>a.backendAttachment.session_id='foreign',hash:a=>a.backendAttachment.sha256='a'.repeat(64),size:a=>a.bytes++,path:a=>a.backendAttachment.relative_path='elsewhere/file.pdf',missing:a=>delete a.backendAttachment,identity:a=>a.id='other',image:a=>a.isImage=true,workbook:a=>a.mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:a=>a.filename='table.txt',malformed:a=>a.dataBase64='bad?base64',empty:a=>a.dataBase64='',dataUrl:a=>a.dataBase64='data:application/pdf;base64,'+a.dataBase64})){
 test(`${name} preserves binary fallback`,()=>{const a=structuredClone(attachment);change(a);assert.equal(retainedPdfInput(a,context),null);});
}
test('missing, deferred-only, or insufficient reader preserves fallback',()=>{
 for(const tools of [[],[{type:'function',name:'native__invoke'}],[{type:'function',name:'native__operator_read_attachment',parameters:{}}]]) assert.equal(retainedPdfInput(attachment,{...context,tools}),null);
 assert.equal(retainedPdfInput(attachment,null),null);
});
test('counts retain no source content and never estimate tokens',()=>{
 const input=[{role:'user',content:[{type:'input_text',text:'secret'},{type:'input_file',file_data:'private'},{type:'input_image',image_url:'private'}]}];
 const r=summarizeInputEnvelope(input);assert.equal(r.blocks.input_file.count,1);assert.equal(r.provider_tokens,null);
 assert.equal(r.serialized_bytes,Buffer.byteLength(JSON.stringify(input)));assert(!JSON.stringify(r).includes('secret'));assert(!JSON.stringify(r).includes('private'));
});
