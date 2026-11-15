import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {readNativeListenerIdentityReceipt} from '../secure_native_transport.js';
import {nativeReadinessFailureMessage} from '../native_readiness_diagnostic.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const begin=source.indexOf('function classifyRevitContextWindowReadiness('),end=source.indexOf('\n// A cold Windows',begin);
const {classifyRevitContextWindowReadiness:classify,inspectRevitContextDispatchReadiness:inspect}=runInNewContext(
 source.slice(begin,end)+';({classifyRevitContextWindowReadiness,inspectRevitContextDispatchReadiness})',{});
const open={pid:42,main_window_handle:123,responding:true,main_window_enabled:true};
// Title format observed in the customer's Revit 2023.1 photo. The trailing
// sheet title is not needed to identify a document-plus-view caption.
const title2023='Autodesk Revit 2023.1 - RME_basic_sample_project - Sheet: E101 - Electrical Power Riser Diagram';
test('Revit 2023 unbracketed project and view caption is eligible for native context probe',()=>{
 const result=classify({...open,main_window_title:title2023});
 assert.equal(result.ok,true);assert.match(result.document_caption,/RME_basic_sample_project/);
 assert.equal(result.request_dispatched,false,'Window eligibility never claims native dispatch');
});
test('real early-readiness pipeline accepts 2023 title after owner listener normalization',async()=>{
 let ownerChecked=false;
 const pipeline=runInNewContext(source.slice(begin,end)+';inspectRevitContextDispatchReadiness',{
  normalizeNativeListenerSnapshot:(snapshot,receipt)=>{assert.equal(snapshot.pid,receipt.pid);ownerChecked=true;return snapshot;},
  trimToolText:value=>value
 });
 const result=await pipeline({readNativeTransportReceipt:()=>({pid:42,url:'http://127.0.0.1:1234'}),
  inspectRevitBridgeListener:async()=>({pid:42}),
  inspectRevitWindowSnapshot:async(pid)=>{assert.equal(pid,42);assert.equal(ownerChecked,true);return{...open,main_window_title:title2023};}});
 assert.equal(result.ok,true);assert.equal(result.request_dispatched,false);
});
for(const title of ['Autodesk Revit 2023.1','Autodesk Revit 2023.1 - Home',
 'Autodesk Revit 2023.1 - RME_basic_sample_project','Autodesk Revit 2024.3 - [Accueil]',
 'Unrelated App - Project - Sheet: E101'])test('non-document caption stays unavailable: '+title,()=>{
 assert.equal(classify({...open,main_window_title:title}).ok,false);
});
test('2023 loaded caption cannot override nonresponding or disabled window',()=>{
 for(const change of [{responding:false},{main_window_enabled:false},{pid:0},{main_window_handle:0}])
  assert.equal(classify({...open,main_window_title:title2023,...change}).ok,false);
});

test('real missing listener identity preserves bounded filesystem cause through readiness failure',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'missing-listener-identity-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const pipeline=runInNewContext(source.slice(begin,end)+';inspectRevitContextDispatchReadiness',{
  normalizeNativeListenerSnapshot:s=>s,trimToolText:value=>value,nativeReadinessFailureMessage
 });
 const result=await pipeline({readNativeTransportReceipt:()=>({url:'http://127.0.0.1:5000'}),
  inspectRevitBridgeListener:async()=>readNativeListenerIdentityReceipt({env:{LOCALAPPDATA:root}})});
 assert.equal(result.code,'REVIT_CONTEXT_HOST_UNAVAILABLE');
 assert.equal(result.request_dispatched,false);assert.equal(result.outcome_unknown,false);
 assert.match(result.error,/ENOENT/,'A diagnosable missing-file cause must survive the readiness wrapper');
 assert(!result.error.includes(root),'Diagnostic must not expose the local user path');
});
