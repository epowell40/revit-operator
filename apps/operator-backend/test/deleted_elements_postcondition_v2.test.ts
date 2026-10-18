import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';
import {deletionRequestV2,deletionClosureV2,nativeAbsentElementIdsV2,deletionReadTargetsV2,DELETION_SEMANTIC_OUTPUT_V2}from '../src/verification/deletion_contract_v2.js';
import {deletionReadbackPlansForIdsV2}from '../src/verification/deleted_elements_postcondition_v2.js';
import {verificationCapabilityAdmissionV2,operationTargetSelectorV2}from '../src/verification/verification_capability_admission_v2.js';
const wire=JSON.parse(fs.readFileSync('test/fixtures/native_deletion_apply_189.json','utf8').replace(/^\uFEFF/,''));
const targets:number[]=wire.applied.transaction.deleted_element_ids;
const affected=targets.map(id=>'element_id:'+id);
function readback(plan:ReturnType<typeof deletionReadbackPlansForIdsV2>[number]){
  return {version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:plan.body.operations.length,
    operations:plan.body.operations.map(s=>({id:s.id,op:s.op,member_id:s.memberId,target_type:'Autodesk.Revit.DB.Document',result_preview:null})),
    results:Object.fromEntries(plan.body.operations.map(s=>[s.id,null]))};
}
test('retained deletion wire has a complete twenty-element closure, and reads respect the actual sixteen-operation native limit',()=>{
  assert.deepEqual(deletionClosureV2(wire.input,wire.applied,affected),targets);
  const plans=deletionReadbackPlansForIdsV2(targets);assert.deepEqual(plans.map(p=>p.body.operations.length),[16,4]);
  assert.deepEqual(plans.flatMap(p=>nativeAbsentElementIdsV2(p,readback(p))),targets);
  assert.deepEqual(deletionRequestV2(wire.input)?.ids,[1722844,1722859]);
});
test('production admission names complete deletion absence and binds its separate native reads',()=>{
  const read=deletionReadbackPlansForIdsV2(targets)[0]!;
  const admission=verificationCapabilityAdmissionV2({apply:{capability_id:'revit_call_tool',path:wire.input.path,arguments:wire.input},
    verification:{capability_id:'revit_call_tool',path:read.path,arguments:read}});
  assert.deepEqual(admission.required_semantic_outputs,[DELETION_SEMANTIC_OUTPUT_V2]);assert.equal(admission.admissible,true);
  assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:wire.input.path,arguments:wire.input},value:wire.input.body}).principal_target_tokens,['id:1722844','id:1722859']);
});
test('missing, nonnull, malformed, foreign-receiver and truncated reads cannot manufacture absence',()=>{
  const plan=deletionReadbackPlansForIdsV2(targets)[0]!;
  for(const mutate of [
    (p:any)=>delete p.results.absent0,(p:any)=>delete p.operations[0].result_preview,
    (p:any)=>{p.results.absent0={id:targets[0]};p.operations[0].result_preview=p.results.absent0;},
    (p:any)=>p.operations[0].target_type='Foreign.Document',(p:any)=>p.operations[0].member_id='other',
    (p:any)=>p.operations.pop(),(p:any)=>p.ok=false,(p:any)=>p.read_only=false,(p:any)=>p.truncated=true,
    (p:any)=>p.operations[0].error='Lookup failed'
  ]){const payload=readback(plan);mutate(payload);assert.deepEqual(nativeAbsentElementIdsV2(plan,payload),[]);}
  const wrong=structuredClone(plan);wrong.body.operations[0]!.target='$linkedDocument';
  assert(!deletionReadTargetsV2(wrong).includes(targets[0]!));
});
test('mixed writes, incomplete deletion collections, wrong scope and conflicting native footprints stay unqualified',()=>{
  for(const mutate of [
    (f:any)=>f.input.body.operations[0].memberId='method:Something.Set()',
    (f:any)=>f.applied.results.del600.complete=false,(f:any)=>f.applied.results.del600.items.pop(),
    (f:any)=>f.applied.transaction.unexpected_existing_element_ids=[999],
    (f:any)=>f.applied.transaction.modified_element_ids=[999],
    (f:any)=>f.applied.transaction.added_element_ids=[999],
    (f:any)=>f.applied.transaction.scope_discovery_only=true,(f:any)=>f.applied.transaction.committed=false,
    (f:any)=>f.applied.transaction.scope_baseline_element_count=0,
    (f:any)=>f.applied.transaction.commit_allowed_existing_element_ids=[1],
    (f:any)=>f.applied.operations[0].target_type='Foreign.Document'
  ]){const f=structuredClone(wire);mutate(f);assert.equal(deletionClosureV2(f.input,f.applied,affected),null);}
  assert.equal(deletionClosureV2(wire.input,wire.applied,affected.slice(1)),null);
});

test('ordinary delete requires its complete canonical inventory and exact requested/dependent sets, not its local verified flag',()=>{
  const input={method:'POST',path:'/revit/delete',body:{ids:[1722844,1722859]}},requested=input.body.ids;
  const payload={status:'Deleted',requestedIds:requested,requestedCount:2,impactedIds:targets,impactedCount:targets.length,
    dependentIds:targets.filter(id=>!requested.includes(id)),deletionVerified:true,transaction:structuredClone(wire.applied.transaction)};
  assert.equal(deletionClosureV2(input,payload,affected,false),null,'Inside-transaction readback alone is insufficient');
  assert.deepEqual(deletionClosureV2(input,payload,affected,true),targets);
  for(const mutate of [(p:any)=>p.impactedIds.pop(),(p:any)=>p.requestedIds=[999],(p:any)=>p.dependentIds=[],(p:any)=>p.transaction.status='rolled_back']){
    const p=structuredClone(payload);mutate(p);assert.equal(deletionClosureV2(input,p,affected,true),null);
  }
});
