import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retainedTagReadFixtureV2 } from './fixtures/tag_property_read_fixture.js';
import { decodeNativeTagPropertyReadV2, existingTagRepairReadbackMatchesV2 } from '../src/verification/tag_property_readback_v2.js';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import { operationTargetSelectorV2, verificationCapabilityAdmissionV2 } from '../src/verification/verification_capability_admission_v2.js';

test('retained real tag false leader verifies with owner-bound native values through shared comparator',()=>{
 const f=retainedTagReadFixtureV2();
 assert(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read));
 assert(postconditionSatisfiedByPayloadV2(f.apply_input,f.native_read,{verification_input:f.read_input}));
 const operation={capability_id:'revit_call_tool',path:f.read_input.path,arguments:f.read_input};
 const targets=operationTargetSelectorV2({operation,value:f.native_read,fallback_target_tokens:['id:999']});
 assert.deepEqual(targets.principal_target_tokens,['id:1659176']);
 assert(!targets.principal_target_tokens.includes('id:1657878'));
 assert(verificationCapabilityAdmissionV2({apply:{capability_id:'revit_call_tool',path:f.apply_input.path,arguments:f.apply_input},verification:operation}).admissible);
 const head=f.native_read.operations.find((r:any)=>r.property==='TagHeadPosition').result_preview;
 f.apply_input.body.tagHeadPositionXyz=[head.x,head.y,head.z];f.apply_input.body.leaderEndCondition='attached';
 assert(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read));
});
test('native accepted leader enum spelling matches exact value, never a missing read or unknown default',()=>{
 const live=JSON.parse(fs.readFileSync('test/fixtures/tag-leader-condition-readback-44.json','utf8'));
 assert.equal(live.input.body.leaderEndCondition,'Attached');
 // The retained root read lacks LeaderEndCondition: it must remain unverified.
 assert.equal(existingTagRepairReadbackMatchesV2(live.input,live.read_input,live.native_read),false);
 for(const condition of ['Attached',' ATTACHED ','attached','FrEe',' free ']) {
  const f=retainedTagReadFixtureV2();f.apply_input.body.leaderEndCondition=condition;
  f.native_read.operations.find((o:any)=>o.property==='LeaderEndCondition').result_preview=condition.trim().toLowerCase()==='free'?'Free':'Attached';
  assert(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read));
  f.native_read.operations.find((o:any)=>o.property==='LeaderEndCondition').result_preview=condition.trim().toLowerCase()==='free'?'Attached':'Free';
  assert.equal(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read),false);
 }
 for(const condition of ['', 'unsupported', 0, true, {}, null]) {
  const f=retainedTagReadFixtureV2();f.apply_input.body.leaderEndCondition=condition;
  assert.equal(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read),false);
 }
});
for(const [name,alter] of [
 ['wrong tag',(f:any)=>f.native_read.operations[0].result_preview.id++],
 ['missing unique identity',(f:any)=>delete f.native_read.operations[0].result_preview.unique_id],
 ['wrong owner',(f:any)=>f.native_read.operations.find((r:any)=>r.property==='OwnerViewId').result_preview.id++],
 ['string false',(f:any)=>f.native_read.operations.find((r:any)=>r.property==='HasLeader').result_preview='false'],
 ['wrong native class',(f:any)=>f.native_read.operations[1].target_type='Autodesk.Revit.DB.View'],
 ['missing row',(f:any)=>f.native_read.operations.pop()],
 ['reordered rows',(f:any)=>f.native_read.operations.reverse()],
 ['request echo',(f:any)=>f.native_read={request:f.native_read}],
 ['mutation graph',(f:any)=>f.read_input.body.operations[1].op='set_property'],
 ['unknown property',(f:any)=>f.read_input.body.operations[1].property='UnreviewedProperty'],
 ['unresolved handle',(f:any)=>f.read_input.body.operations[1].target='$foreign'],
 ['no native readonly',(f:any)=>f.native_read.read_only=false],
 ['unsupported leader geometry',(f:any)=>f.apply_input.body.leaderEndXyz=[1,2,3]],
 ['missing owner property',(f:any)=>{f.read_input.body.operations.splice(1,1);f.native_read.operations.splice(1,1);f.native_read.operation_count--;}],
 ['wrong requested head',(f:any)=>f.apply_input.body.tagHeadPositionXyz=[1,2,3]],
 ['preview',(f:any)=>f.apply_input.body.dryRun=true],
 ['missing requested changes',(f:any)=>delete f.apply_input.body.hasLeader]
] as Array<[string,(f:any)=>void]>)test(name,()=>{
 const f=retainedTagReadFixtureV2();alter(f);
 assert.equal(existingTagRepairReadbackMatchesV2(f.apply_input,f.read_input,f.native_read),false);
 assert.equal(postconditionSatisfiedByPayloadV2(f.apply_input,f.native_read,{verification_input:f.read_input}),false);
});
test('native property route is conditional; payload alone and unrelated graph never supply tag truth',()=>{
 const f=retainedTagReadFixtureV2();
 assert.equal(decodeNativeTagPropertyReadV2(undefined,f.native_read),null);
 assert(!postconditionSatisfiedByPayloadV2(f.apply_input,f.native_read));
 const apply={capability_id:'revit_call_tool',path:f.apply_input.path,arguments:f.apply_input};
 for(const args of [undefined,{body:{operations:[]}},{body:{operations:[{id:'all',op:'call',target:'doc',memberId:'unreviewed',args:[]}]}}])
  assert.equal(verificationCapabilityAdmissionV2({apply,verification:{capability_id:'revit_call_tool',path:'/revit/native-api-ops',arguments:args}}).admissible,false);
});
