import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';
import {verifiedChangePresentationV2} from '../src/assignments/verified_change_presentation_v2.js';

function fixture(parametersOnly=false, className='IndependentTag', category='Electrical Equipment Tags') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-annotation-presentation-'));
 const previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 const binding={assignment_id:'annotation',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'project'};
 const snapshot:any={current_binding:binding,operations:{},observations:{},criteria:{},spec:{requested_effect:'apply'},terminal:true,outcome:'complete',assignment_version:20};
 const add=(id:string,route:string,payload:unknown,apply=false)=>{
  const stored=storeEvidence({scope:{...binding,attempt_id:id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload});
  const completed_at=apply?'2026-10-20T10:00:00Z':'2026-10-20T10:00:01Z';
  const hash=payloadDigestV2(payload).digest;
  snapshot.operations[id]={operation_id:id,binding,capability_id:`native:POST:${route}`,request_identity:{method:'POST',path:route},
   requested_effect:apply?'apply':'read',purpose:apply?'task':'verification',persistent_effect:apply?'applied':'none',settlement_state:'settled',
   verification_operation_ids:[],observation_ids:[id],result:{binding,status:'succeeded',authority:'native-host',
    native_transaction_state:apply?'committed':'not_applicable',completed_at,raw_payload_hash:hash,persistent_effect:apply?'applied':'none'}};
  snapshot.observations[id]={observation_id:id,operation_id:id,binding,authority:'native-host',evidence_class:apply?'task_result':'verification',
   observed_at:completed_at,raw_payload_ref:`evidence:${stored.ref.evidence_id}`,raw_payload_hash:hash,
   facts:[apply?{fact_id:'task.result_available',fact_class:'domain',value:true}:{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]};
  snapshot.criteria[id]={status:'pass',supporting_facts:[{observation_id:id}]};
 };
 add('edit','/revit/change-element-type',{ok:true,elementIds:[42,43]},true);
 snapshot.operations.edit.result.affected_target_identities=['element_id:42','element_id:43'];
 add('read',parametersOnly?'/revit/get-parameters':'/revit/get-element-summary',parametersOnly
  ?{items:[42,43].map(id=>({id,uniqueId:`tag-${id}`,category:'Electrical Equipment Tags',parameters:{Type:'84'}}))}
  :{result:[42,43].map(id=>({id,found:true,className,category}))});
 snapshot.operations.edit.verification_operation_ids=['read'];snapshot.operations.read.verification_of_operation_id='edit';
 snapshot.operations.read.target={target_id:'id:42',semantic_scope:{second:'id:43'}};
 add('file','/revit/inspect-exported-files',{schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,files:[{exists:true,readable:true,path:'artifacts/families/intermediate.rfa'}]});
 return {snapshot,close:()=>{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}};
}

for(const parametersOnly of [false,true])test(`only native class identity supports placed-tag wording (${parametersOnly?'parameter':'summary'} readback)`,()=>{
 const f=fixture(parametersOnly);try {
  assert.equal(verifiedChangePresentationV2(f.snapshot),parametersOnly?null:'Verified in Revit: 2 annotation tags.');
  const before=structuredClone(f.snapshot),result=deriveTerminalResultV2(f.snapshot);
  assert.equal(result.result_summary,(parametersOnly?'':'Verified in Revit: 2 annotation tags.\n')+'Verified file: artifacts/families/intermediate.rfa');
  assert.doesNotMatch(result.result_summary,/underlined|all tags|visual|readable/,'presentation must not invent a property or visual proof');
  assert.deepEqual(f.snapshot,before);
 }finally{f.close();}
});
for(const [className,category,kind] of [
 ['FamilySymbol','Air Terminal Tags','family type'],['Family','Air Terminal Tags','family definition'],
 ['ElementType','Mechanical Equipment','element type'],['DuctType','Ducts','element type'],
 ['Element','Air Terminal Tags',null],['','Air Terminal Tags',null],['','Ducts',null],
 ['FamilyInstance','Mechanical Equipment','mechanical equipment'],['Duct','Ducts','duct segment'],
 ['RoomTag','Room Tags','annotation tag'],['SpaceTag','Space Tags','annotation tag']
] as const)test(`native ${className||'unknown class'} in ${category} is never inferred from category alone`,()=>{
 const f=fixture(false,className,category);try{assert.equal(verifiedChangePresentationV2(f.snapshot),kind?`Verified in Revit: 2 ${kind}${kind==='mechanical equipment'?'':'s'}.`:null);}finally{f.close();}
});
for(const variant of ['foreign','unverified','changed-hash','stale','unknown','outside-target','missing-read'])test(`tag summary cannot claim ${variant} project verification`,()=>{
 const f=fixture(),s=f.snapshot;try {
  if(variant==='foreign')s.operations.read.result.binding={...s.current_binding,run_id:'other'};
  if(variant==='unverified')s.observations.read.facts[0].value=false;
  if(variant==='changed-hash')s.observations.read.raw_payload_hash='sha256:wrong';
  if(variant==='stale')s.operations.read.result.completed_at='2026-10-20T09:59:00Z';
  if(variant==='unknown')s.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'unknown',opened_at:'2026-10-20T10:00:02Z'};
  if(variant==='outside-target')s.operations.read.target={target_id:'id:44',semantic_scope:{}};
  if(variant==='missing-read')s.operations.read.observation_ids=[];
  assert.equal(verifiedChangePresentationV2(s),null);
 }finally{f.close();}
});
