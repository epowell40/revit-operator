import assert from 'node:assert/strict';
import test from 'node:test';
import {committedCircuitReadbackPlanV2,circuitMembershipSatisfiedV2} from '../src/verification/circuit_membership_postcondition_v2.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
import {verificationCapabilityAdmissionV2} from '../src/verification/verification_capability_admission_v2.js';

import {circuitFixture as fixture} from './circuit_membership.fixtures.js';

test('circuit verification requires the opt-in native membership capability, not ordinary summaries or labels',()=>{
 const f=fixture('source'), apply={capability_id:'revit_call_tool',path:f.operation.input.path,method:'POST',arguments:f.operation.input};
 for(const read of [f.plan,{...f.plan,body:{elementIds:f.plan.body.elementIds}},{method:'POST',path:'/revit/get-parameters',body:{elementIds:[22,23]}}]){
  assert.equal(verificationCapabilityAdmissionV2({apply,verification:{capability_id:'revit_call_tool',method:read.method,path:read.path,arguments:read}}).admissible,read===f.plan);
 }
});

for(const mode of ['source','create','move'] as const){
 test(`${mode} membership is verified only by a complete separate native relationship read`,()=>{
  const f=fixture(mode),affected=f.operation.result.affected_target_identities;
  assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,f.payload,affected),true);
  assert.equal(postconditionSatisfiedByPayloadV2(f.operation.input,f.payload,{path:'/revit/assign-electrical-circuit',verification_input:f.plan,affected_target_identities:affected}),true);
  assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,{content:[{type:'text',text:JSON.stringify(f.payload)}]},affected),true);
  assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,{success:true,verified:true,nativeCircuitReadback:f.payload.circuits[0],request:f.payload},affected),false);
  const corruptions=[(p:any)=>p.complete=false,(p:any)=>p.items.pop(),(p:any)=>p.items.push(p.items[0]),
   (p:any)=>p.requestedElementIds.pop(),(p:any)=>p.items[0].found=false,(p:any)=>p.items[0].uniqueId='missing',
   (p:any)=>p.items[0].electricalCircuitMembership.complete=false,(p:any)=>p.items[0].electricalCircuitMembership.powerSystemIds=[31],
   (p:any)=>p.items[0].electricalCircuitMembership.powerSystemIds=[30,31],(p:any)=>p.circuits[0].systemElementId=31,
   (p:any)=>p.circuits[0].systemType='Data',(p:any)=>p.circuits[0].complete=false,(p:any)=>p.circuits[0].memberElementIds.pop(),
   (p:any)=>p.circuits[0].memberIdentities[0].uniqueId='wrong-native-element-unique',
   (p:any)=>p.circuits[0].panelElementId=41,(p:any)=>p.circuits[0].circuitNumber='3',
   (p:any)=>{p.circuits[0].trueLoadInternal=null;p.circuits[0].apparentLoadInternal=null;},(p:any)=>p.circuits.push(p.circuits[0])];
  for(const corrupt of corruptions){const p=structuredClone(f.payload);corrupt(p);assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,p,affected),false,corrupt.toString());}
  const wrongRead=structuredClone(f.plan);wrongRead.body.includeElectricalCircuitMembership=false;
  assert.equal(circuitMembershipSatisfiedV2(f.operation.input,wrongRead,f.payload,affected),false);
  if(mode!=='source'){for(const corrupt of [(p:any)=>p.circuits[0].panelSlots=[],(p:any)=>p.circuits[0].panelSlots[0].cells[0].electricalSystemId=31,
   (p:any)=>p.circuits[0].panelSlots[0].slotNumber=3]){const p=structuredClone(f.payload);corrupt(p);assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,p,affected),false);}}
  if(mode==='create')assert.equal(circuitMembershipSatisfiedV2(f.operation.input,f.plan,f.payload,['element_id:22']),false,'Creation requires the committed affected circuit identity');
 });

 test(`${mode} automatic check plan preserves ownership, pause, unknown and freshness fences`,()=>{
  const f=fixture(mode);
  assert.equal(f.plan.path,'/revit/get-element-summary');
  const mutations=[(s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.input.body.dryRun=true,(s:any,o:any)=>o.input.body.confirm=false,
   (s:any,o:any)=>o.input.body.parameterOnlyFallback=true,(s:any,o:any)=>o.input.body.panelName='label',
   (s:any,o:any)=>o.input.body.elementIds=[],(s:any,o:any)=>o.input.body.elementIds=[0],(s:any,o:any)=>o.input.body.elementIds=Array(101).fill(22),
   (s:any)=>s.unresolved_unknown_operation_ids=['old'],(s:any)=>s.execution_control={state:'paused'},(s:any)=>s.completion_proposal={},
   (s:any)=>s.terminal=true,(s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
   (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,document_fingerprint:'foreign'},
   (s:any,o:any)=>o.result.authority='model',(s:any,o:any)=>o.result.native_transaction_state='unknown',
   (s:any,o:any)=>o.result.completed_at='invalid',(s:any,o:any)=>o.result.request_identity={...o.request_identity,request_signature:'foreign'},
   (s:any,o:any)=>o.verification_operation_ids=['existing'],
   (s:any,o:any)=>s.operations.later={...o,operation_id:'later',opened_at:'2026-10-13T00:00:02Z'}];
  for(const mutate of mutations){const s=structuredClone(f.snapshot);mutate(s,s.operations.apply);assert.equal(committedCircuitReadbackPlanV2(s,s.operations.apply),null,mutate.toString());}
  const unrelated=structuredClone(f.snapshot);unrelated.operations.later={...unrelated.operations.apply,operation_id:'later',opened_at:'2026-10-13T00:00:02Z',
   input:{method:'POST',path:'/revit/assign-electrical-circuit',body:{elementIds:[122],sourceElementId:121}},result:{affected_target_identities:['element_id:122','element_id:130']}};
  assert.ok(committedCircuitReadbackPlanV2(unrelated,unrelated.operations.apply),'An unrelated circuit must not block checking this circuit');
 });
}
