import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {collectRequestedFamilyScopeReadbacksV1} from '../src/verification/requested_family_scope_readback_v1.js';
import {checkWorkPlanScopeV1,selectWorkPlanScopeReadIdsV1} from '../src/assignments/work_plan_scope_check.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';import {payloadDigestV2} from '@revitoperator/payload-digest-v2';import {__closeForTests} from '../src/memory/sqlite_store.js';
const raw72=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/family-static-text-scope-72.json'),'utf8'));
const failure73=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/family-static-text-scope-failure-73.json'),'utf8'));
const fixture=()=>{
 const f=structuredClone(failure73),request=f.request;
 return {request,snapshot:{current_binding:f.current_binding,operations:f.operations,observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],
  terminal:false,outcome:'active',work_plan_scope_requests:[request]} as any};
};
for(const variant of ['exact','body_reordered','truncated_inventory','wrong_family_type','native_refused','paused_before','unknown_before','foreign_before',
 'paused_during','unknown_during','new_edit_during','native_payload_tampered','new_request_during','ambiguous_reference'] as const)
test('host scope '+variant+' follows retained73 refusal and derives only complete native sample reads',async()=>{
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-requested-scope-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const f=fixture(),s=f.snapshot,binding=structuredClone(s.current_binding),plans:any[]=[],request=f.request,refreshed:any[]=[];
  assert.deepEqual(selectWorkPlanScopeReadIdsV1(s,request.scope),[],'Exact retained filtered inputs after SaveAs cannot prove complete scope');
  const failed=checkWorkPlanScopeV1(s,request);assert(!failed.available);assert.equal(failed.reason,'scope_check_no_current_native_reads');
  if(variant==='paused_before')s.execution_control={state:'paused'};
  if(variant==='unknown_before')s.unresolved_unknown_operation_ids=['old-unknown'];
  if(variant==='foreign_before')s.current_binding={...binding,generation:2};
  const call=()=>collectRequestedFamilyScopeReadbacksV1(binding,request,{current:()=>s,
   read:async(plan,id)=>{
    plans.push(plan);assert.equal(plan.method,'POST');assert(!('contains' in plan.body));assert(!('familyNameContains' in plan.body));
    if(variant==='native_refused')return {success:false};
    const native=plan.path==='/revit/find-elements'?raw72.reads[0]:raw72.reads.find((r:any)=>r.payload.source?.elementId===plan.body.elementId);
    assert(native);const payload=structuredClone(native.payload);
    // Neighbor contract: same native content, ordinary unfiltered inspection
    // with other-element output disabled, so no material/style records reach actor.
    if(plan.path==='/revit/inspect-family-content'){
     payload.otherElements=[];payload.familyParameters=[];
     payload.inventory.returnedElementCount=payload.staticText.length+payload.labels.length+payload.nestedInstances.length;
    }
    if(variant==='truncated_inventory'&&plan.path==='/revit/find-elements')payload.truncated=true;
    if(variant==='wrong_family_type'&&plan.path==='/revit/inspect-family-content')payload.source.typeId=1;
    const stored=storeEvidence({scope:{...binding,attempt_id:id},source:'native-scope-read',trust_level:'authoritative_native',raw:payload}),hash=payloadDigestV2(payload).digest,oid='obs:'+id;
    const now=new Date().toISOString();s.operations[id]={operation_id:id,binding,input:variant==='body_reordered'?{...plan,body:Object.fromEntries(Object.entries(plan.body).reverse())}:plan,requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'settled',opened_at:now,observation_ids:[oid],result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',completed_at:now,raw_payload_hash:hash}};
    s.observations[oid]={binding,operation_id:id,authority:'native-host',raw_payload_hash:variant==='native_payload_tampered'?'tampered':hash,raw_payload_ref:'evidence:'+stored.ref.evidence_id};
    if(variant==='ambiguous_reference')s.operations['duplicate:'+id]={...s.operations[id],operation_id:'duplicate:'+id};
    if(variant==='paused_during')s.execution_control={state:'paused'};
    if(variant==='unknown_during')s.unresolved_unknown_operation_ids=['old-unknown'];
    if(variant==='new_edit_during')s.operations.newEdit={operation_id:'newEdit',requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:now};
    if(variant==='new_request_during')s.work_plan_scope_requests.push({...request,requested_at:'2099-01-01T00:00:00Z'});
    return {success:true};
   },refresh:async ids=>{refreshed.push([...ids]);const req={...request,operation_ids:ids,requested_at:new Date().toISOString()};s.work_plan_scope_requests.push(req);return checkWorkPlanScopeV1(s,req);}});
  if(variant==='exact'||variant==='body_reordered'||variant==='wrong_family_type'){
   const result=await call();assert(result);assert.equal(plans.length,3);assert.equal(refreshed.length,1);
   assert.deepEqual(plans.map(p=>p.body.elementId).filter(Boolean),[1391113,1709388]);
   if(variant!=='wrong_family_type'){assert((result.result as any).declared_scope_satisfied);assert.equal((result.result as any).satisfied_count,26);}
   else assert(!(result.result as any).available);
  }else {
   await assert.rejects(call);assert.equal(refreshed.length,0);
   assert.equal(plans.length,variant.endsWith('_before')?0:1,'One bounded pass; no unbounded retries, hidden narrowing or model writes');
  }
  if(variant.startsWith('unknown'))assert.deepEqual(s.unresolved_unknown_operation_ids,['old-unknown']);
 }finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
test('explicit actor references, unsupported scope kinds and available native results are not automatically replaced',async()=>{
 const f=fixture();let called=false;
 for(const req of [{...f.request,read_selection:undefined},{...f.request,scope:{kind:'unsupported'}}])
  assert.equal(await collectRequestedFamilyScopeReadbacksV1(f.snapshot.current_binding,req as any,{current:()=>f.snapshot,read:async()=>{called=true;return{};},refresh:async()=>{called=true;return{};}}),null);
 assert(!called);
});
