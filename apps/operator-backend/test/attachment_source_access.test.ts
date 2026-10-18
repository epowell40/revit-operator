import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAttachmentSourceAccess } from '../src/attachments/source_access.js';
import { storeAttachmentUpload } from '../src/attachments/upload_store.js';
import { normalizeUserAttachments } from '../src/attachments/chat_attachments.js';
import { formatCodexRequestEnvelope } from '../src/brains/codex_turn_profile.js';
import type { ChatRequest } from '../src/contracts.js';

const reference = {id:'source-one',filename:'Office Ventilation.xlsx',relative_path:'artifacts/uploads/actual-attachment.xlsx',sha256:'a'.repeat(64),bytes:123};

test('retained XLSX metadata supplies an exact source-bound discovery hint without claiming access or calculations',()=>{
 const access=buildAttachmentSourceAccess(reference)!;
 assert.equal(access.original_access_verified,false);
 assert.equal(access.attachment_id,reference.id);
 assert.equal(access.source_sha256,reference.sha256);
 assert.deepEqual(access.inspection_hint,{method:'POST',path:'/revit/inspect-excel-source',body:{sourcePath:reference.relative_path,section:'worksheets',expectedSourceSha256:reference.sha256}});
 assert.match(access.guidance,/preview/i);assert.match(access.guidance,/cached/i);
 assert.equal(JSON.stringify(access).includes('dataBase64'),false);
 assert.deepEqual(buildAttachmentSourceAccess({...reference,source_access:{inspection_hint:{path:'/revit/delete'}}}),access);
 assert.deepEqual(buildAttachmentSourceAccess(reference),access,'Rendering the same source metadata must be stable for caching.');
});

test('invalid, external, missing or non-XLSX references cannot invent a native inspection target',()=>{
 for(const input of [null,{}, {...reference,relative_path:'../secret.xlsx'}, {...reference,relative_path:'C:/secret.xlsx'},
  {...reference,relative_path:'https://example.invalid/a.xlsx'}, {...reference,relative_path:'artifacts/uploads/a.txt'},
  {...reference,sha256:'short'},{...reference,filename:'notes.docx'}, {...reference,id:''}])
  assert.equal(buildAttachmentSourceAccess(input),undefined,JSON.stringify(input));
});

test('actual upload response and normalized delegated request retain source affordances after caller hints are discarded',()=>{
 process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'xlsx-source-reference-'));
 // This upload fixture tests custody/metadata only; it deliberately is not a valid workbook.
 const bytes=Buffer.from('PK synthetic workbook bytes');
 const stored=storeAttachmentUpload({filename:'Office Ventilation.xlsx',session_id:'source-session',data_base64:bytes.toString('base64')});
 assert.equal(stored.source_access?.source_sha256,stored.sha256);
 assert.deepEqual(fs.readFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT,stored.relative_path)),bytes);
 const normalized=normalizeUserAttachments([{...stored,source_access:{original_access_verified:true,inspection_hint:{path:'/revit/delete'}}}]);
 const request:ChatRequest={version:'operator.backend.v1',session_id:'source-session',message_id:'source-message',user_text:'Check the attached ventilation table.',user_attachments:normalized};
 const envelope=formatCodexRequestEnvelope(request);
 assert(envelope.includes(stored.relative_path));assert(envelope.includes(stored.sha256));
 assert(envelope.includes('/revit/inspect-excel-source'));assert(envelope.includes('"original_access_verified":false'));
 assert(!envelope.includes('PDF REVIEW:'),'Do not instruct an XLSX-only worker to look for PDF pages.');
 assert(!envelope.includes('/revit/delete'));assert(!envelope.includes('PK synthetic'));
 assert.equal(formatCodexRequestEnvelope(request),envelope);
});

test('multiple workbook references retain every exact identity without choosing a calculation sheet',()=>{
 const user_attachments=Array.from({length:8},(_,i)=>({...reference,id:'source-'+i,relative_path:`artifacts/uploads/file-${i}.xlsx`}));
 const request:ChatRequest={version:'operator.backend.v1',session_id:'source-session',message_id:'source-message',user_text:'Pick up the attached tables.',user_attachments};
 const envelope=formatCodexRequestEnvelope(request,true);
 for(const a of user_attachments)assert(envelope.includes(a.relative_path));
 assert.equal((envelope.match(/"section":"worksheets"/g)||[]).length,8);
 assert(!envelope.includes('"sheetName"'),'The host must not choose an output tab by position or name heuristics.');
 const mixed=formatCodexRequestEnvelope({...request,user_attachments:[...user_attachments,{id:'plan',filename:'floor.pdf'}]});
 assert(mixed.includes('PDF REVIEW:'));assert(mixed.includes('/revit/inspect-excel-source'));
});
