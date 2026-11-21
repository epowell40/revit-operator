import test from 'node:test';
import assert from 'node:assert/strict';
import { draftingReadbackReasonV2 } from '../src/domain/assignment-kernel/work_plan_location.js';

function fixture():any {
  const binding={assignment_id:'draft',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'a'.repeat(64)};
  const identity={session_id:'native',project_fingerprint:binding.document_fingerprint,path:'C:/fixture/draft.rvt'};
  const request={method:'POST',path:'/revit/save-as',request_signature:'c'.repeat(64)};
  const receipt={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
    expected_output_paths:[identity.path],expected_export_calls:1,export_calls:[true],
    outputs:[{path:identity.path,size_bytes:1234,sha256:'b'.repeat(64),fresh_output:true,stable_read:true}],
    save_document:{native_save_returned:true,same_document:true,document_session_changed:false,document_path_changed:false,
      project_binding_changed:false,before:{...identity},after:{...identity}}};
  const read={operation_id:'read',requested_effect:'read',persistent_effect:'none',settlement_state:'settled',binding,
    opened_at:'2026-11-20T12:00:00Z',result:{authority:'native-host',status:'succeeded',binding,completed_at:'2026-11-20T12:00:01Z'}};
  const save={operation_id:'save',requested_effect:'apply',persistent_effect:'applied',admission_state:'admitted',dispatch_state:'dispatched',
    settlement_state:'settled',binding,opened_at:'2026-11-20T12:01:00Z',request_identity:request,
    input:{method:'POST',path:'/revit/save-as',body:{filePath:identity.path,dryRun:false}},
    result:{authority:'native-host',status:'succeeded',binding,dispatch_state:'dispatched',persistent_effect:'applied',
      native_transaction_state:'not_applicable',observation_required:true,raw_payload_hash:'d'.repeat(64),
      result_schema_id:'operator-native/POST:/revit/save-as/v2',request_identity:request,
      completed_at:'2026-11-20T12:01:01Z',native_artifact_receipt:receipt}};
  return {current_binding:binding,operations:{read,save},input_invalidated_operation_ids:[]};
}
const at='2026-11-20T12:02:00Z';
test('same-document native checkpoint retains preceding model readback without mutating history',()=>{
  const s=fixture(),before=structuredClone(s);
  assert.equal(draftingReadbackReasonV2(s,'read',at),null);
  assert.deepEqual(s,before);
});
test('unproven, foreign or interrupted saves still invalidate preceding reads',()=>{
  const faults:Record<string,(s:any)=>void>={
    missingResult:s=>delete s.operations.save.result,
    missingReceipt:s=>delete s.operations.save.result.native_artifact_receipt,
    failed:s=>s.operations.save.result.status='failed',
    unknown:s=>s.operations.save.persistent_effect='unknown',
    pending:s=>s.operations.save.settlement_state='open',
    undispatched:s=>s.operations.save.dispatch_state='not_dispatched',
    foreign:s=>s.operations.save.binding={...s.current_binding,run_id:'other'},
    foreignResult:s=>s.operations.save.result.binding={...s.current_binding,generation:2},
    digest:s=>s.operations.save.result.request_identity={...s.operations.save.request_identity,request_signature:'e'.repeat(64)},
    invalidated:s=>s.input_invalidated_operation_ids=['save'],
    path:s=>s.operations.save.input.body.filePath='C:/other.rvt',
    document:s=>s.operations.save.result.native_artifact_receipt.save_document.after.project_fingerprint='f'.repeat(64),
    unstable:s=>s.operations.save.result.native_artifact_receipt.outputs[0].stable_read=false
  };
  for(const [name,change] of Object.entries(faults)){
    const s=fixture();change(s);
    assert.equal(draftingReadbackReasonV2(s,'read',at),'predates_latest_effect',name);
  }
});
test('real content edits still require a fresh model read even when followed by a valid save',()=>{
  const s=fixture();s.operations.edit={operation_id:'edit',requested_effect:'apply',persistent_effect:'applied',
    opened_at:'2026-11-20T12:00:20Z',result:{completed_at:'2026-11-20T12:00:21Z'}};
  assert.equal(draftingReadbackReasonV2(s,'read',at),'predates_latest_effect');
  s.operations.read.opened_at='2026-11-20T12:00:30Z';s.operations.read.result.completed_at='2026-11-20T12:00:31Z';
  assert.equal(draftingReadbackReasonV2(s,'read',at),null);
});
