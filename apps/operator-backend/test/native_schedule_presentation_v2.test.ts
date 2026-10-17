import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import {createHash} from 'node:crypto';
import {nativeSchedulePresentationRequestV2,nativeSchedulePresentationMatchesV2,nativeSchedulePresentationReadbacksMatchV2,committedNativeSchedulePresentationReadbackPlanV2,nativeSchedulePresentationPostconditionSatisfiedV2} from '../src/verification/native_schedule_presentation_v2.js';
import {verificationCapabilityAdmissionV2,operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
import {createGoal,getGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2,AssignmentJournalV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)',TABLE_GET='method:Autodesk.Revit.DB.Electrical.PanelScheduleView.GetTableData()',SECTION='method:Autodesk.Revit.DB.TableData.GetSectionData(Autodesk.Revit.DB.SectionType)';
const SET_TEXT='method:Autodesk.Revit.DB.TableSectionData.SetCellText(System.Int32,System.Int32,System.String)',SET_HEIGHT='method:Autodesk.Revit.DB.TableSectionData.SetRowHeight(System.Int32,System.Double)';
const TEXT='method:Autodesk.Revit.DB.TableView.GetCellText(Autodesk.Revit.DB.SectionType,System.Int32,System.Int32)',HEIGHT='method:Autodesk.Revit.DB.TableSectionData.GetRowHeight(System.Int32)';
const PANEL_SECTION='method:Autodesk.Revit.DB.Electrical.PanelScheduleView.GetSectionData(Autodesk.Revit.DB.SectionType)';
const SECTION_INDEX='method:Autodesk.Revit.DB.TableData.GetSectionData(System.Int32)';
const SET_WIDTH='method:Autodesk.Revit.DB.TableSectionData.SetColumnWidth(System.Int32,System.Double)',WIDTH='method:Autodesk.Revit.DB.TableSectionData.GetColumnWidth(System.Int32)';
const call=(id:string,target:string,memberId:string,args:any[])=>({id,op:'call',target,memberId,args});
const digest=(v:any)=>createHash('sha256').update(canonicalJsonV2(v)).digest('hex');
function native(operations:any[],editing:boolean){const handles=new Map<string,string>([['doc','Autodesk.Revit.DB.Document'],['view','Autodesk.Revit.DB.Electrical.PanelScheduleView']]);
 const receipts=operations.map(s=>{const target_type=handles.get(s.target);let result_preview:any=null;
  assert.notEqual(s.memberId,'method:Autodesk.Revit.DB.TableView.GetTableData()','The native SDK has no GetTableData member on TableView');
  if(s.memberId===GET){handles.set('$'+s.id,'Autodesk.Revit.DB.Electrical.PanelScheduleView');result_preview={id:s.args[0],unique_id:'native-schedule-fixture-'+s.args[0],name:'Sample'};}
  else if(s.memberId.endsWith('.GetTableData()')){handles.set('$'+s.id,'Autodesk.Revit.DB.Electrical.PanelScheduleData');result_preview={type:'Autodesk.Revit.DB.Electrical.PanelScheduleData'};}
  else if(s.memberId===SECTION||s.memberId===SECTION_INDEX||s.memberId===PANEL_SECTION){handles.set('$'+s.id,'Autodesk.Revit.DB.TableSectionData');result_preview={type:'Autodesk.Revit.DB.TableSectionData'};}
  else if(s.memberId===TEXT)result_preview='CU; 3/4"C W/2#12+1#12GRD';
  else if(s.memberId===HEIGHT)result_preview=.033;
  else if(s.memberId===WIDTH)result_preview=.6;
  return {id:s.id,op:s.op,member_id:s.memberId,target_type,result_preview,
   ...(s.target==='view'?{target_identity:{schema:'operator.native_element_receiver.v1',element_id:41,unique_id:'native-schedule-fixture-41',type_name:target_type,active_document:true}}:{})};});
 return {version:editing?'operator.native_api_mutation_ops.v1':'operator.native_api_ops.v2',ok:true,read_only:!editing,operation_count:operations.length,
  geometry_cleanup_errors:[] as any[],operations:receipts,results:Object.fromEntries(receipts.filter(s=>[TEXT,HEIGHT,WIDTH].includes(s.member_id)).map(s=>[s.id,s.result_preview]))};
}
function fixture(){const ops=[call('panel','doc',GET,[41]),call('table','$panel',TABLE_GET,[]),call('footer','$table',SECTION,['Footer']),
 call('legend','$footer',SET_TEXT,[2,1,'CU; 3/4"C W/2#12+1#12GRD']),call('body','$table',SECTION,['Body']),call('height','$body',SET_HEIGHT,[2,.033])];
 const input={method:'POST',path:'/revit/native-api-mutation-ops',body:{operations:ops,transaction:{mode:'commit',maxAffectedElements:4,allowCreate:false,allowedExistingElementIds:[41,42]}}};
 const applied={...native(ops,true),mutation_operation_count:2,transaction:{mode:'commit',status:'committed',committed:true,dry_run:false,existing_scope_matched:true,scope_discovery_only:false,
  scope_baseline:'complete_native_document_ids_before_transaction',scope_baseline_element_count:100,scope_observer_executions:1,allow_create:false,
  allowed_existing_element_ids:[41,42],commit_allowed_existing_element_ids:[41,42],unexpected_existing_element_ids:[] as number[],added_element_ids:[] as number[],deleted_element_ids:[] as number[],modified_element_ids:[41,42]}};
 const readOps=[call('schedule','doc',GET,[41]),call('read0','$schedule',TEXT,['Footer',2,1]),call('table','$schedule',TABLE_GET,[]),call('section0','$table',SECTION,['Body']),call('read1','$section0',HEIGHT,[2])];
 const readInput={method:'POST',path:'/revit/native-api-ops',body:{operations:readOps,returns:['$read0','$read1']}};
 return {input,applied,readInput,read:native(readOps,false)};
}
function contextFixture(){const f=fixture();f.input.body.operations.shift();f.input.body.operations[0]!.target='view';
 const actual=native(f.input.body.operations,true);Object.assign(f.applied,actual);return f;}
function nativeOverloadFixture(){const f=contextFixture();delete (f.input.body.operations[0] as any).args;
 for(const s of f.input.body.operations)if(s.memberId===SECTION){s.memberId=SECTION_INDEX;s.args=[['Header','Body','Summary','Footer'].indexOf(s.args[0])];}
 Object.assign(f.applied,native(f.input.body.operations,true));return f;
}
function regularFixture(){const f=fixture(),getter='method:Autodesk.Revit.DB.ViewSchedule.GetTableData()';
 f.input.body.operations[1]!.memberId=getter;f.applied.operations[1]!.member_id=getter;
 f.readInput.body.operations[2]!.memberId=getter;f.read.operations[2]!.member_id=getter;
 for(const payload of [f.applied,f.read])for(const op of payload.operations){
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleView')op.target_type='Autodesk.Revit.DB.ViewSchedule';
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleData')op.target_type='Autodesk.Revit.DB.TableData';
 }
 return f;
}
function defaultCreationFixture(variant:'omitted'|'null'){
 const f=contextFixture();delete (f.input.body.operations[0] as any).args;
 if(variant==='omitted')delete (f.input.body.transaction as any).allowCreate;
 else (f.input.body.transaction as any).allowCreate=null;
 return f;
}

function batchFixture(){const f=fixture();
 const ops=[call('p1','doc',GET,[41]),call('t1','$p1',TABLE_GET,[]),call('b1','$t1',SECTION,['Body']),call('h1','$b1',SET_HEIGHT,[2,.033]),
  call('p2','doc',GET,[42]),call('t2','$p2',TABLE_GET,[]),call('b2','$t2',SECTION,['Body']),call('h2','$b2',SET_HEIGHT,[2,.04])];
 f.input.body.operations=ops;f.input.body.transaction={mode:'commit',maxAffectedElements:4,allowCreate:false,allowedExistingElementIds:[41,42,43,44]};
 Object.assign(f.applied,native(ops,true));Object.assign(f.applied.transaction,{allowed_existing_element_ids:[41,42,43,44],commit_allowed_existing_element_ids:[41,42,43,44],modified_element_ids:[41,42,43,44]});
 const reads=[call('schedule0','doc',GET,[41]),call('table0','$schedule0',TABLE_GET,[]),call('section0','$table0',SECTION,['Body']),call('read0','$section0',HEIGHT,[2]),
  call('schedule1','doc',GET,[42]),call('table1','$schedule1',TABLE_GET,[]),call('section1','$table1',SECTION,['Body']),call('read1','$section1',HEIGHT,[2])];
 f.readInput.body={operations:reads,returns:['$read0','$read1']};f.read=native(reads,false);f.read.results.read1=.04;f.read.operations.at(-1)!.result_preview=.04;
 return f;
}

function widthFixture(){const f=fixture();
 const ops=[call('p1','doc',GET,[41]),call('t1','$p1',TABLE_GET,[]),call('b1','$t1',SECTION,['Body']),call('w1','$b1',SET_WIDTH,[2,.6]),call('w2','$b1',SET_WIDTH,[13,.61]),call('h1','$t1',SECTION,['Header']),call('w3','$h1',SET_WIDTH,[6,.9]),
  call('p2','doc',GET,[42]),call('t2','$p2',TABLE_GET,[]),call('s2','$t2',SECTION,['Summary']),call('w4','$s2',SET_WIDTH,[6,.8833333333333333]),call('f2','$t2',SECTION,['Footer']),call('w5','$f2',SET_WIDTH,[1,1.675])];
 f.input.body.operations=ops;f.input.body.transaction={mode:'commit',maxAffectedElements:4,allowCreate:false,allowedExistingElementIds:[41,42,43,44]};
 Object.assign(f.applied,native(ops,true));Object.assign(f.applied,{mutation_operation_count:5});Object.assign(f.applied.transaction,{allowed_existing_element_ids:[41,42,43,44],commit_allowed_existing_element_ids:[41,42,43,44],modified_element_ids:[41,42,43,44]});
 const reads=[call('schedule0','doc',GET,[41]),call('table0','$schedule0',TABLE_GET,[]),call('section0','$table0',SECTION,['Body']),call('read0','$section0',WIDTH,[2]),call('read1','$section0',WIDTH,[13]),call('section1','$table0',SECTION,['Header']),call('read2','$section1',WIDTH,[6]),
  call('schedule1','doc',GET,[42]),call('table1','$schedule1',TABLE_GET,[]),call('section2','$table1',SECTION,['Summary']),call('read3','$section2',WIDTH,[6]),call('section3','$table1',SECTION,['Footer']),call('read4','$section3',WIDTH,[1])];
 f.readInput.body={operations:reads,returns:Array.from({length:5},(_,i)=>'$read'+i)};f.read=native(reads,false);
 for(const [i,value]of [.6,.61,.9,.8833333333333333,1.675].entries()){f.read.results['read'+i]=value;f.read.operations.find(r=>r.id==='read'+i)!.result_preview=value;}
 return f;
}
function scopeOrderFixture(){const f=widthFixture();
 // Native transaction inventories are sets and may use their own stable order.
 f.input.body.transaction.allowedExistingElementIds=[43,41,44,42];
 f.applied.transaction.commit_allowed_existing_element_ids=[44,43,42,41];
 return f;
}

// Both are legal sixteen-operation edits. Resolving an explicit native view
// and its table makes the separate fresh read larger than the edit itself.
function wideFixture(context=false){const f=fixture(),count=context?15:14;
 const ops=[...(context?[]:[call('panel','doc',GET,[41])]),call('body',context?'view':'$panel',PANEL_SECTION,['Body']),
  ...Array.from({length:count},(_,i)=>call('width'+i,'$body',SET_WIDTH,[i,.6]))];
 f.input.body.operations=ops;Object.assign(f.applied,native(ops,true));f.applied.mutation_operation_count=count;
 const make=(offset:number,count:number)=>{const operations=[call('schedule','doc',GET,[41]),call('table','$schedule',TABLE_GET,[]),call('section0','$table',SECTION,['Body']),
  ...Array.from({length:count},(_,i)=>call('read'+i,'$section0',WIDTH,[offset+i]))];return {method:'POST',path:'/revit/native-api-ops',body:{operations,returns:Array.from({length:count},(_,i)=>'$read'+i)}};};
 return {...f,plans:[make(0,13),make(13,count-13)]};
}
function mixedWideFixture(){const f=fixture();
 const ops=[call('p1','doc',GET,[41]),call('b1','$p1',PANEL_SECTION,['Body']),...Array.from({length:6},(_,i)=>call('w'+i,'$b1',SET_WIDTH,[i,.6])),
  call('p2','doc',GET,[42]),call('h2','$p2',PANEL_SECTION,['Header']),...Array.from({length:6},(_,i)=>call('v'+i,'$h2',SET_WIDTH,[i,.6]))];
 f.input.body.operations=ops;Object.assign(f.applied,native(ops,true));f.applied.mutation_operation_count=12;
 const first=[call('schedule0','doc',GET,[41]),call('table0','$schedule0',TABLE_GET,[]),call('section0','$table0',SECTION,['Body']),...Array.from({length:6},(_,i)=>call('read'+i,'$section0',WIDTH,[i])),
  call('schedule1','doc',GET,[42]),call('table1','$schedule1',TABLE_GET,[]),call('section1','$table1',SECTION,['Header']),...Array.from({length:4},(_,i)=>call('read'+(i+6),'$section1',WIDTH,[i]))];
 const last=[call('schedule','doc',GET,[42]),call('table','$schedule',TABLE_GET,[]),call('section0','$table',SECTION,['Header']),call('read0','$section0',WIDTH,[4]),call('read1','$section0',WIDTH,[5])];
 return {...f,plans:[first,last].map(operations=>({method:'POST',path:'/revit/native-api-ops',body:{operations,returns:operations.filter(s=>s.memberId===WIDTH).map(s=>'$'+s.id)}}))};
}

test('a complete pair of bounded reads proves all fourteen or fifteen requested widths, never one partial slice',()=>{
 for(const f of [wideFixture(false),wideFixture(true),mixedWideFixture()]){const reads=f.plans.map(input=>({input,payload:native(input.body.operations,false)}));
  assert(nativeSchedulePresentationReadbacksMatchV2(f.input,f.applied,reads));
  assert.equal(nativeSchedulePresentationReadbacksMatchV2(f.input,f.applied,reads.slice(0,1)),false);
  assert.equal(nativeSchedulePresentationReadbacksMatchV2(f.input,f.applied,[reads[0]!,reads[0]!]),false);
  assert(nativeSchedulePresentationReadbacksMatchV2(f.input,f.applied,[...reads].reverse()),'Exact slices may arrive in either order');
  for(const mutate of [
   (r:any)=>r[1].input.body.operations.at(-1).args=[99],
   (r:any)=>{r[1].payload.results.read0=.7;r[1].payload.operations.find((o:any)=>o.id==='read0').result_preview=.7;},
   (r:any)=>r[1].payload.operations[0].result_preview.unique_id='foreign',
   (r:any)=>r[1].payload.operation_count++,
   (r:any)=>r[0].payload.geometry_cleanup_errors=['failed'],
  ]){const altered=structuredClone(reads);mutate(altered);assert.equal(nativeSchedulePresentationReadbacksMatchV2(f.input,f.applied,altered),false);}
 }
});

test('native scope ordering is independent while exact unique positive membership remains mandatory',()=>{
 for(const make of [fixture,batchFixture,widthFixture,contextFixture]){
  const f=make();f.input.body.transaction.allowedExistingElementIds.reverse();
  f.applied.transaction.commit_allowed_existing_element_ids.reverse();
  assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
  for(const field of ['allowed_existing_element_ids','commit_allowed_existing_element_ids'])for(const invalid of [
   [],[...f.input.body.transaction.allowedExistingElementIds,999],f.input.body.transaction.allowedExistingElementIds.slice(1),
   [...f.input.body.transaction.allowedExistingElementIds.slice(1),999],
   [...f.input.body.transaction.allowedExistingElementIds,f.input.body.transaction.allowedExistingElementIds[0]],
   [0,...f.input.body.transaction.allowedExistingElementIds.slice(1)],
   ['41',...f.input.body.transaction.allowedExistingElementIds.slice(1)],null,{},
  ]){const n=structuredClone(f);(n.applied.transaction as any)[field]=invalid;assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false,field+':'+JSON.stringify(invalid));}
  for(const invalid of [[41,41],[0,41],[-1,41],['41',42],Array.from({length:65},(_,i)=>i+1)]){
   const n=structuredClone(f);(n.input.body.transaction as any).allowedExistingElementIds=invalid;
   assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false,'Invalid declared scope remains rejected');
  }
 }
});

test('column widths require every column, section, schedule and identity in one complete fresh read',()=>{
 const f=widthFixture();assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 assert.deepEqual(nativeSchedulePresentationRequestV2(f.input)!.targets.map(t=>t.kind),Array(5).fill('width'));
 assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.input.path,arguments:f.input},value:f.applied}).principal_target_tokens,['id:41','id:42']);
 for(const mutate of [
  (n:any)=>{n.read.results.read4=1.6;n.read.operations.find((r:any)=>r.id==='read4').result_preview=1.6;},
  (n:any)=>n.read.operations.find((r:any)=>r.member_id===GET&&r.result_preview.id===42).result_preview.unique_id='foreign',
  (n:any)=>n.readInput.body.operations.find((r:any)=>r.id==='section3').args=['Header'],
  (n:any)=>n.readInput.body.operations.find((r:any)=>r.id==='read4').args=[2],
  (n:any)=>n.applied.transaction.modified_element_ids=[41,43,44],
  (n:any)=>n.input.body.operations.push(call('duplicate','$b1',SET_WIDTH,[2,.6])),
  (n:any)=>n.input.body.operations[3].args=[-1,.6],
  (n:any)=>n.input.body.operations[3].args=[2,0],
  (n:any)=>n.input.body.operations[3].args=[2,Infinity],
  (n:any)=>n.input.body.operations[3].args=[2,2.01],
  (n:any)=>n.input.body.operations.push(call('unrecognized','$b1','method:Unrelated.SetSize()',[])),
 ]){const n=structuredClone(f);mutate(n);assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false);}
});
test('width and height at the same numeric index are distinct checked coordinates',()=>{
 const f=fixture();f.input.body.operations.push(call('width','$body',SET_WIDTH,[2,.6]));Object.assign(f.applied,native(f.input.body.operations,true));f.applied.mutation_operation_count=3;
 f.readInput.body.operations.push(call('read2','$section0',WIDTH,[2]));f.readInput.body.returns.push('$read2');f.read=native(f.readInput.body.operations,false);
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
});
test('column-width readback supports regular schedules and native active-view receivers',()=>{
 const f=widthFixture(),getter='method:Autodesk.Revit.DB.ViewSchedule.GetTableData()';
 for(const request of [f.input,f.readInput])for(const op of request.body.operations)if(op.memberId===TABLE_GET)op.memberId=getter;
 for(const payload of [f.applied,f.read])for(const op of payload.operations){
  if(op.member_id===TABLE_GET)op.member_id=getter;
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleView')op.target_type='Autodesk.Revit.DB.ViewSchedule';
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleData')op.target_type='Autodesk.Revit.DB.TableData';
 }
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 const c=contextFixture();c.input.body.operations.push(call('width','$body',SET_WIDTH,[2,.6]));Object.assign(c.applied,native(c.input.body.operations,true));c.applied.mutation_operation_count=3;
 c.readInput.body.operations.push(call('read2','$section0',WIDTH,[2]));c.readInput.body.returns.push('$read2');c.read=native(c.readInput.body.operations,false);
 assert(nativeSchedulePresentationMatchesV2(c.input,c.applied,c.readInput,c.read));
 const foreign=structuredClone(c);foreign.applied.operations[0]!.target_identity!.active_document=false;assert.equal(nativeSchedulePresentationMatchesV2(foreign.input,foreign.applied,foreign.readInput,foreign.read),false);
});

test('batch schedule proof requires every requested schedule, UID, value and complete native transaction',()=>{
 const f=batchFixture();assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 assert.deepEqual(nativeSchedulePresentationRequestV2(f.input)!.scheduleIds,[41,42]);
 assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.input.path,arguments:f.input},value:f.applied}).principal_target_tokens,['id:41','id:42']);
 for(const mutate of [
  (n:any)=>n.read.results.read1=.033,
  (n:any)=>n.read.operations[4].result_preview.unique_id='wrong-second-schedule',
  (n:any)=>n.readInput.body.operations.splice(4),
  (n:any)=>n.applied.transaction.modified_element_ids=[41,43,44],
  (n:any)=>n.input.body.transaction.allowedExistingElementIds=[41,43,44],
  (n:any)=>n.applied.operations[5].target_identity={schema:'operator.native_element_receiver.v1',element_id:41,unique_id:'native-schedule-fixture-41',type_name:'Autodesk.Revit.DB.Electrical.PanelScheduleView',active_document:true},
  (n:any)=>n.input.body.operations.push(call('unused','doc',GET,[99])),
  (n:any)=>n.input.body.operations.push(call('duplicate','$b2',SET_HEIGHT,[2,.05])),
  (n:any)=>n.input.body.operations.push(call('foreign','view',PANEL_SECTION,['Body'])),
 ]){const n=structuredClone(f);mutate(n);assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false);}
});
test('native no-create default accepts optional omission/null only with authoritative false receipt',()=>{
 for(const variant of ['omitted','null'] as const){const f=defaultCreationFixture(variant);
  assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read),variant);
  for(const mutate of [
   (n:any)=>n.input.body.transaction.allowCreate=true,
   (n:any)=>n.input.body.transaction.allowCreate='false',
   (n:any)=>n.input.body.transaction.allowCreate=0,
   (n:any)=>n.applied.transaction.allow_create=true,
   (n:any)=>delete n.applied.transaction.allow_create,
   (n:any)=>n.applied.transaction.added_element_ids=[80],
   (n:any)=>n.applied.transaction.deleted_element_ids=[80],
  ]){const n=structuredClone(f);mutate(n);assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false);}
 }
});
test('active-view schedule identity comes only from the captured native receiver, never the allowed-ID list',()=>{
 const f=contextFixture();
 assert.equal(nativeSchedulePresentationRequestV2(f.input)?.scheduleId,0,'Unbound shape does not assert an element');
 assert.equal(nativeSchedulePresentationRequestV2(f.input,f.applied)?.scheduleId,41);
 assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read),true);
 const operation={capability_id:'revit_call_tool',path:f.input.path,arguments:f.input};
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.input}).principal_target_tokens,[]);
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.applied}).principal_target_tokens,['id:41']);
 for(const change of [
  (n:any)=>delete n.applied.operations[0].target_identity,
  (n:any)=>n.applied.operations[0].target_identity.element_id=42,
  (n:any)=>n.applied.operations[0].target_identity.unique_id='other-view',
  (n:any)=>n.applied.operations[0].target_identity.active_document=false,
  (n:any)=>n.applied.operations[0].target_identity.type_name='Autodesk.Revit.DB.Wall',
  (n:any)=>n.applied.operations[0].target_identity.schema='model-claim',
  (n:any)=>n.applied.operations[0].id='other-step',
  (n:any)=>n.input.body.transaction.allowedExistingElementIds=[42],
  (n:any)=>n.input.body.operations.unshift(call('guessed','doc',GET,[41]))
 ]){const n=structuredClone(f);change(n);assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false);}
});
test('native optional zero arguments and integral section-index overload retain exact identity and values',()=>{
 const f=nativeOverloadFixture();assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 for(const mutate of [
  (n:any)=>n.input.body.operations[0].args=null,
  (n:any)=>n.input.body.operations[0].args=[1],
  (n:any)=>n.input.body.operations[1].args=[-1],
  (n:any)=>n.input.body.operations[1].args=[4],
  (n:any)=>n.input.body.operations[1].args=[1.5],
  (n:any)=>n.input.body.operations[1].args=['Footer'],
  (n:any)=>delete n.input.body.operations[1].args,
 ]){const n=structuredClone(f);mutate(n);assert.equal(nativeSchedulePresentationMatchesV2(n.input,n.applied,n.readInput,n.read),false);}
});
test('retained91 direct active panel-section four-row graph binds exact native identity and separate getters',()=>{
 const f=fixture(),rows=[2,3,4,8];
 f.input.body.operations=[call('b','view',PANEL_SECTION,['Body']),...rows.map((row,i)=>call('r'+i,'$b',SET_HEIGHT,[row,.04]))];
 Object.assign(f.applied,native(f.input.body.operations,true));f.applied.mutation_operation_count=4;
 f.readInput.body.operations=[call('schedule','doc',GET,[41]),call('table','$schedule',TABLE_GET,[]),call('section0','$table',SECTION,['Body']),...rows.map((row,i)=>call('read'+i,'$section0',HEIGHT,[row]))];
 f.readInput.body.returns=rows.map((_,i)=>'$read'+i);f.read=native(f.readInput.body.operations,false);
 for(let i=0;i<4;i++){f.read.results['read'+i]=.04;f.read.operations[3+i]!.result_preview=.04;}
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 const historical=structuredClone(f.applied);delete (historical.operations[0] as any).target_identity;
 assert.equal(nativeSchedulePresentationMatchesV2(f.input,historical,f.readInput,f.read),false,'Historical missing identity is not retroactive proof');
 const moved=structuredClone(f);moved.read.operations[0]!.result_preview={id:41,unique_id:'replaced-view'};
 assert.equal(nativeSchedulePresentationMatchesV2(moved.input,moved.applied,moved.readInput,moved.read),false);
});
test('complete text and row-height graph matches exact native getter results, not commit label',()=>{
 const f=fixture();assert(nativeSchedulePresentationRequestV2(f.input));assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.applied),false);
});
test('active panel table-first four-row graph rejects the retained unsupported base-class read',()=>{
 const f=contextFixture(),rows=[2,3,4,8];
 f.input.body.operations=[call('table','view',TABLE_GET,[]),call('body','$table',SECTION,['Body']),...rows.map((row,i)=>call('row'+i,'$body',SET_HEIGHT,[row,.05]))];
 Object.assign(f.applied,native(f.input.body.operations,true));f.applied.mutation_operation_count=4;
 f.readInput.body.operations=[call('schedule','doc',GET,[41]),call('table','$schedule',TABLE_GET,[]),call('section0','$table',SECTION,['Body']),...rows.map((row,i)=>call('read'+i,'$section0',HEIGHT,[row]))];
 f.readInput.body.returns=rows.map((_,i)=>'$read'+i);f.read=native(f.readInput.body.operations,false);
 for(let i=0;i<4;i++){f.read.results['read'+i]=.05;f.read.operations[3+i]!.result_preview=.05;}
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 const unsupported=structuredClone(f.readInput);unsupported.body.operations[1]!.memberId='method:Autodesk.Revit.DB.TableView.GetTableData()';
 assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,unsupported,f.read),false,'A failed old getter is never retroactive proof');
 const ambiguous=structuredClone(f);ambiguous.applied.operations[0]!.target_type='Autodesk.Revit.DB.ViewSchedule';
 assert.equal(nativeSchedulePresentationMatchesV2(ambiguous.input,ambiguous.applied,ambiguous.readInput,ambiguous.read),false);
});
test('regular schedules use the same native text/height proof; mixed graphs never fall through token matching',()=>{
 const f=regularFixture();
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 f.input.body.operations.push(call('other','$footer','method:Autodesk.Revit.DB.Parameter.Set(System.String)',['approved']));
 assert.equal(nativeSchedulePresentationRequestV2(f.input),null);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,{id:41,value:'approved'},{path:f.input.path}),false);
});
test('exact scope, complete graph, native identities and all values are mandatory',()=>{
 const failures:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['wrong text',f=>f.read.results.read0='wrong'],['wrong height',f=>f.read.results.read1=.02],
  ['echo only',f=>{(f as any).read=f.readInput.body;}],['different UID',f=>f.read.operations[0]!.result_preview.unique_id='foreign'],
  ['missing native result',f=>{delete f.read.results.read1;}],['preview disagrees',f=>f.read.operations.at(-1)!.result_preview=.02],
  ['partial read',f=>f.read.operations.pop()],['wrong receiver',f=>f.read.operations[1]!.target_type='Autodesk.Revit.DB.Element'],
  ['different row',f=>f.readInput.body.operations[1]!.args[1]=3],['extra getter',f=>f.readInput.body.operations.push(call('extra','$schedule',TEXT,['Footer',3,1]))],
  ['rolled back',f=>f.applied.transaction.committed=false],['unknown spill',f=>f.applied.transaction.modified_element_ids.push(99)],
  ['duplicate inventory',f=>f.applied.transaction.modified_element_ids.push(41)],['created',f=>f.applied.transaction.added_element_ids.push(80)],
  ['deleted',f=>f.applied.transaction.deleted_element_ids.push(80)],['missing scope census',f=>f.applied.transaction.scope_baseline='unknown'],
  ['unobserved scope',f=>f.applied.transaction.scope_observer_executions=0],['wrong mutation count',f=>f.applied.mutation_operation_count=1],
  ['unsupported mutation',f=>f.input.body.operations.push(call('other','$panel','method:Autodesk.Revit.DB.Element.LookupParameter(System.String)',['Name']))],
  ['duplicate setter',f=>f.input.body.operations.push(call('again','$footer',SET_TEXT,[2,1,'another']))],
  ['forward handle',f=>f.input.body.operations[2]!.target='$missing'],['nonliteral size',f=>f.input.body.operations.at(-1)!.args[1]='$arg'],
 ];for(const[name,mutate]of failures){const f=fixture();mutate(f);assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read),false,name);}
});
test('capability and target selectors require schedule getters, not lists, placements or generic echoes',()=>{
 const f=fixture(),apply={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input},verification={capability_id:'revit_call_tool',...f.readInput,arguments:f.readInput};
 assert.equal(verificationCapabilityAdmissionV2({apply,verification}).admissible,true);
 assert.deepEqual(verificationCapabilityAdmissionV2({apply,verification}).admissible_readback_paths,['/revit/native-api-ops']);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{capability_id:'revit_call_tool',path:'/revit/schedules',arguments:{body:{action:'list'}}}}).admissible,false);
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:f.input}).principal_target_tokens,['id:41']);
 assert.deepEqual(operationTargetSelectorV2({operation:verification,value:f.read}).principal_target_tokens,['id:41']);
 const unrelated=structuredClone(f.read);unrelated.operations[0]!.result_preview.id=42;
 assert.deepEqual(operationTargetSelectorV2({operation:verification,value:unrelated}).principal_target_tokens,['id:42']);
});
for(const variant of ['wide','wide_context','wide_mixed','wide_wrong_last','wide_foreign_uid','wide_read_failure','wide_pause_between','exact','active_view','native_overloads','default_create_omitted','default_create_null','regular','batch','batch_wrong_second','batch_foreign_second','batch_read_failure','batch_paused','width_batch','width_wrong_last','width_foreign_second','width_paused','width_read_failure','scope_set_order','scope_wrong_member','scope_duplicate','scope_foreign_uid','scope_pending','wrong_text','wrong_height','foreign_uid','read_failure','wrong_digest','unretained_apply','paused_after_commit','admission_retry','admission_twice','admission_paused'] as const)
test(`ordinary SDK presentation ${variant} uses bounded separate reads, never a repeated write`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-schedule-presentation-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=variant==='wide_mixed'?mixedWideFixture():variant.startsWith('wide')?wideFixture(variant==='wide_context'):variant.startsWith('scope_')?scopeOrderFixture():variant.startsWith('width')?widthFixture():variant.startsWith('batch')?batchFixture():variant==='active_view'?contextFixture():variant==='native_overloads'?nativeOverloadFixture():variant==='default_create_omitted'?defaultCreationFixture('omitted'):variant==='default_create_null'?defaultCreationFixture('null'):variant==='regular'?regularFixture():fixture(),goal=createGoal({title:'Compact schedule notes',objective:'Use compact wiring notation.',acceptance_criteria:['The requested schedule changes are established.'],status:'active',related_session_id:'presentation-session',created_by:'presentation-principal',work_budget:{requested_effect:'apply',document_fingerprint:'presentation-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'presentation-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  let readIndex=0,admissionFailures=0;const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_tool:string,args:any){if(args.path==='/revit/native-api-ops'){assert(args.body.operations.length<=16,'Native/MCP operation cap stays sixteen');assert(('plans' in f?(f.plans as any[]):[f.readInput]).some(plan=>canonicalJsonV2(plan)===canonicalJsonV2(args)),'Only an exact recognized read plan passes schema validation');}},
   async callTool(_tool:string,args:any,context:any){calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.path==='/revit/native-api-ops';
    if(reading&&variant.startsWith('admission_')&&(admissionFailures++===0||variant==='admission_twice')){
     if(variant==='admission_paused')controlAssignmentExecutionV2({binding,command_id:'pause-after-read-admission-failure',expected_command_id:null,action:'pause'});
     const correlation='native:'+lease.operation_id,failure={schema:'revit-operator.revit-bridge-failure.v1',ok:false,code:'revit_bridge_http_error',bridge_code:'CERTIFICATION_DIRECT_AUTHORIZATION_UNAVAILABLE',phase:'certification_native_direct_admission',retryable:true,request_dispatched:false,outcome_unknown:false,method:'POST',path:args.path,status:503,correlation_id:correlation,error:'Native Revit authorization backend is unavailable.'};
     return {isError:true,content:[{type:'text',text:JSON.stringify(failure)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'failed_before_dispatch',dispatch_state:'not_dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',authority:'native-host',affected_target_identities:[],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:false,native_correlation_id:correlation,request_identity:lease.request_identity,completed_at:new Date().toISOString(),error_code:'native_operation_failed'}}};
    }
    if(reading&&['read_failure','batch_read_failure','width_read_failure'].includes(variant))throw Error('native_read_failed');
    const index=reading?readIndex++:-1;if(reading&&variant==='wide_read_failure'&&index===1)throw Error('second_native_read_failed');
    const payload:any=structuredClone(reading?('plans' in f?native((f.plans as any[])[index].body.operations,false):f.read):f.applied);
    if(reading&&index===1&&variant==='wide_wrong_last'){payload.results.read0=.7;payload.operations.find((n:any)=>n.id==='read0').result_preview=.7;}
    if(reading&&index===1&&variant==='wide_foreign_uid')payload.operations[0].result_preview.unique_id='foreign';
    if(reading&&index===0&&variant==='wide_pause_between')controlAssignmentExecutionV2({binding,command_id:'pause-between-native-reads',expected_command_id:null,action:'pause'});
    if(reading){if(variant==='wrong_text')payload.results.read0='wrong';if(variant==='wrong_height')payload.results.read1=.02;if(variant==='foreign_uid')payload.operations[0].result_preview.unique_id='foreign';}
    if(reading&&variant==='batch_wrong_second')payload.results.read1=.033;
    if(reading&&variant==='batch_foreign_second')payload.operations[4].result_preview.unique_id='foreign';
    if(reading&&variant==='width_wrong_last'){payload.results.read4=1.6;payload.operations.find((r:any)=>r.id==='read4').result_preview=1.6;}
    if(reading&&variant==='width_foreign_second')payload.operations.find((r:any)=>r.member_id===GET&&r.result_preview.id===42).result_preview.unique_id='foreign';
    if(reading&&variant==='scope_foreign_uid')payload.operations.find((r:any)=>r.member_id===GET&&r.result_preview.id===42).result_preview.unique_id='foreign';
    if(!reading&&variant==='scope_wrong_member')payload.transaction.commit_allowed_existing_element_ids=[41,42,43,999];
    if(!reading&&variant==='scope_duplicate')payload.transaction.allowed_existing_element_ids=[41,42,43,44,44];
    if(!reading&&variant==='scope_pending')payload.transaction.pending=true;
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!reading&&['paused_after_commit','batch_paused','width_paused'].includes(variant))controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:'native-host',affected_target_identities:reading?[]:f.applied.transaction.modified_element_ids.map(id=>'element_id:'+id),result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
      raw_payload_hash:reading&&variant==='wrong_digest'?'e'.repeat(64):digest(payload),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:!reading&&variant==='unretained_apply'?{ok:true}:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'presentation-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{const response:any=await handleCodexDynamicToolCall(runtime,{id:'sdk-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'presentation-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(calls.filter(c=>c.path===f.input.path).length,1);assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['unretained_apply','paused_after_commit','batch_paused','width_paused'].includes(variant)?0:['admission_retry','admission_twice'].includes(variant)?2:variant.startsWith('wide')&&variant!=='wide_pause_between'?2:1,JSON.stringify(response.contentItems.filter((i:any)=>i.type==='inputText').map((i:any)=>i.text.slice(0,1800))));
   const checked=apply.verification_operation_ids.some(id=>snapshot.operations[id]!.observation_ids.some(oid=>snapshot.observations[oid]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
   assert.equal(checked,['wide','wide_context','wide_mixed','exact','active_view','native_overloads','default_create_omitted','default_create_null','regular','batch','width_batch','scope_set_order','admission_retry'].includes(variant));assert.equal(Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply').length,1);
   if(variant.startsWith('admission_')){const reads=Object.values(snapshot.operations).filter(o=>o.requested_effect==='read');assert.equal(reads[0]!.result?.status,'failed_before_dispatch');assert.equal(reads[0]!.result?.persistent_effect,'none');assert.equal(reads[0]!.observation_ids.length,0);assert(!apply.verification_operation_ids.includes(reads[0]!.operation_id));assert.deepEqual(snapshot.unresolved_unknown_operation_ids,[]);if(variant==='admission_retry'){assert.notEqual(reads[0]!.operation_id,reads[1]!.operation_id);assert.equal(reads[1]!.result?.status,'succeeded');}}
   if(variant==='admission_retry'){
    const events=getGoal(goal.id)!.assignment_kernel_v2!.events;
    assert.deepEqual(new AssignmentJournalV2(events).snapshot(),snapshot,'Cold replay retains failed attempt and separately checked new read');
    const retry=Object.values(snapshot.operations).find(o=>o.retry_basis==='native_pre_dispatch_read')!;assert(retry);
    const index=events.findIndex(e=>e.event_type==='operation_admitted'&&e.operation.operation_id===retry.operation_id);
    const event=structuredClone(events[index]!) as any;event.operation.input.body.returns=['$wrong'];
    assert.throws(()=>new AssignmentJournalV2(events.slice(0,index)).append(event),{code:'operation_pre_dispatch_read_retry_invalid'},'The reducer rejects a claimed retry of different input');
   }
   if(variant.startsWith('wide')){const reads=apply.verification_operation_ids.map(id=>snapshot.operations[id]!).sort((a,b)=>(a.input.body as any).operations.length>(b.input.body as any).operations.length?-1:1);assert(reads.length>=1);assert(reads[0]!.observation_ids.every(id=>!snapshot.observations[id]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)),'First partial slice never certifies the complete edit');
    if(['wide','wide_context','wide_mixed'].includes(variant)){
     assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),false);
     const payload=native((f as ReturnType<typeof wideFixture>).plans[1]!.body.operations,false);
     for(const mutate of [
      (s:any,a:any,first:any,last:any)=>a.verification_operation_ids=[last.operation_id],
      (s:any,a:any,first:any,last:any)=>first.result.raw_payload_hash='e'.repeat(64),
      (s:any,a:any,first:any,last:any)=>first.result.binding.run_id='foreign',
      (s:any,a:any,first:any,last:any)=>first.opened_at='2020-01-01T00:00:00Z',
      (s:any,a:any,first:any,last:any)=>first.result.request_identity.request_signature='foreign',
      (s:any,a:any,first:any,last:any)=>first.result.status='failed',
      (s:any,a:any,first:any,last:any)=>first.observation_ids=[],
      (s:any,a:any,first:any,last:any)=>s.input_invalidated_operation_ids=[first.operation_id],
      (s:any,a:any,first:any,last:any)=>s.unresolved_unknown_operation_ids=['old-unknown'],
      (s:any,a:any,first:any,last:any)=>s.operations.later={...a,operation_id:'later'},
     ]){const s=structuredClone(snapshot),a=s.operations[apply.operation_id]!,first=s.operations[reads[0]!.operation_id]!,last=s.operations[reads[1]!.operation_id]!;mutate(s,a,first,last);assert.equal(nativeSchedulePresentationPostconditionSatisfiedV2(s,a,last.result!,payload),false);}
    }
   }
   if(['exact','active_view','native_overloads','default_create_omitted','default_create_null','regular','batch','width_batch','scope_set_order'].includes(variant)){
    assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),false);
    const read=Object.values(snapshot.operations).find(o=>o.requested_effect==='read')!;
    assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,apply),null,'One internal read only');
    for(const mutate of [(s:any,a:any,r:any)=>s.unresolved_unknown_operation_ids=['older-unknown'],
      (s:any,a:any,r:any)=>s.input_invalidated_operation_ids=[a.operation_id],
      (s:any,a:any,r:any)=>a.binding={...a.binding,generation:2},
      (s:any,a:any,r:any)=>a.result.native_transaction_state='pending',
      (s:any,a:any,r:any)=>a.result.receipt_id='',
      (s:any,a:any,r:any)=>r.result.binding={...r.result.binding,run_id:'foreign'},
      (s:any,a:any,r:any)=>r.opened_at='2020-01-01T00:00:00Z',
      (s:any,a:any,r:any)=>r.admission_state='not_admitted',
      (s:any,a:any,r:any)=>r.result.request_identity.request_signature='foreign',
      (s:any,a:any,r:any)=>s.operations.later={...a,operation_id:'later'}]){
      const s=structuredClone(snapshot),a=s.operations[apply.operation_id]!,r=s.operations[read.operation_id]!;mutate(s,a,r);
      assert.equal(nativeSchedulePresentationPostconditionSatisfiedV2(s,a,r.result!,f.read),false);
    }
   }
   else if(!['unretained_apply','wide','wide_context','wide_mixed','admission_retry'].includes(variant))assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),true);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('read planning does not authorize unknown or unretained commits',()=>{
 const f=fixture(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'op',binding,input:f.input,requested_effect:'apply',persistent_effect:'applied',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',request_identity:{path:f.input.path,request_signature:'sig'},observation_ids:[],verification_operation_ids:[],
 result:{operation_id:'op',binding,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',completed_at:'2026-10-14T23:30:00Z',request_identity:{request_signature:'sig'},receipt_id:'receipt',native_correlation_id:'native',affected_target_identities:['element_id:41','element_id:42']}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{op},observations:{}};
 assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,op),null);
 snapshot.unresolved_unknown_operation_ids=['older'];assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,op),null);
});
