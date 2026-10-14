import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {checkFamilyStaticTextScopeV1} from '../src/verification/family_static_text_scope_v1.js';
import {validFamilyStaticTextScopeV1,type FamilyStaticTextScopeV1} from '../src/domain/assignment-kernel/work_plan_family_scope.js';
import {validWorkPlanScopeV1} from '../src/domain/assignment-kernel/work_plan_scope.js';
import {checkWorkPlanScopeV1,selectWorkPlanScopeReadIdsV1} from '../src/assignments/work_plan_scope_check.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';import {payloadDigestV2} from '@revitoperator/payload-digest-v2';import {__closeForTests} from '../src/memory/sqlite_store.js';
import {projectWorkReviewV2} from '../src/assignments/work_review_handoff.js';
const retained=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/family-static-text-scope-72.json'),'utf8'));
const fixture=()=>structuredClone(retained) as {scope:FamilyStaticTextScopeV1,reads:any[]};
test('retained72 complete native category and two family samples cover every26 instance without actor counts or edits',()=>{
 const f=fixture(),before=JSON.stringify(f),r=checkFamilyStaticTextScopeV1(f.scope,f.reads);
 assert(r.declared_scope_satisfied);assert.equal(r.satisfied_count,26);assert.equal(r.matched_count,26);
 assert.equal(r.family_type_proofs.length,2);assert.equal(r.excluded_count,0);assert.equal(JSON.stringify(f),before);
 assert(validWorkPlanScopeV1(f.scope));assert.match(r.notice,/does not certify visible instance text/);
});
test('wrong wording/punctuation fails all instances sharing the changed family; no empty success',()=>{
 const f=fixture();f.reads[2].payload.staticText.find((t:any)=>t.text.includes('WSP')).text=f.reads[2].payload.staticText.find((t:any)=>t.text.includes('WSP')).text.replace('Dr,','Dr');
 const r=checkFamilyStaticTextScopeV1(f.scope,f.reads);assert(!r.declared_scope_satisfied);assert.equal(r.satisfied_count,25);assert.deepEqual(r.failed_target_ids,[1709388]);
 assert.equal(checkFamilyStaticTextScopeV1({...f.scope,expected_text:'Different Company'},f.reads).satisfied_count,0);
 assert.equal(checkFamilyStaticTextScopeV1({...f.scope,expected_text:'1001 Morehead Square Dr'},f.reads).satisfied_count,1,'terminal punctuation is exact, not a prefix match');
});
for(const [name,mutate] of [
 ['one type missing',(f:any)=>f.reads.pop()],
 ['filtered census',(f:any)=>f.reads[0].input.body.familyName='Cover'],
 ['view census',(f:any)=>f.reads[0].payload.scope.kind='View'],
 ['truncated census',(f:any)=>f.reads[0].payload.truncated=true],
 ['incomplete items',(f:any)=>f.reads[0].payload.itemsComplete=false],
 ['dropped item',(f:any)=>f.reads[0].payload.items.pop()],
 ['duplicate item',(f:any)=>f.reads[0].payload.items[1]=f.reads[0].payload.items[0]],
 ['wrong category',(f:any)=>f.reads[0].payload.items[0].builtInCategory='OST_GenericAnnotation'],
 ['hidden actor subset',(f:any)=>f.scope.instance_ids=[1709388]],
 ['different native category',(f:any)=>f.reads[0].payload.resolvedCategories[0].requested='Other'],
 ['family filtered input',(f:any)=>f.reads[1].input.body.contains='WSP'],
 ['family filtered payload',(f:any)=>f.reads[1].payload.query='WSP'],
 ['family truncated',(f:any)=>f.reads[1].payload.inventory.truncated=true],
 ['type join changed',(f:any)=>f.reads[1].payload.source.typeId=1],
 ['source not in census',(f:any)=>f.reads[1].payload.source.elementId=1],
 ['family identity omitted',(f:any)=>delete f.reads[1].payload.source.familyId],
 ['mutated inspection',(f:any)=>f.reads[1].payload.mutated=true],
 ['incomplete class census',(f:any)=>f.reads[1].payload.inventory.scannedElementCount++],
 ['omitted static text',(f:any)=>f.reads[1].payload.staticText.pop()],
 ['duplicate static identity',(f:any)=>f.reads[1].payload.staticText[1]=f.reads[1].payload.staticText[0]],
 ['claim fake success',(f:any)=>f.scope.verified=true],
] as const)test('native scope rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>checkFamilyStaticTextScopeV1(f.scope,f.reads),/family_static_text_scope_/);});
test('conflicting repeat family inspection is unavailable; matching repeat is acceptable',()=>{
 const f=fixture(),repeat=structuredClone(f.reads[1]);repeat.operation_id='repeat';f.reads.push(repeat);
 assert(checkFamilyStaticTextScopeV1(f.scope,f.reads).declared_scope_satisfied);
 repeat.payload.staticText[0].text='Changed';assert.throws(()=>checkFamilyStaticTextScopeV1(f.scope,f.reads),/family_read_conflict/);
});
test('scope shape rejects subset/worker proofs and preserves a general wording contract',()=>{
 const f=fixture();for(const v of [{...f.scope,expected_text:''},{...f.scope,expected_text:' x'},
  {...f.scope,expected_text:'x\0'},{...f.scope,expected_text:'x'.repeat(2049)},
  {...f.scope,category:'OST_bad token'},{...f.scope,types:[1704694]},{...f.scope,expected_count:26}])assert(!validFamilyStaticTextScopeV1(v));
 const g=fixture();g.scope={...g.scope,expected_text:'Some other firm\nAddress'};for(const r of g.reads.slice(1))r.payload.staticText[0].text='Some other firm\rAddress';assert(checkFamilyStaticTextScopeV1(g.scope,g.reads).declared_scope_satisfied);
});
test('integral authenticated retained72 bytes expose26 native coverage without completing source items; newest failure and all freshness fences remain',()=>{
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-family-scope-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const f=fixture(),binding={assignment_id:'scope',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'doc'};
  const s:any={current_binding:binding,operations:{},observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],work_plan_claims:[{item_id:'firm',verified:false}]};
  for(const r of f.reads){const stored=storeEvidence({scope:{...binding,attempt_id:r.operation_id},source:'native-family-read',trust_level:'authoritative_native',raw:r.payload}),hash=payloadDigestV2(r.payload).digest,oid='obs:'+r.operation_id;
   s.operations[r.operation_id]={operation_id:r.operation_id,binding,input:r.input,requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'settled',opened_at:'2026-10-14T11:30:00Z',observation_ids:[oid],result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',completed_at:'2026-10-14T11:31:00Z',raw_payload_hash:hash}};
   s.observations[oid]={binding,operation_id:r.operation_id,authority:'native-host',raw_payload_hash:hash,raw_payload_ref:'evidence:'+stored.ref.evidence_id};
  }
  const req={item_id:'firm',scope:f.scope,operation_ids:selectWorkPlanScopeReadIdsV1(s,f.scope),requested_at:'2026-10-14T11:32:00Z'},before=JSON.stringify(s);
  assert.equal(req.operation_ids.length,3);const result=checkWorkPlanScopeV1(s,req);assert(result.available,JSON.stringify(result));assert(result.declared_scope_satisfied);assert.equal(result.satisfied_count,26);assert.equal(JSON.stringify(s),before);
  const missing=checkWorkPlanScopeV1(s,{...req,operation_ids:req.operation_ids.slice(0,2)});assert(!missing.available);assert.match(missing.guidance??'',/EVERY returned type/);
  const shown={...s,assignment_version:20,work_plan_scope_requests:[req],work_plan:{schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[{item_id:'firm',description:'Firm wording typical',source_basis:'Original mark',kind:'edit',declared_at:'2026-10-14T11:29:00Z',operation_ids:[],location_history:[]}]},work_plan_claims:[{item_id:'firm',verified:false,operation_ids:[],claimed_at:'2026-10-14T11:32:01Z'}],spec:{requested_effect:'apply'},in_flight_provider_call_ids:[],execution_failure_ids:[],pending_input_variable_ids:[]};
  const review=projectWorkReviewV2(shown);assert.equal(review.checked_scope_count,1);assert.equal(review.checked_edit_count,0);assert.equal(review.counts.checked,0);assert.equal(review.counts.reported_unverified,1);
  const id=f.reads[1].operation_id;
  for(const change of [(x:any)=>x.unresolved_unknown_operation_ids=['old-unknown'],(x:any)=>x.in_flight_operation_ids=['active'],
   (x:any)=>x.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-14T11:31:01Z'},
   (x:any)=>x.operations[id].binding={...binding,generation:2},(x:any)=>x.observations['obs:'+id].raw_payload_hash='tampered',
   (x:any)=>x.operations[id].result.authority='assistant',(x:any)=>x.input_invalidated_operation_ids=[id]]){
   const altered=structuredClone(s);change(altered);assert(!checkWorkPlanScopeV1(altered,req).available);
  }
  const newer=structuredClone(s.operations[id]);newer.operation_id='newer';newer.opened_at='2026-10-14T11:31:01Z';newer.result.status='failed_after_dispatch';
  const changed={...s,operations:{...s.operations,newer}};const selected=selectWorkPlanScopeReadIdsV1(changed,f.scope);assert(selected.includes('newer'));assert(!selected.includes(id));assert(!checkWorkPlanScopeV1(changed,{...req,operation_ids:selected}).available);
 }finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
