import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeCodeReviewSaveAsTransitions} from './native_code_review.mjs';
import {nativeDocumentCheckpointRequestMatchesV2} from '../assignment-kernel-v2-contracts/native-artifact.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const binding={assignment_id:'task',session_id:'thread',run_id:'run',generation:1,principal_id:'local',document_fingerprint:'a'.repeat(64)};
 const snapshot={schema:'revit-operator.assignment-snapshot/v2',current_binding:{...binding},operations:{},observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[]};
 const stamp=n=>`2026-11-14T12:00:${String(n).padStart(2,'0')}Z`;
 const provenance={source:{algorithm:'sha256',representation:'utf8_json_bytes',digest:digest('native bytes')}};
 function operation(id,capability,start,end){
  const o={observation_id:'obs-'+id,operation_id:id,capability_id:capability,binding:{...binding},authority:'native-host',payload_provenance:structuredClone(provenance)};
  const op={operation_id:id,capability_id:capability,binding:{...binding},opened_at:stamp(start),requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',dispatch_state:'dispatched',observation_ids:[o.observation_id],
   result:{operation_id:id,binding:{...binding},authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',completed_at:stamp(end),payload_provenance:structuredClone(provenance)}};
  snapshot.operations[id]=op;snapshot.observations[o.observation_id]=o;return{op,o};
 }
 const executions=[];
 for(const [id,start,session,letter] of [['write',1,'before','A'],['read',8,'after','B']]){
  const {op,o}=operation(id,'operator_run_dynamic_revit_program',start,start+1),source=`// ${id}`;
  op.input={mode:id==='read'?'read':'apply',source,native_program:{effect_scope:'active_document'}};
  if(id==='read'){op.requested_effect='read';op.persistent_effect='none';op.result.persistent_effect='none';}
  const evidenceId='ev1_'+letter.repeat(32);o.raw_payload_ref='evidence:'+evidenceId;
  executions.push({evidence_id:evidenceId,content_hash:'sha256:'+provenance.source.digest,source_sha256:'sha256:'+digest(source),mode:op.input.mode,recorded_at:op.result.completed_at,document_session_id:session});
 }
 const {op:save}=operation('save','revit_call_tool',4,5),file='C:/outputs/delivery.rvt';
 save.input={method:'POST',path:'/revit/save-as',body:{filePath:file,dryRun:false}};
 save.request_identity={method:'POST',path:'/revit/save-as'};
 Object.assign(save.result,{request_identity:{...save.request_identity},native_transaction_state:'not_applicable',observation_required:true,raw_payload_hash:digest('save'),result_schema_id:'operator-native/POST:/revit/save-as/v2',
  native_artifact_receipt:{schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',expected_output_paths:[file],expected_export_calls:1,export_calls:[true],
   outputs:[{path:file,size_bytes:1024,sha256:digest('rvt'),fresh_output:true,stable_read:true}],
   save_document:{native_save_returned:true,same_document:true,document_session_changed:true,document_path_changed:true,project_binding_changed:false,
    before:{session_id:'before',project_fingerprint:binding.document_fingerprint,path:'C:/inputs/source.rvt'},after:{session_id:'after',project_fingerprint:binding.document_fingerprint,path:file}}}});
 return{snapshot,binding,executions,save};
}
const check=f=>nativeCodeReviewSaveAsTransitions(f.snapshot,f.binding,f.executions,nativeDocumentCheckpointRequestMatchesV2);
test('historical C# review joins sessions only through native same-document Save As proof',()=>{
 const f=fixture(),before=structuredClone(f),edges=check(f);
 assert.equal(edges.length,1);assert.equal(edges[0].before_document_session_id,'before');assert.equal(edges[0].after_document_session_id,'after');
 assert.equal(edges[0].current_model_verification,false);assert.deepEqual(f,before);
 assert.deepEqual(check({...f,executions:[...f.executions].reverse()}),edges,'selection order is not execution order');
  f.executions[0].recorded_at='2026-11-14T12:00:20Z';assert.deepEqual(check(f),edges,'host delivery timestamp is not native operation ordering');
});
test('missing, foreign, failed, unknown, malformed and reordered transitions cannot join sessions',()=>{
 const faults={
  absent:f=>delete f.snapshot.operations.save,
  foreign:f=>f.save.binding.run_id='foreign',
  failed:f=>f.save.result.status='failed',
  unknown:f=>f.save.persistent_effect='unknown',
  unsettled:f=>f.save.settlement_state='pending',
  pending:f=>f.snapshot.in_flight_operation_ids.push('pending'),
  unresolved:f=>f.snapshot.unresolved_unknown_operation_ids.push('unknown'),
  pause:f=>f.snapshot.execution_control={state:'paused'},
  digest:f=>f.save.result.payload_provenance.source.digest='b'.repeat(64),
  observation:f=>f.save.observation_ids=[],
  resultOwner:f=>f.save.result.binding.document_fingerprint='c'.repeat(64),
  authority:f=>f.save.result.authority='caller',
  sameDocument:f=>f.save.result.native_artifact_receipt.save_document.same_document=false,
  changedProject:f=>f.save.result.native_artifact_receipt.save_document.after.project_fingerprint='f'.repeat(64),
  reopened:f=>f.executions[1].document_session_id='independently-reopened',
  wrongBefore:f=>f.save.result.native_artifact_receipt.save_document.before.session_id='different',
  changedRequest:f=>f.save.input.body.filePath='C:/another.rvt',
  badFile:f=>f.save.result.native_artifact_receipt.outputs[0].stable_read=false,
  afterRead:f=>f.save.result.completed_at='2026-11-14T12:00:10Z',
  earlySave:f=>f.save.opened_at='2026-11-14T12:00:00Z',
  substitutedCode:f=>f.executions[0].source_sha256='sha256:'+'e'.repeat(64),
  substitutedEvidence:f=>f.executions[0].content_hash='sha256:'+'e'.repeat(64),
  wrongReadTime:f=>f.snapshot.operations.read.result.completed_at='2026-11-14T12:00:00Z',
 };
 for(const [name,fault] of Object.entries(faults)){const f=fixture();fault(f);assert.throws(()=>check(f),/native_code_review_/,name);}
});
