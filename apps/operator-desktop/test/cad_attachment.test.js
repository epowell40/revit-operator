import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

process.env.OPERATOR_DESKTOP_NO_LISTEN='1';
process.env.OPERATOR_TOKEN='cad-attachment-isolated-test-token';
process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'operator-cad-sidecar-'));
const {sanitizePendingAttachments,toComputerInputMessage}=await import('../server.js');

for(const mimeType of ['', 'application/octet-stream', 'image/vnd.dwg'])
 test('CAD attachment stays binary through Sidecar intake: '+(mimeType||'empty MIME'),()=>{
  const bytes=Buffer.from('AC1027\0binary fixture');
  const [result]=sanitizePendingAttachments([{id:'cad-ref',name:'LAYERS.DWG',mimeType,dataBase64:bytes.toString('base64')}]);
  assert.equal(result.filename,'LAYERS.DWG');
  assert.equal(result.mime,'application/acad');
  assert.equal(result.isImage,false);
  assert.equal(result.bytes,bytes.length);
  assert.deepEqual(Buffer.from(result.dataBase64,'base64'),bytes);
 });

test('Adding DWG support does not admit executable attachments',()=>{
 assert.throws(()=>sanitizePendingAttachments([{name:'sample.exe',mimeType:'application/octet-stream',dataBase64:'YWJj'}]),/unsupported type/);
});

function registeredCad(){
 const bytes=Buffer.from('AC1015\0binary CAD reference');
 const [attachment]=sanitizePendingAttachments([{id:'cad-ref',name:'RANCH.DWG',dataBase64:bytes.toString('base64')}]);
 return {...attachment,backendAttachment:{id:attachment.id,filename:attachment.filename,
  session_id:'cad-session',mime:attachment.mime,bytes:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex'),relative_path:'artifacts/uploads/case_RANCH.DWG'}};
}

test('the active desktop provider receives the registered DWG reference and never its binary',()=>{
 const cad=registeredCad();
 const [text]=sanitizePendingAttachments([{id:'text-ref',name:'rules.txt',dataBase64:'aGVsbG8='}]);
 const input=toComputerInputMessage({role:'user',text:'Trace this plan with native walls.',attachments:[cad,text]},
  {attachmentDelivery:{sessionId:'cad-session',tools:[]}});
 assert.deepEqual(input.content.filter(item=>item.type==='input_file').map(item=>item.filename),['rules.txt']);
 const rendered=JSON.stringify(input);
 assert(!rendered.includes(cad.dataBase64));
 assert(rendered.includes(cad.backendAttachment.relative_path));
 assert(rendered.includes(cad.backendAttachment.sha256));
 assert.match(rendered,/\/revit\/link-cad/);
 assert.match(rendered,/expectedSourceSha256/);
 assert.match(rendered,/original_access_verified/);
});

test('missing, foreign and malformed DWG registrations never fall back to an inline file',()=>{
 const cad=registeredCad();
 for(const backendAttachment of [undefined,{...cad.backendAttachment,session_id:'other-session'},
  {...cad.backendAttachment,relative_path:'../outside.dwg'},{...cad.backendAttachment,sha256:'wrong'}]){
  const input=toComputerInputMessage({role:'user',text:'Trace this plan.',attachments:[{...cad,backendAttachment}]},
   {attachmentDelivery:{sessionId:'cad-session',tools:[]}});
  const rendered=JSON.stringify(input);
  assert(!input.content.some(item=>item.type==='input_file'));
  assert(!rendered.includes(cad.dataBase64));
  assert(!rendered.includes(cad.backendAttachment.sha256));
  assert(!rendered.includes('/revit/link-cad'));
  assert.match(rendered,/could not ground this DWG/i);
 }
});
