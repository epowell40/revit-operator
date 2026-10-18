import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {excelTableImportReadbackMatchesV2,excelTableImportPostconditionSatisfiedV2} from '../src/verification/excel_table_import_v2.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../src/domain/assignment-kernel/verified_work_targets.js';

const retainedParts=JSON.parse(fs.readFileSync('test/fixtures/excel-import196-native-parts.json','utf8')).parts;

function fixture(){
 const input={method:'POST',path:'/revit/import-excel-output',body:{sourcePath:'uploads/table.xlsx',sheetName:'Output',viewName:'Output Table',expectedSourceSha256:'a'.repeat(64)}};
 const applied={status:'Success',applied:true,sourceSha256:'a'.repeat(64),worksheet:'Output',manifestElementId:30,partManifestElementId:31,viewId:20,partIndex:0,
  partsTotal:4,partsImported:1,remainingPartIndices:[1,2,3],nextPartIndex:1,planSha256:'b'.repeat(64),partNativeSnapshotSha256:'c'.repeat(64),importSnapshotSha256:'d'.repeat(64),
  createdTextNoteIds:[1000,1001],createdBorderIds:[2000],sourceCellCount:9535,sourceCachedErrorCount:7990,calculationPerformed:false,
  changeTracking:{exhaustiveChangeInventory:true},transaction:{status:'committed',committed:true,added_element_ids:[20,30,31,1000,1001,2000],modified_element_ids:[],deleted_element_ids:[]}};
 const readInput={method:'POST',path:'/revit/inspect-excel-import',body:{sourcePath:input.body.sourcePath,manifestElementId:30,partIndex:0,pageSize:1}};
 const read={schema:'operator.xlsx_import_inspection.v1',status:'Ok',read_only:true,completeNativePartRead:true,sourcePath:input.body.sourcePath,sourceSha256:applied.sourceSha256,
  retainedSourceSha256:applied.sourceSha256,sourceFileMatchesImport:true,sourceProjection:{Matches:true,IssueCount:0,SourceCellCount:9535},planSha256:applied.planSha256,
  manifestElementId:30,manifestUniqueId:'manifest-30',partManifestElementId:31,partIndex:0,viewId:20,partNativeSnapshotSha256:applied.partNativeSnapshotSha256,
  retainedPartNativeSnapshotSha256:applied.partNativeSnapshotSha256,nativeSnapshotMatchesImport:true,snapshotError:null,importSnapshotSha256:'d'.repeat(64),inspectionSnapshotSha256:'e'.repeat(64),
  observedNoteIds:[1000,1001],observedBorderIds:[2000],sourceCachedErrorCount:7990,calculationPerformed:false,
  checks:{IssueCount:0,InsideCellBounds:true,CellReadingOrderMatches:true,NativeBordersMatch:true,Text:{IssueCount:0,NativeNotes:2,SourceCoverageMatches:true,NativeTextMatches:true,NativeIdentityAndOwnershipMatches:true,SourceFormattingMatches:true}}};
 return {input,applied,readInput,read,affected:applied.transaction.added_element_ids.map(n=>'element_id:'+n).sort()};
}
test('Excel part verification binds source, part, complete native inventory, borders and typography without engineering or whole-package credit',()=>{
 const f=fixture();assert.equal(excelTableImportReadbackMatchesV2(f.input,f.applied,f.readInput,f.read,f.affected),true);
 for(const edit of [
  (v:any)=>v.readInput.body.partIndex=1,(v:any)=>delete v.readInput.body.partIndex,(v:any)=>v.readInput.body.action='list',
  (v:any)=>v.input.body.expectedSourceSha256='f'.repeat(64),(v:any)=>v.read.sourceSha256='f'.repeat(64),
  (v:any)=>v.read.sourceProjection.Matches=false,(v:any)=>v.read.sourceProjection.SourceCellCount=200,
  (v:any)=>v.read.completeNativePartRead=false,(v:any)=>v.read.checks.Text.SourceFormattingMatches=false,
  (v:any)=>v.read.checks.NativeBordersMatch=false,(v:any)=>v.read.checks.InsideCellBounds=false,(v:any)=>v.read.checks.CellReadingOrderMatches=false,
  (v:any)=>v.read.observedBorderIds=[],(v:any)=>v.read.observedNoteIds=[1000],(v:any)=>v.read.partManifestElementId=32,
  (v:any)=>v.read.nativeSnapshotMatchesImport=false,(v:any)=>v.read.snapshotError='missing-note',(v:any)=>v.read.sourceCachedErrorCount=0,
  (v:any)=>v.applied.transaction.deleted_element_ids=[99],(v:any)=>v.applied.transaction.modified_element_ids=[99],
  (v:any)=>v.applied.remainingPartIndices=[],(v:any)=>v.applied.nextPartIndex=null,(v:any)=>v.applied.changeTracking.exhaustiveChangeInventory=false,
  (v:any)=>v.applied.transaction.added_element_ids.pop(),(v:any)=>v.affected.pop(),(v:any)=>v.input.body.dryRun=true,
 ]){const v=fixture();edit(v);assert.equal(excelTableImportReadbackMatchesV2(v.input,v.applied,v.readInput,v.read,v.affected),false);}
});
test('retained native first and continuation parts prove content without claiming preservation of incidental owners',()=>{
 for(const f of retainedParts){
  assert.equal(excelTableImportReadbackMatchesV2(f.input,f.applied,f.readInput,f.read,f.affected),true);
  for(const change of [
   (v:any)=>v.affected.pop(),(v:any)=>v.applied.transaction.modified_element_ids.push(12345),
   (v:any)=>v.applied.transaction.deleted_element_ids.push(12345),
   (v:any)=>v.read.checks.Text.NativeTextMatches=false,(v:any)=>v.read.checks.NativeBordersMatch=false,
   (v:any)=>v.read.observedNoteIds.pop(),(v:any)=>v.read.partNativeSnapshotSha256='f'.repeat(64),
   (v:any)=>v.applied.transaction.modified_element_ids=v.applied.transaction.modified_element_ids.filter((n:number)=>n!==v.applied.manifestElementId),
  ]){const v=structuredClone(f);change(v);if(JSON.stringify(v)===JSON.stringify(f))continue;assert.equal(excelTableImportReadbackMatchesV2(v.input,v.applied,v.readInput,v.read,v.affected),false);}
 }
});
for(const variant of ['exact','retained_first_part','retained_continuation','wrong_source','wrong_part','bad_native_format','unretained_apply','paused_after_commit','read_failure'] as const)
test(`ordinary Excel part ${variant} schedules one separate authoritative check without replay`,async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'operator-excel-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=folder;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=variant==='retained_first_part'?structuredClone(retainedParts[0]):variant==='retained_continuation'?structuredClone(retainedParts[1]):fixture(),positive=['exact','retained_first_part','retained_continuation'].includes(variant),goal=createGoal({title:'Add the ventilation table',objective:'Add the attached ventilation table.',acceptance_criteria:['The table is present.'],
   status:'active',related_session_id:'excel-session',created_by:'excel-principal',work_budget:{requested_effect:'apply',document_fingerprint:'excel-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'excel-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){if(args.path===f.readInput.path)assert.deepEqual(args,f.readInput);},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const isRead=args.path===f.readInput.path;
    if(isRead&&variant==='read_failure')throw Error('native-part-read-failed');
    const payload:any=structuredClone(isRead?f.read:f.applied);
    if(isRead&&variant==='wrong_source')payload.sourceSha256='f'.repeat(64);if(isRead&&variant==='wrong_part')payload.partIndex=1;
    if(isRead&&variant==='bad_native_format')payload.checks.Text.SourceFormattingMatches=false;
    if(!isRead&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',
      persistent_effect:isRead?'none':'applied',native_transaction_state:isRead?'not_applicable':'committed',authority:'native-host',affected_target_identities:isRead?['element_id:30']:f.affected,
      result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
      receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:!isRead&&variant==='unretained_apply'?{status:'Success'}:payload,
      semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'excel-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response=await handleCodexDynamicToolCall(runtime,{id:'excel-import',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'excel-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path===f.input.path).length,1);
   assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['unretained_apply','paused_after_commit'].includes(variant)?0:1,JSON.stringify({response,operations:s.operations}));
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,positive);
   if(positive){
    assert.deepEqual(verifiedNativeWorkTargetIdentitiesV2(s,apply.operation_id),[`element_id:${f.applied.viewId}`]);
    const read=s.operations[apply.verification_operation_ids[0]!]!,result=read.result!;
    assert.equal(excelTableImportPostconditionSatisfiedV2(s,apply,result,f.read),true);
    for(const edit of [(v:any)=>v.unresolved_unknown_operation_ids.push('prior-unknown'),(v:any)=>(v.input_invalidated_operation_ids??=[]).push(apply.operation_id),
     (v:any)=>v.operations[read.operation_id].input.body.partIndex+=1]){
     const v=structuredClone(s);edit(v);assert.equal(excelTableImportPostconditionSatisfiedV2(v,v.operations[apply.operation_id]!,result,f.read),false);
    }
    assert.equal(excelTableImportPostconditionSatisfiedV2(s,apply,{...result,completed_at:new Date(Date.parse(apply.result!.completed_at)-1).toISOString()},f.read),false);
   }
   if(variant!=='unretained_apply')assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!positive);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(folder,{recursive:true,force:true});}
});
