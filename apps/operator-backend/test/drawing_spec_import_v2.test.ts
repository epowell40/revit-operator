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
import {drawingSpecImportReadbackMatchesV2,drawingSpecImportPostconditionSatisfiedV2} from '../src/verification/drawing_spec_import_v2.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';

function fixture(count=2){
 const noteIds=Array.from({length:count},(_,i)=>1000+i),added=[20,30,...noteIds];
 const input={method:'POST',path:'/revit/import-drawing-spec',body:{sourcePath:'artifacts/specs/Notes.docx',columns:4}};
 const applied={status:'Success',applied:true,sourceSha256:'a'.repeat(64),nativeSnapshotSha256:'b'.repeat(64),paragraphCount:452,remainingParagraphCount:0,
  manifestElementId:30,createdTextNoteIds:noteIds,viewIds:[20],changeTracking:{exhaustiveChangeInventory:true},
  transaction:{status:'committed',committed:true,added_element_ids:added,modified_element_ids:[1],deleted_element_ids:[]}};
 const read={schema:'operator.drawing_spec_inspection.v1',status:'Ok',read_only:true,completeNativeRead:true,sourcePath:input.body.sourcePath,
  sourceSha256:applied.sourceSha256,retainedSourceSha256:applied.sourceSha256,sourceFileMatchesImport:true,sourceProjectionMatchesImport:true,sourceBodyComplete:true,
  manifestElementId:30,manifestUniqueId:'manifest-30',inspectionSnapshotSha256:'c'.repeat(64),currentNativeSnapshotSha256:'b'.repeat(64),snapshotError:null,
  nativeSnapshotMatchesImport:true,viewIds:[20],observedNoteIds:noteIds,totalNotes:count,
  checks:{SourceParagraphs:452,SourceCharacters:50000,NativeNotes:count,NativeRanges:count,IssueCount:0,SourceCoverageMatches:true,NativeTextMatches:true,
   NativeIdentityAndOwnershipMatches:true,SourceFormattingMatches:true,InsideColumnBounds:true,ReadingOrderMatches:true,
   VisualFidelityVerified:false,SheetPlacementVerified:false,WholeTaskVerified:false}};
 return {input,applied,read,readInput:{method:'POST',path:'/revit/inspect-drawing-spec',body:{sourcePath:input.body.sourcePath,manifestElementId:30,pageSize:1}},
  affected:[...added,1].map(n=>'element_id:'+n).sort()};
}
test('current source predicates need full note coverage and do not claim visual or sheet completion',()=>{
 const f=fixture();assert.equal(drawingSpecImportReadbackMatchesV2(f.input,f.applied,f.readInput,f.read,f.affected),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false,'Generic expected-token matching cannot certify imports.');
 for(const edit of [
  (v:any)=>v.read.sourceFileMatchesImport=false,(v:any)=>v.read.sourceSha256='d'.repeat(64),
  (v:any)=>v.read.checks.SourceFormattingMatches=false,(v:any)=>v.read.checks.InsideColumnBounds=null,
  (v:any)=>v.read.observedNoteIds.pop(),(v:any)=>v.read.manifestElementId++,
  (v:any)=>v.read.completeNativeRead=false,(v:any)=>v.applied.transaction.committed=false,
  (v:any)=>v.readInput.body.pageOffset=1,(v:any)=>v.readInput.body.apply=true,
  (v:any)=>v.read.currentNativeSnapshotSha256=null,(v:any)=>v.read.status='StaleInspection'
 ]){const v=fixture();edit(v);assert.equal(drawingSpecImportReadbackMatchesV2(v.input,v.applied,v.readInput,v.read,v.affected),false);}
});
test('a fresh source-matching corrective result need not echo an earlier producer snapshot',()=>{
 const f=fixture();f.read.nativeSnapshotMatchesImport=false;f.read.currentNativeSnapshotSha256='d'.repeat(64);
 assert.equal(drawingSpecImportReadbackMatchesV2(f.input,f.applied,f.readInput,f.read,f.affected),true);
});

function updatedFixture(){
 const f:any=fixture();
 Object.assign(f.input.body,{action:'update',manifestElementId:30,expectedSourceSha256:'d'.repeat(64),expectedNativeSnapshotSha256:'e'.repeat(64)});
 const revision={revision:1,previousSourceSha256:'d'.repeat(64),previousNativeStateSha256:'e'.repeat(64),
  replacedTextNoteIds:[40,41],retainedViewIds:[20],allReplacedNotesAbsent:true,retainedViewIdentitiesMatch:true};
 Object.assign(f.applied,{updated:true,managedUpdate:revision});
 f.applied.transaction.added_element_ids=f.applied.createdTextNoteIds;
 f.applied.transaction.modified_element_ids=[1,30];f.applied.transaction.deleted_element_ids=[40,41];
 f.read.managedUpdate=structuredClone(revision);
 f.affected=[1,30,...f.applied.createdTextNoteIds,40,41].map(n=>'element_id:'+n).sort();return f;
}
test('managed Word reflow checks fresh replacement revision, old-note absence and retained view identities',()=>{
 const f=updatedFixture();assert.equal(drawingSpecImportReadbackMatchesV2(f.input,f.applied,f.readInput,f.read,f.affected),true);
 for(const edit of [
  (v:any)=>delete v.input.body.expectedNativeSnapshotSha256,(v:any)=>v.input.body.viewId=20,
  (v:any)=>v.input.body.action='overwrite',(v:any)=>v.input.body.expectedSourceSha256='f'.repeat(64),
  (v:any)=>v.applied.managedUpdate.replacedTextNoteIds=[40],(v:any)=>v.applied.transaction.deleted_element_ids.push(99),
  (v:any)=>v.applied.transaction.modified_element_ids=[1],(v:any)=>v.applied.managedUpdate.retainedViewIds=[99],
  (v:any)=>v.read.managedUpdate.allReplacedNotesAbsent=false,(v:any)=>v.read.managedUpdate.retainedViewIdentitiesMatch=false,
  (v:any)=>v.read.managedUpdate.previousNativeStateSha256='f'.repeat(64),(v:any)=>v.read.checks.SourceFormattingMatches=false,
  (v:any)=>v.readInput.body.action='list'
 ]){const v=updatedFixture();edit(v);assert.equal(drawingSpecImportReadbackMatchesV2(v.input,v.applied,v.readInput,v.read,v.affected),false);}
});

for(const variant of ['exact','large_package','wrong_source','format_mismatch','legacy_bounds','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit','corrected_snapshot','managed_update','update_old_notes_remain','update_collateral_deletion'] as const)
test(`ordinary Word import ${variant} gets separate source/native verification without replaying the import`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-word-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=variant==='managed_update'||variant.startsWith('update_')?updatedFixture():fixture(variant==='large_package'?1400:2),goal=createGoal({title:'Add drawing specifications',objective:'Add the supplied drawing specifications.',
   acceptance_criteria:['Imported source text is present.'],status:'active',related_session_id:'word-session',created_by:'word-principal',
   work_budget:{requested_effect:'apply',document_fingerprint:'word-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'word-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){if(args.path==='/revit/inspect-drawing-spec'){
    assert.deepEqual(args,f.readInput);if(variant==='read_schema_rejected')throw Error('inspection_schema_rejected');
   }},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=args.path==='/revit/inspect-drawing-spec';
    if(read&&variant==='read_failure')throw Error('native_inspection_failed');
    const payload:any=structuredClone(read?f.read:f.applied);
    if(read){if(variant==='wrong_source')payload.sourceSha256='e'.repeat(64);if(variant==='format_mismatch')payload.checks.SourceFormattingMatches=false;
     if(variant==='legacy_bounds')payload.checks.InsideColumnBounds=null;if(variant==='wrong_target')payload.manifestElementId++;
     if(variant==='corrected_snapshot'){payload.nativeSnapshotMatchesImport=false;payload.currentNativeSnapshotSha256='d'.repeat(64);}
     if(variant==='update_old_notes_remain')payload.managedUpdate.allReplacedNotesAbsent=false;}
    if(!read&&variant==='update_collateral_deletion')payload.transaction.deleted_element_ids.push(99);
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:read?['element_id:30']:f.affected,result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,
      raw_payload_hash:read&&variant==='wrong_digest'?'e'.repeat(64):createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
      receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:!read&&variant==='unretained_apply'?{status:'Success'}:payload,
      semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',
       fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'word-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response=await handleCodexDynamicToolCall(runtime,{id:'word-import',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'word-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied',JSON.stringify(apply.result));assert.equal(calls.filter(c=>c.path===f.input.path).length,1);
   assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['unretained_apply','read_schema_rejected','paused_after_commit','update_collateral_deletion'].includes(variant)?0:1,JSON.stringify({response,operations:s.operations}));
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   const matched=['exact','large_package','corrected_snapshot','managed_update'].includes(variant);assert.equal(verified,matched);
   if(variant==='exact'){
    const read=s.operations[apply.verification_operation_ids[0]!]!,result=read.result!;
    assert.equal(drawingSpecImportPostconditionSatisfiedV2(s,apply,result,f.read),true);
    for(const change of [(v:any)=>v.unresolved_unknown_operation_ids.push('prior-unknown'),
     (v:any)=>(v.input_invalidated_operation_ids??=[]).push(apply.operation_id),
     (v:any)=>v.operations[read.operation_id].input.body.manifestElementId++]){
     const changed=structuredClone(s);change(changed);assert.equal(drawingSpecImportPostconditionSatisfiedV2(changed,changed.operations[apply.operation_id]!,result,f.read),false);}
    assert.equal(drawingSpecImportPostconditionSatisfiedV2(s,apply,{...result,binding:{...result.binding,generation:result.binding.generation+1}},f.read),false);
    assert.equal(drawingSpecImportPostconditionSatisfiedV2(s,apply,{...result,completed_at:new Date(Date.parse(apply.result!.completed_at)-1).toISOString()},f.read),false);
   }
   if(variant!=='unretained_apply')assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!matched);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});
