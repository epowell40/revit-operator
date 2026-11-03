import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';
import{nativeCommittedReadRefreshV2}from'../src/assignments/native_committed_read_refresh_v2.js';
import{committedDocumentReadRefreshV2}from'../src/domain/assignment-kernel/committed_read_refresh.js';
import{reduceAssignmentEventsV2}from'../src/domain/assignment-kernel/reducer.js';
const here=path.dirname(fileURLToPath(import.meta.url)),file=[path.join(here,'fixtures/document-read-refresh-516.json'),path.join(here,'../../test/fixtures/document-read-refresh-516.json')].find(fs.existsSync)!;
const fixtures=()=>JSON.parse(fs.readFileSync(file,'utf8')).cases;
for(const index of [0,1])test('actual516 document refresh '+index+' permits a fresh read after a later same-document commit, never a write or completion',()=>{
 const f=fixtures()[index],before=JSON.stringify(f);
 assert.deepEqual(nativeCommittedReadRefreshV2(f.snapshot,f.candidate),{retry_of_operation_id:f.expectedPrior,retry_basis:'committed_document_read',retry_after_operation_id:f.expectedCommit});
 assert.equal(JSON.stringify(f),before,'no native history or checklist mutation');
});
const negatives:Record<string,(f:any)=>void>={
 write:f=>f.candidate.requested_effect='apply',child:f=>f.candidate.operation_role='child',terminal:f=>f.snapshot.terminal=true,
 proposal:f=>f.snapshot.completion_proposal={},paused:f=>f.snapshot.execution_control={state:'paused'},unknown:f=>f.snapshot.unresolved_unknown_operation_ids=['u'],
 inflight_write:f=>f.snapshot.in_flight_operation_ids=[f.expectedCommit],foreign_current:f=>f.snapshot.current_binding.principal_id='other',
 foreign_candidate:f=>f.candidate.target.document_fingerprint='other',request_change:f=>f.candidate.input.changed=true,
 no_signature:f=>f.candidate.request_identity.request_signature='',used:f=>f.snapshot.operations.used={...f.candidate,operation_id:'used',retry_of_operation_id:f.expectedPrior},
 foreign_commit:f=>f.snapshot.operations[f.expectedCommit].binding.session_id='other',foreign_document:f=>f.snapshot.operations[f.expectedCommit].target.document_fingerprint='other',
 non_native:f=>f.snapshot.operations[f.expectedCommit].result.authority='backend',rollback:f=>f.snapshot.operations[f.expectedCommit].result.native_transaction_state='rolled_back',
 unretained:f=>f.snapshot.operations[f.expectedCommit].observation_retention_error='lost',missing_receipt:f=>f.snapshot.operations[f.expectedCommit].result.receipt_id='',
 invalid_hash:f=>f.snapshot.operations[f.expectedCommit].result.raw_payload_hash='bad',missing_observation:f=>f.snapshot.operations[f.expectedCommit].observation_ids=[],
 no_change:f=>f.snapshot.operations[f.expectedCommit].admitted_assignment_version=1,
 invalidated:f=>f.snapshot.input_invalidated_operation_ids=[f.expectedCommit],invalid_prior:f=>f.snapshot.input_invalidated_operation_ids=[f.expectedPrior],
 unsettled:f=>f.snapshot.operations[f.expectedCommit].settlement_state='open',future:f=>f.snapshot.operations[f.expectedCommit].settled_assignment_version=999999,
 foreign_prior_result:f=>f.snapshot.operations[f.expectedPrior].result.binding.principal_id='other',wrong_prior_status:f=>f.snapshot.operations[f.expectedPrior].result.status='failed_after_dispatch'
};
for(const index of [0,1])for(const[name,change]of Object.entries(negatives))test(`document refresh ${index} rejects ${name}`,()=>{
 const f=fixtures()[index];change(f);assert.equal(committedDocumentReadRefreshV2(f.snapshot,f.candidate),null);
});
for(const[name,change]of Object.entries({
 same_document_false:(f:any):void=>{f.snapshot.operations[f.expectedCommit].result.native_artifact_receipt.save_document.same_document=false;},
 foreign_saved_project:(f:any):void=>{f.snapshot.operations[f.expectedCommit].result.native_artifact_receipt.save_document.after.project_fingerprint='other';},
 request_receipt_path:(f:any):void=>{f.snapshot.operations[f.expectedCommit].input.body.filePath='C:/other.rvt';},
 missing_child:(f:any)=>{const id=Object.keys(f.snapshot.operations).find(id=>f.snapshot.operations[id].parent_operation_id===f.expectedPrior)!;delete f.snapshot.operations[id];},
 extra_child:(f:any)=>{const child=Object.values(f.snapshot.operations).find((o:any)=>o.parent_operation_id===f.expectedPrior) as any;f.snapshot.operations.extra={...structuredClone(child),operation_id:'extra'};},
 foreign_child:(f:any)=>{const child=Object.values(f.snapshot.operations).find((o:any)=>o.parent_operation_id===f.expectedPrior) as any;child.binding.principal_id='other';},
 child_write:(f:any)=>{const child=Object.values(f.snapshot.operations).find((o:any)=>o.parent_operation_id===f.expectedPrior) as any;child.requested_effect='apply';},
 wrong_transport:(f:any):void=>{f.snapshot.operations[f.expectedPrior].result.authority='operator-advisory';}
}))test('wrapper/save refresh rejects '+name,()=>{const f=fixtures()[1];change(f);assert.equal(committedDocumentReadRefreshV2(f.snapshot,f.candidate),null);});

test('journal consumer recomputes the typed document basis and refuses forged commit references',()=>{
 const events=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'document-read-prefix-516.json'),'utf8')),s=reduceAssignmentEventsV2(events),f=fixtures()[0];
 const retry=committedDocumentReadRefreshV2(s,f.candidate);assert(retry);
 const operation={...structuredClone(f.candidate),...retry,operation_id:'opv2_'+ '8'.repeat(64)};
 const event:any={schema:'revit-operator.assignment-event/v2',event_id:'new-typed-read',assignment_id:s.spec.binding.assignment_id,
  assignment_version:s.assignment_version+1,binding:s.current_binding,occurred_at:operation.opened_at,actor:'codex-app-server',event_type:'operation_admitted',operation};
 const next=reduceAssignmentEventsV2([...events,event]);assert.equal(next.operations[operation.operation_id]!.dispatch_state,'not_dispatched');
 assert.equal(next.operations[operation.operation_id]!.requested_effect,'read');assert.equal(next.terminal,false);
 assert.throws(()=>reduceAssignmentEventsV2([...events,{...event,operation:{...operation,retry_after_operation_id:f.expectedPrior}}]),(e:any)=>e.code==='operation_committed_document_read_refresh_invalid');
});
