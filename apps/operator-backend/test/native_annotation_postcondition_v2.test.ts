import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeAnnotationCommitTargetV2,nativeAnnotationReadbackMatchesV2,committedNativeAnnotationReadbackPlanV2,nativeAnnotationPostconditionSatisfiedV2,annotationPreservedScheduleAtCommitV2} from '../src/verification/native_annotation_postcondition_v2.js';
import {verificationCapabilityAdmissionV2,operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {codexAssignmentEvidenceContextV2} from '../src/brains/codex_assignment_evidence.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../src/domain/assignment-kernel/verified_work_targets.js';
import {checkedEditIsCurrentV2} from '../src/verification/current_postcondition_v2.js';
import {regularScheduleCheckNeedsRefreshV2} from '../src/verification/regular_schedule_recheck_v2.js';
import {regularSchedulePresentationReadbackMatchesV2} from '../src/verification/regular_schedule_presentation_v2.js';

function fixture(kind:'text'|'panel'|'schedule'|'viewport'|'typed_viewport'|'typed_viewport_name',creating=false):any {
 const text=kind==='text',viewport=kind.includes('viewport'),typed=kind.startsWith('typed_'),named=kind==='typed_viewport_name',id=800,viewId=text?100:200,sheetId=100;
 const input={method:'POST',path:text?'/revit/create-text':'/revit/place-view',body:text
  ?{action:'create',viewId,x:.15,y:1.18,text:'Material key\nCopper',typeId:300,widthFt:.78,dryRun:false}
  :{sheetId,viewId,x:1.5,y:2.3,moveIfAlreadyPlaced:true,avoidOverlap:false,...(typed?named?{viewportTypeName:'Office no title'}:{viewportTypeId:301}:{}),dryRun:false}};
 const applied:any={success:true,applied:true,status:text?'Success':creating?'Placed':'Moved',action:text?'create':creating?'Create':'MoveExisting',
  viewId,transaction:{status:'committed',committed:true,added_element_ids:text||creating?[id]:[],
   modified_element_ids:text||creating?[]:[id],deleted_element_ids:[],affected_element_ids:[id]},
  changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}};
 const read=text?{ok:true,scope:'active_project',requestedElementIds:[id],exactElementFilterApplied:true,itemsComplete:true,elementIds:[id],
  items:[{textNoteId:id,elementId:id,uniqueId:'native-note-unique-id',ownerViewId:viewId,ownerViewUniqueId:'native-owner-unique-id',
   textTypeId:300,textTypeUniqueId:'native-type-unique-id',text:'MATERIAL KEY\rCOPPER\r',location:{x:.15,y:1.18,z:0},widthFeet:.78}]}
  :{status:'Ok',action:'detail',sheetId,sheetElementId:sheetId,placedScheduleCount:viewport?0:1,viewportCount:viewport?1:0,
   placedSchedules:viewport?[]:[{instanceId:id,scheduleId:viewId,placementType:kind==='panel'?'PanelScheduleSheetInstance':'ScheduleSheetInstance',point:{u:1.5,v:2.3,z:0}}],
   viewportGeometry:viewport?[{viewportId:id,viewId,center:{u:1.5,v:2.3,z:0},...(typed?{viewportType:{id:301,name:'Office no title'}}:{})}]:[]};
 if(text)Object.assign(applied,{textNoteId:id,textType:{id:300,name:'Office note'},
  textNote:{textNoteId:id,viewId,textType:{id:300},text:'MATERIAL KEY\rCOPPER\r'}});
 else Object.assign(applied,{id,sheetId,x:1.5,y:2.3,placementType:kind==='panel'?'PanelScheduleSheetInstance':kind==='schedule'?'ScheduleSheetInstance':'Viewport',
  ...(typed?{viewportType:{requested:{viewportTypeId:named?null:301,viewportTypeName:named?'Office no title':null},typeId:301,typeName:'Office no title',applied:true,message:null}}:{})});
 return {input,applied,read,id};
}

function noteWithPreservedSchedule():any {
 const f=fixture('text'),schedule={elementId:901,uniqueId:'native-schedule-901',complete:true,
  scope:'flat_definition_table_parameters',definition:{schema:'operator.schedule_definition_snapshot.v1',complete:true,
   identity:{id:901,uniqueId:'native-schedule-901',kind:'regular'},definition:{fields:[],table:[],tableStyles:[]}},
  parameters:[]};
 f.applied.transaction.modified_element_ids=[901];f.applied.transaction.affected_element_ids=[800,901];
 f.applied.schedulePreservation={schema:'operator.annotation_schedule_preservation.v1',complete:true,
  scheduleIds:[901],before:[schedule],after:[structuredClone(schedule)]};
 f.read.schedulePreservation={schema:'operator.annotation_schedule_read.v1',complete:true,
  requestedElementIds:[901],items:[structuredClone(schedule)]};return f;
}

test('retained462 native note and six schedule owners never gain retrospective preservation proof',()=>{
 const here=path.dirname(fileURLToPath(import.meta.url)),relative='fixtures/annotation-six-schedules-462.json';
 const file=fs.existsSync(path.join(here,relative))?path.join(here,relative):path.resolve(here,'../../test',relative);
 const old=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 assert.equal(old.applied.transaction.modified_element_ids.length,6);
 assert.equal(nativeAnnotationCommitTargetV2(old.input,old.applied),null);
 for(const id of old.applied.transaction.modified_element_ids){const one=structuredClone(old.applied);one.transaction.modified_element_ids=[id];one.transaction.affected_element_ids=[old.applied.textNoteId,id];assert.equal(nativeAnnotationCommitTargetV2(old.input,one),null);}
});

test('annotation workflow: complete native schedule preservation plus a separate exact read permits save eligibility',()=>{
 const f=noteWithPreservedSchedule(),c=nativeAnnotationCommitTargetV2(f.input,f.applied);
 assert(c,'New complete preservation proof must recognize the committed note without dropping collateral IDs');
 assert.deepEqual(c.read.body,{elementIds:[800],max:1,preservationScheduleIds:[901]});
 assert(nativeAnnotationReadbackMatchesV2(f.input,f.applied,c.read,f.read));
});

test('annotation workflow: verification principal scope includes the independently read preserved schedules',()=>{
 const operation:any={capability_id:'revit_call_tool',path:'/revit/find-text-notes',arguments:{method:'POST',path:'/revit/find-text-notes',body:{elementIds:[800],max:1,preservationScheduleIds:[901]}}};
 const s=operationTargetSelectorV2({operation,value:operation.arguments.body});
 assert(s.principal_target_tokens.includes('id:901'),'Preserved schedule is an actual read target, never contextual view scope');
});

test('annotation workflow preservation fails closed for incomplete, changed, foreign and unobserved collateral',()=>{
 const base=noteWithPreservedSchedule();
 for(const [name,change] of [
  ['old462 style missing proof',(f:any)=>delete f.applied.schedulePreservation],
  ['incomplete before',(f:any)=>f.applied.schedulePreservation.before[0].complete=false],
  ['incomplete definition',(f:any)=>f.applied.schedulePreservation.before[0].definition.complete=false],
  ['wrong snapshot owner',(f:any)=>f.applied.schedulePreservation.before[0].elementId=999],
  ['changed table',(f:any)=>f.applied.schedulePreservation.after[0].definition.definition.table=[{text:'CHANGED'}]],
  ['changed parameter',(f:any)=>f.applied.schedulePreservation.after[0].parameters=[{id:1,value:'CHANGED'}]],
  ['unobserved collateral',(f:any)=>{f.applied.transaction.modified_element_ids.push(902);f.applied.transaction.affected_element_ids.push(902)}],
  ['deleted collateral',(f:any)=>f.applied.transaction.deleted_element_ids=[901]],
  ['false complete',(f:any)=>f.applied.schedulePreservation.complete=false],
  ['duplicate before',(f:any)=>f.applied.schedulePreservation.before.push(f.applied.schedulePreservation.before[0])],
 ] as Array<[string,(f:any)=>void]>){const f=structuredClone(base);change(f);assert.equal(nativeAnnotationCommitTargetV2(f.input,f.applied),null,name);}
 const c=nativeAnnotationCommitTargetV2(base.input,base.applied)!;
 for(const [name,change] of [
  ['missing readproof',(f:any)=>delete f.read.schedulePreservation],
  ['read incomplete',(f:any)=>f.read.schedulePreservation.complete=false],
  ['wrong readscope',(f:any)=>f.read.schedulePreservation.requestedElementIds=[999]],
  ['different current UID',(f:any)=>f.read.schedulePreservation.items[0].uniqueId='different-native-uid'],
  ['current table changed',(f:any)=>f.read.schedulePreservation.items[0].definition.definition.table=[{text:'CHANGED'}]],
  ['no exact requested selectors',(f:any)=>f.read.requestedElementIds=[]],
 ] as Array<[string,(f:any)=>void]>){const f=structuredClone(base);change(f);assert.equal(nativeAnnotationReadbackMatchesV2(f.input,f.applied,c.read,f.read),false,name);}
 const plain=fixture('text');assert(nativeAnnotationCommitTargetV2(plain.input,plain.applied));
 assert.deepEqual(nativeAnnotationCommitTargetV2(plain.input,plain.applied)!.read.body,{elementIds:[800],max:1});
});

for(const kind of ['text','panel','schedule','viewport','typed_viewport','typed_viewport_name'] as const)
for(const creating of [false,true])test(`native ${kind} ${creating?'create':'move'} requires a separate exact attribute/anchor read`,()=>{
 const f=fixture(kind,creating),c=nativeAnnotationCommitTargetV2(f.input,f.applied)!;
 assert(c);assert(nativeAnnotationReadbackMatchesV2(f.input,f.applied,c.read,f.read));
 assert(!nativeAnnotationReadbackMatchesV2(f.input,f.applied,f.input,f.applied),'apply echo is not proof');
 for(const [name,change] of [
  ['no commit',(n:any)=>n.applied.transaction.committed=false],
  ['pending',(n:any)=>n.applied.transaction.pending=true],
  ['incomplete inventory',(n:any)=>n.applied.changeTracking.exhaustiveChangeInventory=false],
  ['foreign change',(n:any)=>n.applied.transaction.modified_element_ids.push(999)],
  ['deleted collateral',(n:any)=>n.applied.transaction.deleted_element_ids=[900]],
  ['truncated',(n:any)=>n.read.truncated=true],
  ['missing identity',(n:any)=>kind==='text'?n.read.items[0].elementId++:n.read[kind.includes('viewport')?'viewportGeometry':'placedSchedules'][0][kind.includes('viewport')?'viewportId':'instanceId']++],
  ['wrong owner',(n:any)=>kind==='text'?n.read.items[0].ownerViewId++:n.read.sheetId++],
  ['wrong point',(n:any)=>kind==='text'?n.read.items[0].location.x++:n.read[kind.includes('viewport')?'viewportGeometry':'placedSchedules'][0][kind.includes('viewport')?'center':'point'].u++],
  ['missing Z',(n:any)=>kind==='text'?delete n.read.items[0].location.z:delete n.read[kind.includes('viewport')?'viewportGeometry':'placedSchedules'][0][kind.includes('viewport')?'center':'point'].z],
 ] as Array<[string,(n:any)=>void]>){const n=structuredClone(f);change(n);assert.equal(nativeAnnotationReadbackMatchesV2(n.input,n.applied,c.read,n.read),false,name);}
 if(kind==='text')for(const change of [(n:any)=>n.read.items[0].text+=' EXTRA',(n:any)=>n.read.items[0].textTypeId++,
  (n:any)=>n.read.items[0].widthFeet++,(n:any)=>n.read.items[0].uniqueId=null,(n:any)=>n.read.itemsComplete=false,
  (n:any)=>n.input.body.action='create_type']){const n=structuredClone(f);change(n);assert(!nativeAnnotationReadbackMatchesV2(n.input,n.applied,c.read,n.read));}
 else {const n=structuredClone(f);n.input.body.lockViewport=true;assert(!nativeAnnotationCommitTargetV2(n.input,n.applied));}
});

for(const kind of ['typed_viewport','typed_viewport_name'] as const)
test(`${kind}: matching anchor never substitutes for requested viewport type readback`,()=>{
 const f=fixture(kind),c=nativeAnnotationCommitTargetV2(f.input,f.applied)!;assert(c);
 for(const [name,change] of [
  ['wrong read type',(n:any)=>n.read.viewportGeometry[0].viewportType.id++],
  ['missing read type',(n:any)=>delete n.read.viewportGeometry[0].viewportType],
  ['wrong read name',(n:any)=>n.read.viewportGeometry[0].viewportType.name='Different office type'],
  ['failed native type change',(n:any)=>n.applied.viewportType.applied=false],
  ['unreported type change',(n:any)=>delete n.applied.viewportType],
  ['different requested ID',(n:any)=>n.applied.viewportType.requested.viewportTypeId=999],
  ['different requested name',(n:any)=>n.applied.viewportType.requested.viewportTypeName='Other'],
  ['missing resolved ID',(n:any)=>n.applied.viewportType.typeId=null],
  ['conflicting requested selectors',(n:any)=>{n.input.body.viewportTypeId=301;n.input.body.viewportTypeName='Other';n.applied.viewportType.requested={viewportTypeId:301,viewportTypeName:'Other'};}],
  ['unexpected additional edited type',(n:any)=>{n.applied.transaction.modified_element_ids.push(301);n.applied.transaction.affected_element_ids.push(301);}],
  ['schedule silently ignored type selector',(n:any)=>{n.applied.placementType='ScheduleSheetInstance';n.read.placedSchedules=[{instanceId:800,scheduleId:200,placementType:'ScheduleSheetInstance',point:{u:1.5,v:2.3,z:0}}];n.read.placedScheduleCount=1;n.read.viewportCount=0;n.read.viewportGeometry=[];}],
  ['invalid ID',(n:any)=>n.input.body.viewportTypeId=0],
  ['empty name',(n:any)=>n.input.body.viewportTypeName='   '],
 ] as Array<[string,(n:any)=>void]>){const n=structuredClone(f);change(n);assert.equal(nativeAnnotationReadbackMatchesV2(n.input,n.applied,c.read,n.read),false,name);}
});

const variants=['exact','wrong_value','wrong_owner','read_failure','schema_rejected','paused','stale','foreign_authority','pending','missing_inventory','unknown'] as const;
function widthBeforeNoteFixture():any {
 const field={fieldId:1,isHidden:false,semanticHash:'b'.repeat(64),attributes:{fieldId:1,name:'Area',parameterId:-1,parameterUniqueId:null,fieldType:'Instance',isCalculated:false,isCombined:false,heading:'Area',headingOrientation:'Horizontal',horizontalAlignment:'Center',gridWidthFeet:.2,sheetWidthFeet:.2,style:{preservedStyleHash:'c'.repeat(64)},parts:[]}};
 const before={schema:'operator.regular_schedule_field_definition.v1',complete:true,scheduleId:901,uniqueId:'native-schedule-901',categoryId:-2003600,coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',configurationHash:'a'.repeat(64),fieldOrder:[1],fields:[field]};
 const after=structuredClone(before);after.fields[0]!.attributes.gridWidthFeet=.3;after.fields[0]!.attributes.sheetWidthFeet=.3;after.fields[0]!.semanticHash='d'.repeat(64);
 const presentation={schema:'operator.regular_schedule_presentation.v1',complete:true,fieldOrder:[1]};
 const input={method:'POST',path:'/revit/configure-schedule',body:{scheduleId:901,fieldFormats:[{field:'Area',widthFeet:.3}],dryRun:false}};
 const applied={status:'Success',success:true,applied:true,dryRun:false,schedule:{id:901,uniqueId:'native-schedule-901'},transaction:{status:'committed',committed:true,added_element_ids:[],modified_element_ids:[901],deleted_element_ids:[],affected_element_ids:[901]},changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0},definitionBefore:before,definitionAfter:after,presentationReadback:presentation};
 const read={status:'Ok',action:'presentation',read_only:true,schedule:{id:901,uniqueId:'native-schedule-901',kind:'schedule'},definition:structuredClone(after),presentation:structuredClone(presentation)};
 return{input,applied,read};
}
for(const kind of ['text','panel','viewport','typed_viewport','typed_viewport_name'] as const)
for(const variant of [...variants,...(kind.startsWith('typed_')?['wrong_type','missing_type'] as const:[]),
 ...(kind==='text'?['preserved_schedule','preserved_schedule_changed','preserved_schedule_after_width','preserved_schedule_after_width_current_mismatch','preserved_schedule_after_width_scope_mismatch'] as const:[])])
test(`shared dispatcher ${kind}/${variant}: host plans independent native read and retains honest checking state`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-annotation-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=variant.startsWith('preserved_schedule')?noteWithPreservedSchedule():fixture(kind),readPath=kind==='text'?'/revit/find-text-notes':'/revit/sheets';
  const width=widthBeforeNoteFixture();
  if(variant==='missing_inventory')f.applied.changeTracking.exhaustiveChangeInventory=false;
  const goal=createGoal({title:'Complete the requested drawing annotation',objective:'Complete the requested drawing annotation.',acceptance_criteria:['Requested annotation is saved and checked.'],status:'active',
   related_session_id:'annotation-session',created_by:'annotation-principal',work_budget:{requested_effect:'apply',document_fingerprint:'annotation-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'annotation-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,a:any){validations.push(a);if(variant==='schema_rejected'&&a.path===readPath)throw Error('read_schema_rejected');},
   async callTool(_tool:string,a:any,context:any){
    calls.push(a);const lease=context.assignmentKernelV2;context.onMcpAccepted();const widthCall=a.path==='/revit/configure-schedule'||a.path==='/revit/schedules';const read=a.path===readPath||a.path==='/revit/schedules';
    if(read&&variant==='read_failure')throw Error('native_read_failed');const payload=structuredClone(widthCall?(read?width.read:width.applied):read?f.read:f.applied);
    if(variant==='preserved_schedule_after_width_current_mismatch'&&a.path==='/revit/schedules'&&calls.filter(c=>c.path===a.path).length===2)
      payload.definition.fields[0].attributes.sheetWidthFeet=.4;
    if(read&&!widthCall){
     if(variant==='preserved_schedule_changed')payload.schedulePreservation.items[0].definition.definition.table=[{text:'UNEXPECTED CHANGE'}];
     if(variant==='preserved_schedule_after_width_scope_mismatch')payload.schedulePreservation.items[0].parameters=[{id:99,value:'UNEXPECTED'}];
     if(variant==='wrong_value'){if(kind==='text')payload.items[0].text+=' EXTRA';else payload.viewportGeometry.length?payload.viewportGeometry[0].center.u++:payload.placedSchedules[0].point.u++;}
     if(variant==='wrong_type')payload.viewportGeometry[0].viewportType.id++;
     if(variant==='missing_type')delete payload.viewportGeometry[0].viewportType;
     if(variant==='wrong_owner'){if(kind==='text')payload.items[0].ownerViewId++;else payload.sheetId++;}
     assert(verificationCapabilityAdmissionV2({apply:{path:f.input.path,capability_id:'revit_call_tool',arguments:f.input},verification:{path:a.path,capability_id:'revit_call_tool',arguments:a}}).admissible);
     if(variant==='exact')assert(operationTargetSelectorV2({operation:{path:a.path,arguments:a},value:payload}).principal_target_tokens.includes('id:'+f.id));
    }
    if(!read&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',
      persistent_effect:read?'none':variant==='unknown'?'unknown':'applied',native_transaction_state:read?'not_applicable':variant==='pending'?'pending':'committed',authority:read&&variant==='foreign_authority'?'model':'native-host',
      affected_target_identities:widthCall?['element_id:901']:!read&&variant.startsWith('preserved_schedule')?f.applied.transaction.affected_element_ids.map((id:number)=>'element_id:'+id):['element_id:'+f.id],result_schema_id:`operator-native/POST:${a.path}/v2`,observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:read&&variant==='stale'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'annotation-create',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   if(variant.startsWith('preserved_schedule_after_width')){
    assert(regularSchedulePresentationReadbackMatchesV2(width.input,width.applied,width.read));
    await handleCodexDynamicToolCall(runtime,{id:'schedule-before-note',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'annotation-turn',tool:'revit_call_tool',arguments:width.input}} as any);
   }
   await handleCodexDynamicToolCall(runtime,{id:'create-annotation',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'annotation-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.input.path===f.input.path&&o.requested_effect==='apply')!;
   if(variant.startsWith('preserved_schedule_after_width')){
    const prior=Object.values(s.operations).find(o=>o.input.path==='/revit/configure-schedule')!;
    assert.equal(calls.filter(a=>a.path==='/revit/configure-schedule').length,1,'never replay the earlier width edit');
    const scopeBad=variant.endsWith('scope_mismatch'),valueBad=variant.endsWith('current_mismatch');
    assert.equal(calls.filter(a=>a.path==='/revit/schedules').length,scopeBad?1:2,'fresh read only after actual preserved annotation, never repeat edit');
    assert.equal(checkedEditIsCurrentV2(s,prior.operation_id),!scopeBad&&!valueBad,'a scheduled read is not a pass; current values must match');
    assert.equal(checkedEditIsCurrentV2(s,apply.operation_id),!scopeBad);
    const feedback=JSON.parse(codexAssignmentEvidenceContextV2(s));
    assert.equal(feedback.verified_postconditions.some((r:any)=>r.operation_id===prior.operation_id),!scopeBad&&!valueBad,
     'model-visible feedback must reflect the fresh comparison, never just the recheck plan');
    if(!scopeBad){
     assert(annotationPreservedScheduleAtCommitV2(s,apply,901));
     assert.equal(annotationPreservedScheduleAtCommitV2(s,apply,902),false,'only actual preserved schedule IDs');
     if(variant==='preserved_schedule_after_width'){
      // Trusted kernel fixture: explicit non-schedule scalar edit has a complete
      // native footprint and an independently passing, current parameter read.
      const n:any=structuredClone(s),w=n.operations[prior.operation_id],baseRead=w.verification_operation_ids.map((id:string)=>n.operations[id]).sort((a:any,b:any)=>Date.parse(a.result.completed_at)-Date.parse(b.result.completed_at))[0];
      w.verification_operation_ids=[baseRead.operation_id];
      const p=structuredClone(w);p.operation_id='parameter-between-width-and-note';p.input={method:'POST',path:'/revit/set-parameter',body:{changes:[{elementId:999,parameterName:'Comments',value:'QA'}],apply:true,dryRun:false}};
      p.request_identity={method:'POST',path:p.input.path,request_signature:'f'.repeat(64)};p.observation_ids=['parameter-commit-observed'];p.verification_operation_ids=['parameter-checked'];p.target.target_id='id:999';
      p.settled_assignment_version=baseRead.settled_assignment_version+1;
      p.result={...p.result,operation_id:p.operation_id,request_identity:structuredClone(p.request_identity),affected_target_identities:['element_id:999','element_id:901'],completed_at:baseRead.result.completed_at};
      const r=structuredClone(baseRead);r.operation_id='parameter-checked';r.verification_of_operation_id=p.operation_id;r.input={method:'POST',path:'/revit/get-parameters',body:{elementIds:[999],names:['Comments']}};
      r.request_identity={method:'POST',path:r.input.path,request_signature:'e'.repeat(64)};r.target.target_id='id:999';r.observation_ids=['parameter-read-observed'];
      r.result={...r.result,operation_id:r.operation_id,request_identity:structuredClone(r.request_identity)};
      n.operations[p.operation_id]=p;n.operations[r.operation_id]=r;
      for(const [o,source]of [[p,w],[r,baseRead]]){const observed=structuredClone(n.observations[source.observation_ids[0]]);observed.operation_id=o.operation_id;observed.observation_id=o.observation_ids[0];n.observations[observed.observation_id]=observed;}
      assert(checkedEditIsCurrentV2(n,p.operation_id),'current exact scalar proof is a prerequisite');
      assert.equal(checkedEditIsCurrentV2(n,w.operation_id),false,'old schedule comparison remains stale');
      assert.equal(regularScheduleCheckNeedsRefreshV2(n,w),true,'verified scalar collateral schedules one new strict read');
      for(const[name,change]of [
       ['missing parameter check',(v:any)=>v.operations[p.operation_id].verification_operation_ids=[]],
       ['incomplete footprint',(v:any)=>v.observations[p.observation_ids[0]].facts=v.observations[p.observation_ids[0]].facts.filter((f:any)=>f.fact_id!=='control.native_change_inventory_complete')],
       ['direct schedule parameter',(v:any)=>v.operations[p.operation_id].input.body.changes[0].elementId=901],
       ['foreign request',(v:any)=>v.operations[p.operation_id].result.request_identity.request_signature='0'.repeat(64)],
      ]as Array<[string,(v:any)=>void]>){const bad=structuredClone(n);change(bad);assert.equal(regularScheduleCheckNeedsRefreshV2(bad,bad.operations[w.operation_id]),false,name);}
     }
     const paired=apply.verification_operation_ids[0]!;
     for(const [name,change] of [
      ['pause',(n:any)=>n.execution_control={state:'paused'}],['unknown',(n:any)=>n.unresolved_unknown_operation_ids=['unknown']],
      ['invalidated note',(n:any)=>n.input_invalidated_operation_ids=[apply.operation_id]],['invalidated check',(n:any)=>n.input_invalidated_operation_ids=[paired]],
      ['foreign note',(n:any)=>n.operations[apply.operation_id].binding.generation++],['foreign check',(n:any)=>n.operations[paired].binding.generation++],
      ['note digest',(n:any)=>n.operations[apply.operation_id].result.raw_payload_hash='0'.repeat(64)],
      ['read digest',(n:any)=>n.operations[paired].result.raw_payload_hash='0'.repeat(64)],
      ['missing read request',(n:any)=>delete n.operations[paired].request_identity],
      ['wrong receipt operation',(n:any)=>n.operations[paired].result.operation_id='foreign'],
      ['missing native correlation',(n:any)=>delete n.operations[paired].result.native_correlation_id],
      ['unavailable source',(n:any)=>n.observations[n.operations[apply.operation_id].observation_ids[0]].raw_payload_ref='evidence:missing'],
      ['unsettled mutation',(n:any)=>n.operations.pending={requested_effect:'apply',dispatch_state:'dispatched',settlement_state:'pending',persistent_effect:'none'}],
      ['no original verification',(n:any)=>n.operations[apply.operation_id].verification_operation_ids=[]],
      ['foreign source',(n:any)=>n.observations[n.operations[apply.operation_id].observation_ids[0]].authority='model'],
     ] as Array<[string,(n:any)=>void]>){const n=structuredClone(s);change(n);assert.equal(annotationPreservedScheduleAtCommitV2(n,n.operations[apply.operation_id],901),false,name);}
    }
    return;
   }
   assert.equal(calls.filter(a=>a.path===f.input.path).length,1,'never replay a mutation for a cleaner proof');
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact'||variant==='preserved_schedule',variant==='preserved_schedule'?JSON.stringify({calls,operations:Object.values(s.operations).map((o:any)=>({purpose:o.purpose,role:o.fulfillment_role,input:o.input,result:o.result,observations:o.observation_ids.map((id:string)=>s.observations[id]?.facts)}))}):undefined);
   if(verified)assert.deepEqual(verifiedNativeWorkTargetIdentitiesV2(s,apply.operation_id),['element_id:'+f.id],'owner does not earn deliverable credit');
   if(['paused','pending','unknown','missing_inventory'].includes(variant))assert.equal(calls.filter(a=>a.path===readPath).length,0);
   if(variant==='exact'||variant==='preserved_schedule'){
    const feedback=JSON.parse(codexAssignmentEvidenceContextV2(s));
    assert.equal(feedback.verified_postconditions.length,1);
    assert.deepEqual(feedback.verified_postconditions[0].checked_preservation_ids,
      variant==='preserved_schedule'?f.applied.schedulePreservation.scheduleIds:[]);
    assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),false);
    const read=s.operations[apply.verification_operation_ids[0]]!;
    assert(nativeAnnotationPostconditionSatisfiedV2(s,apply,read.result!,f.read));
    for(const [name,change] of [
     ['pause',(n:any)=>n.execution_control={state:'paused'}],
     ['unknown',(n:any)=>n.unresolved_unknown_operation_ids=['retained-unknown']],
     ['invalidated edit',(n:any)=>n.input_invalidated_operation_ids=[apply.operation_id]],
     ['invalidated read',(n:any)=>n.input_invalidated_operation_ids=[read.operation_id]],
     ['foreign apply binding',(n:any)=>n.operations[apply.operation_id].binding.generation++],
     ['foreign read binding',(n:any)=>n.operations[read.operation_id].binding.generation++],
     ['altered apply digest',(n:any)=>n.operations[apply.operation_id].result.raw_payload_hash='0'.repeat(64)],
     ['altered read digest',(n:any)=>n.operations[read.operation_id].result.raw_payload_hash='0'.repeat(64)],
     ['intervening settled write',(n:any)=>n.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'applied',result:{completed_at:read.result!.completed_at}}],
     ['unsettled dispatched write',(n:any)=>n.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'pending'}],
     ['read opened before commit',(n:any)=>n.operations[read.operation_id].opened_at='2020-01-01T00:00:00Z'],
    ] as Array<[string,(n:any)=>void]>){const n=structuredClone(s);change(n);assert.equal(nativeAnnotationPostconditionSatisfiedV2(n,n.operations[apply.operation_id],n.operations[read.operation_id].result!,f.read),false,name);}
    const unverified=structuredClone(s);unverified.operations[apply.operation_id].verification_operation_ids=[];
    assert(committedNativeAnnotationReadbackPlanV2(unverified,unverified.operations[apply.operation_id]));
    for(const [name,change] of [
     ['paused',(n:any)=>n.execution_control={state:'paused'}],
     ['unknown',(n:any)=>n.unresolved_unknown_operation_ids=['old-unknown']],
     ['later write',(n:any)=>n.operations.later={operation_id:'later',requested_effect:'apply',persistent_effect:'applied',result:{completed_at:read.result!.completed_at}}],
     ['completed task',(n:any)=>n.terminal={outcome:'completed'}],
     ['completion proposed',(n:any)=>n.completion_proposal={claims:[]}],
     ['foreign native observation',(n:any)=>n.observations[n.operations[apply.operation_id].observation_ids[0]].authority='model'],
    ] as Array<[string,(n:any)=>void]>){const n=structuredClone(unverified);change(n);assert.equal(committedNativeAnnotationReadbackPlanV2(n,n.operations[apply.operation_id]),null,name);}
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
