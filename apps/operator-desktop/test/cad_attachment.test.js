import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPERATOR_DESKTOP_NO_LISTEN='1';
process.env.OPERATOR_TOKEN='cad-attachment-isolated-test-token';
process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'operator-cad-sidecar-'));
const {sanitizePendingAttachments}=await import('../server.js');

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
