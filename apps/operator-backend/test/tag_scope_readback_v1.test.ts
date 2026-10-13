import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkTagScopeReadbackV1,type ScopeNativeReadV1} from '../src/verification/tag_scope_readback_v1.js';
import {checkWorkPlanScopeV1,projectWorkPlanScopeChecksV1} from '../src/assignments/work_plan_scope_check.js';
import {validTagScopeRequestV1} from '../src/domain/assignment-kernel/work_plan_scope.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {__closeForTests} from '../src/memory/sqlite_store.js';
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const SUBJECT='method:Autodesk.Revit.DB.IndependentTag.GetTaggedLocalElements()';
const uid=(id:number)=>`native-identity-for-element-${id}`;
function fixture() {
  const scope={category:'OST_ElectricalEquipmentTags',view_ids:[10],subject_family_names:['Panelboard'],has_leader:false};
  const items=[1,2,3,4].map(id=>({elementId:id,builtInCategory:scope.category,ownerViewId:id===4?20:10,familyName:'Shared Panel Tag'}));
  const reads:ScopeNativeReadV1[]=[{operation_id:'inventory',input:{method:'POST',path:'/revit/find-elements',body:{category:scope.category,limit:100}},
    payload:{status:'Ok',scope:{kind:'Document',viewIds:[],sheetId:null},count:4,items,elementIds:[1,2,3,4],categoryFilterApplied:true,
      itemsComplete:true,truncated:false,scanCapReached:false,identityExpansionScanCapReached:false,warnings:[]}}];
  for(const id of [1,2,3]) {
    const propertyOps=[{id:'tag',op:'call',target:'doc',memberId:GET,args:[id]},
      {id:'owner',op:'get_property',target:'$tag',property:'OwnerViewId'},
      {id:'leader',op:'get_property',target:'$tag',property:'HasLeader'}];
    const nativeOps=[{id:'tag',op:'call',member_id:GET,target_type:'Autodesk.Revit.DB.Document',result_preview:{id,unique_id:uid(id)}},
      {id:'owner',op:'get_property',property:'OwnerViewId',target_type:'Autodesk.Revit.DB.IndependentTag',result_preview:{id:10}},
      {id:'leader',op:'get_property',property:'HasLeader',target_type:'Autodesk.Revit.DB.IndependentTag',result_preview:id===3}];
    reads.push({operation_id:`property${id}`,input:{method:'POST',path:'/revit/native-api-ops',body:{operations:propertyOps}},
      payload:{version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:3,operations:nativeOps}});
    reads.push({operation_id:`subject${id}`,input:{method:'POST',path:'/revit/native-api-ops',body:{operations:[propertyOps[0],{id:'subjects',op:'call',target:'$tag',memberId:SUBJECT,args:[]}]}},
      payload:{version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:2,operations:[structuredClone(nativeOps[0]),
        {id:'subjects',op:'call',member_id:SUBJECT,target_type:'Autodesk.Revit.DB.IndependentTag'}],
        results:{subjects:{complete:true,truncated:false,hasMore:false,count:1,total:1,items:[{id:id+100,unique_id:uid(id+100)}]}}}});
  }
  reads.push({operation_id:'parameters',input:{method:'POST',path:'/revit/get-parameters',body:{elementIds:[101,102,103],names:['Family']}},
    payload:{items:[101,102,103].map(id=>({id,uniqueId:uid(id),parameterDetails:[{name:'Family',valueString:id===103?'Transformer':'Panelboard'}]}))}});
  return {scope,reads};
}
test('scope checks actual subjects despite identical tag families; records unchanged exclusions',()=>{
  const f=fixture(),r=checkTagScopeReadbackV1(f.scope,f.reads);
  assert.deepEqual(r.matched_target_ids,[1,2]);assert.deepEqual(r.excluded_target_ids,[3]);
  assert.equal(r.candidate_count,3);assert.equal(r.inventory_count,4);assert.equal(r.satisfied_count,2);
  assert(r.declared_scope_satisfied);assert(r.scope_is_assistant_interpretation);
  assert.match(r.notice,/not certified/);
  f.reads[3]!.payload.operations[2].result_preview=true;
  const failed=checkTagScopeReadbackV1(f.scope,f.reads);
  assert(!failed.declared_scope_satisfied);assert.deepEqual(failed.failed_target_ids,[2]);
});
test('consistent repeated native subject reads coalesce across separate calls',()=>{
  const f=fixture(),again=structuredClone(f.reads.at(-1)!);
  again.operation_id='subject-family-repeat';again.input.body.elementIds=[101];again.payload.items=again.payload.items.slice(0,1);
  const expected=checkTagScopeReadbackV1(f.scope,f.reads);
  assert.deepEqual(checkTagScopeReadbackV1(f.scope,[...f.reads,again]),expected);
});
test('complete global census needs detailed reads only for declared view and tag-family candidates',()=>{
 const f=fixture();const scope={...f.scope,family_names:['Shared Panel Tag']};
 f.reads[0]!.payload.items.push({elementId:5,builtInCategory:scope.category,ownerViewId:10,familyName:'Other Tag Family'});
 f.reads[0]!.payload.elementIds.push(5);f.reads[0]!.payload.count=5;
 const r=checkTagScopeReadbackV1(scope,f.reads);
 assert.equal(r.inventory_count,5);assert.equal(r.candidate_count,3);
 assert.deepEqual(r.matched_target_ids,[1,2]);assert(r.declared_scope_satisfied);
 assert(!f.reads.some(r=>r.operation_id==='property4'||r.operation_id==='property5'));
 const broadened={...scope,family_names:undefined};
 assert.throws(()=>checkTagScopeReadbackV1(broadened,f.reads),/tag_scope_/,'broadening requires the newly included candidate read');
});
test('consistent repeated tag property and association reads coalesce across separate calls',()=>{
  const f=fixture(),property=structuredClone(f.reads[1]!),subject=structuredClone(f.reads[2]!);
  property.operation_id='property-repeat';subject.operation_id='subject-repeat';
  assert.deepEqual(checkTagScopeReadbackV1(f.scope,[...f.reads,property,subject]),checkTagScopeReadbackV1(f.scope,f.reads));
});
test('native no-argument subject method accepts omitted args, rejects supplied arguments',()=>{
  const f=fixture();for(const r of f.reads.filter(r=>r.operation_id.startsWith('subject')))delete r.input.body.operations[1].args;
  assert(checkTagScopeReadbackV1(f.scope,f.reads).declared_scope_satisfied);
  f.reads[2]!.input.body.operations[1].args=[101];
  assert.throws(()=>checkTagScopeReadbackV1(f.scope,f.reads),/tag_scope_subjects_read_invalid/);
});
for(const [name,change] of [
  ['family value',(r:any)=>r.payload.items[0].parameterDetails[0].valueString='Other'],
  ['subject UID',(r:any)=>r.payload.items[0].uniqueId='different'],
] as const)test(`conflicting repeated ${name} is rejected`,()=>{
  const f=fixture(),r=structuredClone(f.reads.at(-1)!);r.operation_id='conflict';change(r);
  assert.throws(()=>checkTagScopeReadbackV1(f.scope,[...f.reads,r]),/tag_scope_subject_family_conflict/);
});
test('conflicting repeated tag properties and associations are rejected',()=>{
  const f=fixture(),p=structuredClone(f.reads[1]!),s=structuredClone(f.reads[2]!);p.operation_id='conflict-p';s.operation_id='conflict-s';
  p.payload.operations[2].result_preview=true;
  assert.throws(()=>checkTagScopeReadbackV1(f.scope,[...f.reads,p]),/tag_scope_tag_read_conflict/);
  s.payload.results.subjects.items[0].unique_id='different';
  assert.throws(()=>checkTagScopeReadbackV1(f.scope,[...f.reads,s]),/tag_scope_subject_read_conflict/);
});
for(const [name,change] of [
  ['truncated census',(f:any)=>f.reads[0].payload.truncated=true],
  ['scan cap',(f:any)=>f.reads[0].payload.scanCapReached=true],
  ['filtered inventory',(f:any)=>f.reads[0].input.body.familyNameContains='Panel'],
  ['missing inventory item',(f:any)=>f.reads[0].payload.items.pop()],
  ['duplicate inventory',(f:any)=>f.reads[0].payload.elementIds[1]=1],
  ['missing candidate read',(f:any)=>f.reads.splice(3,1)],
  ['wrong owner',(f:any)=>f.reads[1].payload.operations[1].result_preview.id=20],
  ['missing property',(f:any)=>delete f.reads[1].payload.operations[2].result_preview],
  ['unbounded subjects',(f:any)=>f.reads[2].payload.results.subjects.complete=false],
  ['partial subjects',(f:any)=>f.reads[2].payload.results.subjects.hasMore=true],
  ['stale tag identity',(f:any)=>f.reads[2].payload.operations[0].result_preview.unique_id='different-tag-uid'],
  ['stale subject identity',(f:any)=>f.reads.at(-1).payload.items[0].uniqueId='different-subject-uid'],
  ['missing family',(f:any)=>f.reads.at(-1).payload.items[0].parameterDetails=[]],
  ['duplicate operation reference',(f:any)=>f.reads.push(structuredClone(f.reads[1]))],
  ['duplicate family row in one native batch',(f:any)=>f.reads.at(-1).payload.items.push(structuredClone(f.reads.at(-1).payload.items[0]))],
  ['worker pass flag',(f:any)=>f.scope.pass=true],
  ['empty matching rule',(f:any)=>f.scope.subject_family_names=['Nonexistent Family']],
] as const)test(`reject ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>checkTagScopeReadbackV1(f.scope,f.reads),/tag_scope_/);});
test('mixed subject tag cannot be silently excluded',()=>{
  const f=fixture(),c=f.reads[2]!.payload.results.subjects;
  c.items.push({id:103,unique_id:uid(103)});c.total=c.count=2;
  assert.throws(()=>checkTagScopeReadbackV1(f.scope,f.reads),/mixed_subjects_ambiguous/);
});
test('bounded selector rejects duplicates and unchecked broadening',()=>{
  const f=fixture();assert(validTagScopeRequestV1(f.scope));
  assert(!validTagScopeRequestV1({...f.scope,view_ids:[10,10]}));
  assert(!validTagScopeRequestV1({...f.scope,subject_family_names:[]}));
  assert(!validTagScopeRequestV1({...f.scope,category:'OST_Walls'}));
});
test('integral checker uses native bound bytes; invalidates after edits and preserves claims',()=>{
  const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-scope-'));
  process.env.OPERATOR_WORKSPACE_ROOT=root;
  try {
    const f=fixture(),binding={assignment_id:'assignment-scope',run_id:'run-scope',generation:1,session_id:'session-scope',principal_id:'principal-scope',document_fingerprint:'doc-scope'};
    const snapshot:any={current_binding:binding,operations:{},observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],work_plan_claims:[{item_id:'typical',verified:false}]};
    for(const read of f.reads) {
      const stored=storeEvidence({scope:{...binding,attempt_id:read.operation_id},source:'native-scope-read',trust_level:'authoritative_native',raw:read.payload});
      const hash=payloadDigestV2(read.payload).digest,oid='obs-'+read.operation_id;
      snapshot.operations[read.operation_id]={binding,input:read.input,operation_id:read.operation_id,requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'settled',
        opened_at:'2026-10-12T21:00:00Z',observation_ids:[oid],result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',completed_at:'2026-10-12T21:00:01Z',raw_payload_hash:hash}};
      snapshot.observations[oid]={binding,operation_id:read.operation_id,authority:'native-host',raw_payload_hash:hash,raw_payload_ref:'evidence:'+stored.ref.evidence_id};
    }
    const request={item_id:'typical',scope:f.scope,operation_ids:f.reads.map(r=>r.operation_id),requested_at:'2026-10-12T21:01:00Z'};
    snapshot.work_plan_scope_requests=[request];const before=JSON.stringify(snapshot);
    const result=checkWorkPlanScopeV1(snapshot,request);assert(result.available,JSON.stringify(result));assert(result.declared_scope_satisfied);
    assert.deepEqual(result.readback_window,{first_completed_at:'2026-10-12T21:00:01.000Z',last_completed_at:'2026-10-12T21:00:01.000Z'});
    assert.match(result.freshness_notice,/outside this assignment require new reads/);
    assert.equal(projectWorkPlanScopeChecksV1(snapshot).length,1);assert.equal(JSON.stringify(snapshot),before);
    for(const mutate of [()=>{snapshot.operations.inventory.binding={...binding,generation:2};},()=>{snapshot.operations.inventory.result.authority='assistant';},
      ()=>{snapshot.observations['obs-inventory'].raw_payload_hash='wrong';},()=>{snapshot.unresolved_unknown_operation_ids=['uncertain'];},
      ()=>{snapshot.operations.edit={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-12T21:02:00Z'};},
      ()=>{snapshot.operations.edit={requested_effect:'apply',persistent_effect:'applied',opened_at:'invalid'};},
      ()=>{snapshot.operations.inventory.result.completed_at='invalid';},
      ()=>{snapshot.operations.inventory.result.completed_at='2026-10-12T20:59:59Z';},
      ()=>{snapshot.operations.inventory.result.completed_at='2026-10-12T21:01:01Z';}]) {
      const s=structuredClone(snapshot);mutate();assert(!checkWorkPlanScopeV1(snapshot,request).available);Object.keys(snapshot).forEach(k=>delete snapshot[k]);Object.assign(snapshot,s);
    }
  } finally {
    __closeForTests();
    if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;
    // Test-owned temporary target, resolved and checked before recursive cleanup.
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
  }
});
