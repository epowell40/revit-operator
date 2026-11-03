import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {teeTakeoffPostconditionSatisfiedV2,teeTakeoffIncomingPostconditionV2,committedTeeTakeoffReadbackPlanV2} from '../src/verification/tee_takeoff_evidence_v2.js';
import {teeTakeoffFixture} from './tee_takeoff_readback.fixtures.js';
import {addTeeCollateral} from './tee_collateral_preservation.fixtures.js';

function bound(configure?:(f:ReturnType<typeof teeTakeoffFixture>)=>void) {
  const f=teeTakeoffFixture();
  configure?.(f);
  const binding={assignment_id:'tee-replacement-scope',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
  const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{},observations:{}};
  function operation(id:string,input:any,payload:any,at:string,work:boolean) {
    const stored=storeEvidence({scope:{...binding,attempt_id:id},source:'native-fixture',trust_level:'authoritative_native',raw:payload});
    const digest=payloadDigestV2(payload).digest,request={method:input.method,path:input.path,request_signature:'signature-'+id};
    const op:any={operation_id:id,binding,input,request_identity:request,capability_id:'native:POST:'+input.path,
      requested_effect:work?'apply':'read',persistent_effect:work?'applied':'none',purpose:work?'work':'verification',
      fulfillment_role:work?'work':'verification',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',
      opened_at:at,observation_ids:['obs-'+id],verification_operation_ids:[],
      result:{operation_id:id,binding,request_identity:request,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',
        persistent_effect:work?'applied':'none',native_transaction_state:work?'committed':'not_applicable',receipt_id:'receipt-'+id,
        native_correlation_id:'correlation-'+id,raw_payload_hash:digest,result_schema_id:'operator-native/POST:'+input.path+'/v2',
        completed_at:at,affected_target_identities:work?f.affected:[]}};
    s.operations[id]=op;s.observations['obs-'+id]={observation_id:'obs-'+id,operation_id:id,binding,authority:'native-host',
      raw_payload_hash:digest,raw_payload_ref:'evidence:'+stored.ref.evidence_id,facts:[]};return op;
  }
  const apply=operation('apply',f.input,f.apply,'2026-10-28T12:00:00Z',true);
  const read=operation('read',{method:'POST',path:'/revit/get-connectors',body:{elementIds:[10,20,30,50,60],
    includeTeeReplacementState:true,replacementRemovedIds:[40,41],replacementTypeIds:[110,130,140,160],preservationScheduleIds:[900],includeAllRefs:true,includeCoordinateSystem:true,includeFlexGeometry:true}},
    f.scan,'2026-10-28T12:00:01Z',false);
  read.verification_of_operation_id=apply.operation_id;
  return {f,s,apply,read};
}
type Fixture=ReturnType<typeof bound>;
function isolated(fn:()=>void) {
  const old=process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'tee-replacement-scope-'));
  try{fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;}
}
const matches=({f,s,apply,read}:Fixture)=>teeTakeoffPostconditionSatisfiedV2(s,apply,read.result,f.scan);
test('current bound native callback verifies physical, type and schedule scope without connector aliases',()=>isolated(()=>{
  assert.equal(matches(bound()),true);
}));
test('prospective collateral is consumed through current native-bound evidence and existing read plan',()=>isolated(()=>{
 const b=bound(addTeeCollateral);assert.equal(matches(b),true);
 delete b.s.operations.read;b.apply.verification_operation_ids=[];
 assert.ok(committedTeeTakeoffReadbackPlanV2(b.s,b.apply));
}));
test('collateral cannot bypass native source binding or current digest',()=>isolated(()=>{
 const b=bound(addTeeCollateral);b.read.result.binding={...b.read.binding,session_id:'foreign'};assert.equal(matches(b),false);
 const c=bound(addTeeCollateral);c.f.scan.teeReplacementState.collateral.rows[0].state.geometry.points[1][0]=2;assert.equal(matches(c),false);
}));
test('a model-supplied evidence reference cannot become native proof even with matching bytes',()=>isolated(()=>{
  const b=bound();
  const stored=storeEvidence({scope:{...b.s.current_binding,attempt_id:'apply'},source:'model-fixture',trust_level:'untrusted_caller',raw:b.f.apply});
  b.s.observations['obs-apply'].raw_payload_ref='evidence:'+stored.ref.evidence_id;
  assert.equal(matches(b),false);
}));
const negatives:Record<string,(b:Fixture)=>void>={
  Pause:b=>b.s.execution_control={state:'paused'},
  unknown:b=>b.s.unresolved_unknown_operation_ids=['unknown'],
  foreignDocument:b=>b.s.current_binding={...b.s.current_binding,document_fingerprint:'foreign'},
  foreignGeneration:b=>b.read.binding={...b.read.binding,generation:2},
  invalidatedApply:b=>b.s.input_invalidated_operation_ids=['apply'],
  invalidatedRead:b=>b.s.input_invalidated_operation_ids=['read'],
  unadmitted:b=>b.apply.admission_state='rejected',
  notDispatched:b=>b.apply.dispatch_state='not_dispatched',
  unsettled:b=>b.apply.settlement_state='awaiting_result',
  failedRead:b=>b.read.result.status='failed',
  wrongAuthority:b=>b.read.result.authority='model',
  missingReceipt:b=>delete b.apply.result.receipt_id,
  missingCorrelation:b=>delete b.read.result.native_correlation_id,
  wrongSignature:b=>b.apply.result.request_identity={...b.apply.request_identity,request_signature:'foreign'},
  wrongSchema:b=>b.read.result.result_schema_id='untyped',
  wrongApplyDigest:b=>b.apply.result.raw_payload_hash='sha256:'+'0'.repeat(64),
  wrongReadDigest:b=>b.read.result.raw_payload_hash='sha256:'+'0'.repeat(64),
  wrongPayload:b=>b.f.scan.results[0].typeId=999,
  missingApplyEvidence:b=>delete b.s.observations['obs-apply'],
  missingReadEvidence:b=>delete b.s.observations['obs-read'],
  foreignRef:b=>b.s.observations['obs-apply'].raw_payload_ref=b.s.observations['obs-read'].raw_payload_ref,
  missingBinding:b=>delete b.s.observations['obs-read'].binding,
  missingReadOperationBinding:b=>delete b.read.binding,
  discoveryOnly:b=>b.read.purpose='discovery',
  wrongRole:b=>b.read.fulfillment_role='discovery',
  wrongPair:b=>b.read.verification_of_operation_id='foreign',
  staleRead:b=>b.read.opened_at='2026-10-28T11:59:59Z',
  invalidCompletionTime:b=>b.read.result.completed_at='not-a-time',
  pendingWrite:b=>b.s.operations.pending={...b.apply,operation_id:'pending',settlement_state:'awaiting_result',result:undefined},
  newerWrite:b=>b.s.operations.newer={...b.apply,operation_id:'newer',result:{...b.apply.result,completed_at:'2026-10-28T12:00:02Z'}},
  readMutation:b=>b.read.result.persistent_effect='applied',
  missingFlag:b=>delete b.read.input.body.includeTeeReplacementState,
  incompletePhysicalScope:b=>b.read.input.body.elementIds.pop(),
  scheduleAsConnector:b=>b.read.input.body.elementIds.push(900),
  symbolAsConnector:b=>b.read.input.body.elementIds.push(130),
  missingRemovedScope:b=>delete b.read.input.body.replacementRemovedIds,
  missingTypeScope:b=>delete b.read.input.body.replacementTypeIds,
  deletedAsConnector:b=>b.read.input.body.elementIds.push(40),
  wrongRemovedScope:b=>b.read.input.body.replacementRemovedIds=[40],
  mixedState:b=>b.read.input.body.includeInlineAccessoryState=true,
  missingScheduleScope:b=>delete b.read.input.body.preservationScheduleIds,
  differentScheduleScope:b=>b.read.input.body.preservationScheduleIds=[61],
  omittedReferences:b=>b.read.input.body.includeAllRefs=false,
  omittedCoordinates:b=>b.read.input.body.includeCoordinateSystem=false,
  omittedFlex:b=>b.read.input.body.includeFlexGeometry=false,
  openOnly:b=>b.read.input.body.onlyOpenPhysicalConnectors=true,
};
for(const[name,mutate]of Object.entries(negatives))test('replacement evidence refuses '+name,()=>isolated(()=>{
  const b=bound();mutate(b);assert.equal(matches(b),false);
}));

test('incoming callback verifies before read settlement without requiring retained read evidence',()=>isolated(()=>{
  const b=bound(),current=b.read.result;
  b.read.dispatch_state='dispatching';b.read.settlement_state='awaiting_result';delete b.read.result;
  delete b.s.observations['obs-read'];b.read.observation_ids=[];
  assert.equal(teeTakeoffIncomingPostconditionV2(b.s,b.apply,current,b.f.scan),true);
  assert.equal(teeTakeoffPostconditionSatisfiedV2(b.s,b.apply,current,b.f.scan),false,'Retained inspection still requires normal settlement');
}));
// The incoming read has no retained observation yet. Its operation/result
// binding is mandatory; the later inspection independently checks its stored ref.
for(const [name,mutate]of Object.entries(negatives).filter(([name])=>!['missingReadEvidence','missingBinding'].includes(name)))
  test('incoming native boundary refuses '+name,()=>isolated(()=>{
    const b=bound();mutate(b);
    assert.equal(teeTakeoffIncomingPostconditionV2(b.s,b.apply,b.read.result,b.f.scan),false);
  }));
test('read plan is derived from committed native scope and stops after a linked verification',()=>isolated(()=>{
  const b=bound();assert.deepEqual(committedTeeTakeoffReadbackPlanV2(b.s,b.apply)?.body.elementIds,[10,20,30,50,60]);
  b.apply.verification_operation_ids=['read'];assert.equal(committedTeeTakeoffReadbackPlanV2(b.s,b.apply),null);
}));

