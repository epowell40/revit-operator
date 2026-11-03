import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';
import{nativeCommittedReadRefreshV2}from'../src/assignments/native_committed_read_refresh_v2.js';
import{committedDocumentReadRefreshV2}from'../src/domain/assignment-kernel/committed_read_refresh.js';
import{reduceAssignmentEventsV2}from'../src/domain/assignment-kernel/reducer.js';
const here=path.dirname(fileURLToPath(import.meta.url)),file=[path.join(here,'fixtures/relative-save-read-refresh-516.json'),path.join(here,'../../test/fixtures/relative-save-read-refresh-516.json')].find(fs.existsSync)!,fixture=()=>JSON.parse(fs.readFileSync(file,'utf8'));
test('actual516 native-bound bare filename SaveAs permits one fresh unchanged document read',()=>{
 const f=fixture(),before=JSON.stringify(f);assert.deepEqual(nativeCommittedReadRefreshV2(f.snapshot,f.candidate),{retry_of_operation_id:f.expectedPrior,retry_basis:'committed_document_read',retry_after_operation_id:f.expectedCommit});assert.equal(JSON.stringify(f),before);
});
for(const [name,change]of Object.entries({
 wrong_filename:(o:any):void=>{o.input.body.filePath='Different.rvt';},nested:(o:any):void=>{o.input.body.filePath='models/Workflow516 mixed-original Result.rvt';},traversal:(o:any):void=>{o.input.body.filePath='../Workflow516 mixed-original Result.rvt';},
 control:(o:any):void=>{o.input.body.filePath='bad\nname.rvt';},drive:(o:any):void=>{o.input.body.filePath='C:Workflow516 mixed-original Result.rvt';},missing:(o:any):void=>{delete o.input.body.filePath;},
 foreign_target:(o:any):void=>{o.target.target_id='path:c:/different.rvt';},missing_native_output_target:(o:any):void=>{o.result.affected_target_identities=[];},
 foreign_doc:(o:any):void=>{o.result.native_artifact_receipt.save_document.after.project_fingerprint='other';},not_same_doc:(o:any):void=>{o.result.native_artifact_receipt.save_document.same_document=false;},
 foreign_native:(o:any):void=>{o.result.authority='backend';},missing_receipt:(o:any):void=>{o.result.receipt_id='';}
}))test('bare filename checkpoint rejects '+name,()=>{const f=fixture();change(f.snapshot.operations[f.expectedCommit]);assert.equal(committedDocumentReadRefreshV2(f.snapshot,f.candidate),null);});
test('relative checkpoint typed basis is recomputed by the existing journal consumer',()=>{
 const f=fixture(),s=reduceAssignmentEventsV2(f.events),basis=committedDocumentReadRefreshV2(s,f.candidate);assert(basis);
 const event:any={schema:'revit-operator.assignment-event/v2',event_id:'relative-checkpoint-read',assignment_id:s.current_binding.assignment_id,assignment_version:s.assignment_version+1,binding:s.current_binding,occurred_at:f.candidate.opened_at,actor:'codex-app-server',event_type:'operation_admitted',operation:{...f.candidate,...basis}};
 const next=reduceAssignmentEventsV2([...f.events,event]);assert.equal(next.operations[f.candidate.operation_id]!.requested_effect,'read');assert.equal(next.operations[f.candidate.operation_id]!.dispatch_state,'not_dispatched');
 assert.throws(()=>reduceAssignmentEventsV2([...f.events,{...event,operation:{...event.operation,retry_after_operation_id:f.expectedPrior}}]),(e:any)=>e.code==='operation_committed_document_read_refresh_invalid');
});
