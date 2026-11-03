import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {committedParameterReadbackPlanV2} from '../src/verification/committed_parameter_readback_plan_v2.js';
import {retainWorkPlanInspectionV2} from '../src/assignments/work_plan_inspection.js';
import {parameterScheduleReadScopeV2} from '../src/verification/parameter_schedule_preservation_v2.js';
import {operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';

function fixture() {
 const f=JSON.parse(fs.readFileSync('test/fixtures/parameter-schedule-preservation-18.json','utf8'));
 const targets=f.input.body.changes.map((c:any)=>c.elementId),ids=f.applied.transaction.modified_element_ids.filter((id:number)=>!targets.includes(id));
 // Hypothetical new native producer output, not retroactive evidence for18.
 const rows=ids.map((id:number)=>({elementId:id,uniqueId:`native-schedule-${id}`,complete:true,scope:'flat_definition_table_parameters',
  definition:{schema:'operator.schedule_definition_snapshot.v1',complete:true,identity:{id,uniqueId:`native-schedule-${id}`,kind:'regular'},definition:{fields:[],table:[],tableStyles:[]}},parameters:[]}));
 f.applied.schedulePreservation={schema:'operator.annotation_schedule_preservation.v1',complete:true,scheduleIds:ids,before:rows,after:structuredClone(rows)};
 f.readInput.body.preservationScheduleIds=ids;
 f.read.schedulePreservation={schema:'operator.annotation_schedule_read.v1',complete:true,requestedElementIds:ids,items:structuredClone(rows)};
 return {...f,targets,ids};
}
function bound(f:any) {
 const binding={assignment_id:'parameter-scope',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{},observations:{}};
 function op(id:string,input:any,payload:any,at:string,purpose:string) {
  const r=storeEvidence({scope:{...binding,attempt_id:id},source:'native-fixture',trust_level:'authoritative_native',raw:payload}),digest=payloadDigestV2(payload).digest;
  const request={method:input.method,path:input.path,request_signature:'signature-'+id};
  const o:any={operation_id:id,binding,input,request_identity:request,capability_id:'native:POST:'+input.path,requested_effect:purpose==='work'?'apply':'read',purpose,
   persistent_effect:purpose==='work'?'applied':'none',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',opened_at:at,
   observation_ids:['obs-'+id],verification_operation_ids:[],target:{target_id:'element_id:'+f.targets[0]},
   result:{operation_id:id,binding,request_identity:request,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',persistent_effect:purpose==='work'?'applied':'none',
    native_transaction_state:purpose==='work'?'committed':'not_applicable',receipt_id:'receipt-'+id,native_correlation_id:'correlation-'+id,
    raw_payload_hash:digest,result_schema_id:'operator-native/POST:'+input.path+'/v2',completed_at:at,
    affected_target_identities:f.applied.transaction.affected_element_ids.map((n:number)=>'element_id:'+n)}};
  s.operations[id]=o;s.observations['obs-'+id]={observation_id:'obs-'+id,operation_id:id,binding,authority:'native-host',raw_payload_hash:digest,raw_payload_ref:'evidence:'+r.ref.evidence_id,facts:[]};return o;
 }
 const apply=op('apply',f.input,f.applied,'2026-10-26T12:00:00Z','work'),read=op('read',f.readInput,f.read,'2026-10-26T12:00:01Z','verification');
 read.verification_of_operation_id='apply';return {s,apply,read};
}
function isolated(fn:()=>void) {const old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'parameter-schedule-scope-'));try{fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;}}

test('parameter read plan carries exact six preserved schedule IDs from bound producer evidence',()=>isolated(()=>{
 const f=fixture(),{s,apply}=bound(f);
 assert.deepEqual((committedParameterReadbackPlanV2(s,apply)!.body as any).preservationScheduleIds,f.ids);
}));
test('fresh independent parameter and unchanged schedule read covers exactly its seven owners',()=>isolated(()=>{
 const f=fixture(),{s,read}=bound(f);
 const coverage=retainWorkPlanInspectionV2(s,[read.operation_id]);
 assert.deepEqual(coverage.target_ids,[...f.targets,...f.ids].map(n=>'element_id:'+n).sort());
}));

test('exact historical mixed18 missing before-state never acquires preservation proof',()=>isolated(()=>{
 const f=fixture();delete f.applied.schedulePreservation;const {s,apply,read}=bound(f);
 assert.equal(parameterScheduleReadScopeV2(s,apply,read),null);
 assert.throws(()=>retainWorkPlanInspectionV2(s,[read.operation_id]),/incomplete_native_read/);
}));

for(const [label,mutate] of [
 ['missing-before',(f:any)=>delete f.applied.schedulePreservation.before],
 ['incomplete-before',(f:any)=>f.applied.schedulePreservation.before[0].complete=false],
 ['changed-at-commit',(f:any)=>f.applied.schedulePreservation.after[0].parameters.push({id:1,value:'changed'})],
 ['changed-after-commit',(f:any)=>f.read.schedulePreservation.items[0].parameters.push({id:1,value:'changed'})],
 ['wrong-schedule-uid',(f:any)=>f.read.schedulePreservation.items[0].uniqueId='foreign-schedule-uid'],
 ['unsupported-kind',(f:any)=>f.applied.schedulePreservation.before[0].definition.identity.kind='unknown'],
 ['missing-current-row',(f:any)=>f.read.schedulePreservation.items.pop()],
 ['unrequested-current-row',(f:any)=>f.read.schedulePreservation.items.push({...f.read.schedulePreservation.items[0],elementId:99})],
 ['missing-read-selector',(f:any)=>delete f.readInput.body.preservationScheduleIds],
 ['wrong-read-selector',(f:any)=>f.readInput.body.preservationScheduleIds[0]=99],
 ['wrong-target-value',(f:any)=>f.read.items[0].parameters.Comments='WRONG'],
 ['deleted-owner',(f:any)=>f.applied.transaction.deleted_element_ids=[99]],
 ['added-owner',(f:any)=>f.applied.transaction.added_element_ids=[99]],
 ['incomplete-inventory',(f:any)=>f.applied.changeTracking.exhaustiveChangeInventory=false],
 ['wrong-wrapper',(f:any)=>f.applied.changeTracking.distinctWrapperMatchCount=2],
] as const)test('parameter preservation refuses '+label,()=>isolated(()=>{
 const f=fixture();mutate(f);const {s,apply,read}=bound(f);
 assert.equal(parameterScheduleReadScopeV2(s,apply,read),null);
 assert.throws(()=>retainWorkPlanInspectionV2(s,[read.operation_id]),/incomplete_native_read/);
}));

for(const [label,mutate] of [
 ['Pause',(s:any)=>s.execution_control={state:'paused'}],
 ['unknown',(s:any)=>s.unresolved_unknown_operation_ids=['unknown']],
 ['foreign',(s:any)=>s.current_binding={...s.current_binding,document_fingerprint:'foreign'}],
 ['invalidated',(s:any)=>s.input_invalidated_operation_ids=['read']],
 ['wrong-request',(s:any)=>s.operations.read.result.request_identity={...s.operations.read.request_identity,request_signature:'foreign'}],
 ['wrong-digest',(s:any)=>s.operations.apply.result.raw_payload_hash='sha256:'+'0'.repeat(64)],
 ['untrusted',(s:any)=>s.operations.apply.result.authority='model'],
 ['stale-read',(s:any)=>s.operations.read.opened_at='2026-10-25T00:00:00Z'],
 ['wrong-pair',(s:any)=>s.operations.read.verification_of_operation_id='foreign'],
 ['intervening-write',(s:any)=>s.operations.later={...s.operations.apply,operation_id:'later',result:{...s.operations.apply.result,completed_at:'2026-10-26T12:00:00.500Z'}}],
 ['pending-older-write',(s:any)=>s.operations.later={...s.operations.apply,operation_id:'later',opened_at:'2026-10-25T00:00:00Z',settlement_state:'awaiting_result',result:undefined}],
] as const)test('parameter preservation keeps '+label+' negative',()=>isolated(()=>{
 const f=fixture(),{s,apply,read}=bound(f);mutate(s);assert.equal(parameterScheduleReadScopeV2(s,apply,read),null);
}));

test('new request and returned native scope select exact owners, never nested parameter/field IDs',()=>{
 const f=fixture(),operation:any={capability_id:'revit_call_tool',path:'/revit/get-parameters'};
 f.read.schedulePreservation.items[0].parameters.push({id:9999,value:'metadata'});
 for(const value of [f.readInput.body,f.read])assert.deepEqual(operationTargetSelectorV2({operation,value}).principal_target_tokens,[...f.targets,...f.ids].sort((a,b)=>a-b).map(id=>'id:'+id));
});
