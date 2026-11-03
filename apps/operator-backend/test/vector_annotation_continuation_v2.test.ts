import fs from'node:fs';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
import test from'node:test';import assert from'node:assert/strict';
import{vectorImportFixture}from'./vector_detail_import.fixtures.js';
import{draftingVectorAnnotations}from'../src/pdf/drafting_vector_annotations.js';
import{createGoal,__testOnlyResetGoalListCache}from'../src/goals/service.js';
import{createAssignmentKernelForGoalV2}from'../src/assignments/assignment_kernel_v2_factory.js';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{beginTeammateLoopOwner,endTeammateLoopOwner}from'../src/teammate_loop_runtime.js';
import{handleCodexDynamicToolCall}from'../src/brains/codex_dynamic_tool_handler.js';
import{runWithRequestContext}from'../src/request_context.js';import{createOperatorBackendAuth}from'../src/operator_backend_auth.js';
import{canonicalJsonV2}from'../src/domain/assignment-kernel/index.js';
import{checkedEditIsCurrentV2}from'../src/verification/current_postcondition_v2.js';
import{committedDraftingIdentityRefreshPlanV2}from'../src/verification/regular_schedule_recheck_v2.js';
import{controlAssignmentExecutionV2}from'../src/assignments/assignment_kernel_v2_controls.js';
import{readRegisteredPdfAttachment}from'../src/attachments/read_attachment.js';
import{compileDraftingStrokeCad}from'../src/pdf/drafting_curve_cad.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

for(const variant of ['complete_chain','wrong_previous_snapshot','foreign_continuation_source','changed_old_text','unobserved_manifest_progress','pause_before_recheck','final_checkpoint','final_changed_cad','final_pause','final_drafting_identity','final_changed_drafting_scale','final_drafting_read_failure','final_drafting_schema_refused','final_drafting_pause']as const)
test(`ordinary annotation continuation ${variant} freshly verifies old content without replay`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-vector-chain-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=await vectorImportFixture(root,'chain-session',0,true),all=draftingVectorAnnotations(f.plan),parts:any[]=[];
  Object.assign(f.nativeRead,{sourceGeometryIndependentlyReparsed:false,scope:'complete_owned_native_snapshot_against_retained_import_not_independent_source_or_visual_verification'});
  for(let index=0;index<3;index++){
   const content=all.slice(index*40,(index+1)*40),ids=content.map((_,i)=>1000+index*40+i);
   const input={method:'POST',path:'/revit/import-vector-annotations',body:{...f.input.body,partIndex:index,
    ...(index?{manifestElementId:30,expectedImportSnapshotSha256:sha('manifest-'+index)}:{})}};
   const applied={...structuredClone(f.applied),partIndex:index,completedParts:index+1,remainingPartIndices:Array.from({length:2-index},(_,i)=>index+1+i),nextPartIndex:index===2?null:index+1,
    createdEntityIds:ids,createdSourceEntityIds:content.map(e=>e.id),createdContentCount:ids.length,partNativeSnapshotSha256:sha('part-'+index),importSnapshotSha256:sha('manifest-'+(index+1)),
    transaction:{status:'committed',committed:true,added_element_ids:index?ids:[30,...ids],modified_element_ids:index?[20,30]:[],deleted_element_ids:[]}};
   parts.push({input,applied});
  }
  if(variant==='wrong_previous_snapshot')parts[1].input.body.expectedImportSnapshotSha256=sha('foreign-history');
  if(variant==='foreign_continuation_source')parts[1].input.body.expectedSourceSha256=parts[1].applied.sourceSha256=sha('another-source');
  const finalCase=variant.startsWith('final_');
  const draftingCase=variant.includes('drafting'),finalPaused=variant==='final_pause'||variant==='final_drafting_pause';
  const draftingInput={method:'POST',path:'/revit/create-drafting-view',body:{name:'Reference vector diagram',scale:100,allowExisting:false}};
  const prepared=finalCase?JSON.parse(((await readRegisteredPdfAttachment('chain-session',{attachment_id:f.attachment.id,mode:'vector',pages:[1],vector_section:'stroke_cad',expected_plan_sha256:f.plan.sourcePlanSha256,
    native_layout:{paperWidthInches:4,viewScale:100,partSize:50}})).content[0]as{text:string}).text):null;
  const sourceCad=finalCase?compileDraftingStrokeCad(f.plan,f.plan.nativePlanSha256):null;
  const cadInput=prepared?{method:'POST',path:'/revit/link-cad',body:{...prepared.cad_import_inputs,viewId:20}}:null;
  const cadApplied=prepared?{success:true,mode:'import',isLinked:false,sourceFormat:'dxf',sourcePath:cadInput!.body.sourcePath,sourceSha256:cadInput!.body.expectedSourceSha256,
    viewId:20,ownerViewId:20,viewType:'DraftingView',viewCreated:false,viewScale:100,elementId:32,elementUniqueId:'import-32',totalTransformScale:1,importUnit:'Foot',colorMode:'Preserved',autoCorrectAlmostVHLines:false,
    transaction:{status:'committed',committed:true,added_element_ids:[32,33],modified_element_ids:[],deleted_element_ids:[]}}:null;
  const output='C:/fixture/result.rvt',doc={session_id:'native-doc',project_fingerprint:'a'.repeat(64),path:output};
  const file={path:output,size_bytes:4096,sha256:'b'.repeat(64),exists:true,readable:true,stable_read:true,fresh_output:true};
  const receipt={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[file],
   save_document:{native_save_returned:true,same_document:true,document_session_changed:false,project_binding_changed:false,document_path_changed:true,before:{...doc,path:'C:/fixture/source.rvt'},after:doc}};
  const goal=createGoal({title:'Draft diagram text',objective:'Add all text from this diagram and verify the completed result.',acceptance_criteria:['All diagram text is present.'],status:'active',related_session_id:'chain-session',created_by:'test-principal',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'chain-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];let completed=0,final=false;
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_tool:string,args:any){if(final&&args.path==='/revit/get-element-summary'&&variant==='final_drafting_schema_refused')throw Error('fresh_drafting_schema_refused');},async callTool(_t:string,args:any,ctx:any){
   calls.push(args);const lease=ctx.assignmentKernelV2;ctx.onMcpAccepted();const annotationRead=args.path==='/revit/inspect-vector-detail',cadRead=args.path==='/revit/view-owned-detailing',fileRead=args.path==='/revit/inspect-exported-files',save=args.path==='/revit/save-as',cadApply=args.path==='/revit/link-cad';
   const draftingApply=args.path==='/revit/create-drafting-view',draftingRead=args.path==='/revit/get-element-summary';
   const read=annotationRead||cadRead||fileRead||draftingRead,i=Number.isInteger(args.body.partIndex)?args.body.partIndex:0;
   if(draftingRead&&final&&variant==='final_drafting_read_failure')throw Error('native_drafting_read_failed');
   if(args.path==='/revit/import-vector-annotations')completed=i+1;
   const part=parts[i].applied,head=parts[Math.max(0,completed-1)].applied;
   let payload:any=annotationRead?{...structuredClone(f.nativeRead),partIndex:i,partNativeSnapshotSha256:part.partNativeSnapshotSha256,observedEntityIds:part.createdEntityIds,
    observedSourceEntityIds:part.createdSourceEntityIds,totalPartContent:part.createdContentCount,completedPartIndices:Array.from({length:completed},(_,j)=>j),
    remainingPartIndices:head.remainingPartIndices,importSnapshotSha256:head.importSnapshotSha256,
    sourceProjection:{...f.nativeRead.sourceProjection,sourceEntityCount:part.createdContentCount,nativeEntitiesInspected:part.createdContentCount}}
    :structuredClone(part);
   if(cadApply)payload=structuredClone(cadApplied);
   if(draftingApply)payload={created:true,success:true,applied:true,ok:true,status:'Success',viewId:20,name:draftingInput.body.name,scale:100,viewType:'DraftingView',
    transaction:{status:'committed',committed:true,added_element_ids:[20],modified_element_ids:[],deleted_element_ids:[],affected_element_ids:[20]},
    changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0}};
   if(draftingRead)payload=[{id:20,found:true,uniqueId:'native-view-20',className:'ViewDrafting',fullClassName:'Autodesk.Revit.DB.ViewDrafting',name:draftingInput.body.name,viewType:'DraftingView',viewScale:final&&variant==='final_changed_drafting_scale'?200:100}];
   if(cadRead){
    const offset=args.body.cadGeometryOffset,selection=sourceCad!.selection.slice(offset,offset+50),next=offset+selection.length===sourceCad!.selection.length?null:offset+selection.length;
    const point=([x,y,z]:number[])=>({x,y,z});
    const items=selection.map(s=>({kind:'Curve',layerName:s.layer,geometry:{kind:'Line',start:point(s.points[0]),end:point(s.points[1])}}));
    if(final&&variant==='final_changed_cad'&&offset===0)items[0]!.geometry.end.x+=0.1;
    payload={schema:'revit-operator.cad-geometry-target/v1',scope:'exact_owner_view_cad_target',read_only:true,wholeViewInventoryRead:false,requestedViewId:20,requestedCadElementId:32,
     view:{id:20,uniqueId:'native-view-20',viewType:'DraftingView',scale:100},targetReadComplete:true,target:{elementId:32,uniqueId:'import-32',ownerViewId:20,className:'ImportInstance',
      cadGeometry:{schema:'revit-operator.cad-geometry/v1',elementId:32,uniqueId:'import-32',ownerViewId:20,isLinked:false,coordinateSpace:'host_model_feet',issues:[],items,returnedCount:items.length,
       complete:offset===0&&next===null,page:{schema:'revit-operator.cad-geometry-page/v1',complete:true,offset,totalPrimitiveCount:sourceCad!.selection.length,nextOffset:next,completeGeometrySnapshotSha256:sha('cad-model')}}}};
   }
   if(save)payload={status:'Success',ok:true,artifact_receipt:receipt};
   if(fileRead)payload={schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,requestedPaths:[output],files:[{...file,fresh_output:false}],saved_document:{...doc,is_modified:false,is_modifiable:false,is_family_document:false}};
   if(read&&final&&variant==='changed_old_text')payload.sourceProjection.sourceNativeProjectionMatches=false;
   if(read&&final&&variant==='unobserved_manifest_progress'){payload.completedPartIndices=[0,1,2,3];payload.remainingPartIndices=[];payload.importSnapshotSha256=sha('unseen-mutation');}
   if(save&&finalPaused)controlAssignmentExecutionV2({binding,command_id:'pause-after-save',expected_command_id:null,action:'pause'});
   return{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
    schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
    affected_target_identities:draftingApply||draftingRead?['element_id:20']:save||fileRead?['artifact_path:'+output]:cadRead?['element_id:32']:cadApply?['element_id:32','element_id:33']:read?['element_id:30']:[...part.transaction.added_element_ids,...part.transaction.modified_element_ids].map((id:number)=>'element_id:'+id).sort(),
    ...(save?{native_artifact_receipt:receipt}:{}),
    result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,raw_payload_hash:sha(canonicalJsonV2(payload)),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString(),...(save?{native_transaction_state:'not_applicable'}:{})},
    observation:{raw_payload:payload,semantic_facts:[{fact_id:"control.domain_succeeded",fact_class:"control",value:true}],verification_relevance:['control']}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'chain-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:true});
  const invoke=(id:string,args:unknown)=>handleCodexDynamicToolCall(runtime,{id,method:'item/tool/call',params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:'chain-turn',arguments:args}}as any);
  try{
   if(draftingCase){await invoke('create-drafting',draftingInput);const initial=getAssignmentKernelSnapshotV2(goal.id)!;const created=Object.values(initial.operations).find(o=>o.requested_effect==='apply'&&o.input.path==='/revit/create-drafting-view')!;assert.equal(checkedEditIsCurrentV2(initial,created.operation_id),true,'Initial identity comes from an automatic separate native read');}
   if(finalCase)await invoke('cad-first',cadInput);
   for(let i=0;i<3;i++){
    const response:any=await invoke('annotation-'+i,parts[i].input);
    if(variant==='complete_chain'&&i===0){
     const item=response.contentItems.find((c:any)=>c.type==='inputText'&&c.text.startsWith('{"backend_vector_verification":'));
     assert(item,'Ordinary tool handoff must distinguish backend source proof from native-only scope');
     const summary=JSON.parse((item as any).text).backend_vector_verification;
     assert.equal(summary.original_pdf_reparse,'matched');assert.equal(summary.native_part_or_cohort_current,true);
     assert.equal(summary.part_index,0);assert.equal(summary.part_entity_count,40);assert.equal(summary.source_entity_count,81);
     assert.equal(summary.parts_total,3);assert.equal(summary.whole_drawing_verified,false);
     assert.match(summary.explanation,/native host/i);assert.match(summary.explanation,/remaining/i);
    }
   }
   const before=getAssignmentKernelSnapshotV2(goal.id)!,first=Object.values(before.operations).find(o=>o.requested_effect==='apply'&&(o.input.body as any).partIndex===0)!;
   assert.equal(checkedEditIsCurrentV2(before,first.operation_id),false,'Later manifest writes stale the first check');
   if(variant==='final_drafting_identity'){
    const draft=Object.values(before.operations).find(o=>o.input.path==='/revit/create-drafting-view')!,history=canonicalJsonV2(before);
    assert.deepEqual(committedDraftingIdentityRefreshPlanV2(before,draft),{method:'POST',path:'/revit/get-element-summary',body:{elementIds:[20]}});
    const faults:Record<string,(s:any,o:any)=>void>={
     paused:s=>s.execution_control={state:'paused'},terminal:s=>s.terminal=true,proposed:s=>s.completion_proposal={},
     unknown:s=>s.unresolved_unknown_operation_ids=['unknown'],inflight:s=>s.in_flight_operation_ids=['inflight'],
     invalidated:(s,o)=>s.input_invalidated_operation_ids=[o.operation_id],foreign:(s,o)=>o.binding={...o.binding,generation:2},
     nonnative:(_s,o)=>o.result.authority='model',uncommitted:(_s,o)=>o.result.native_transaction_state='pending',
     badDigest:(_s,o)=>o.result.raw_payload_hash='0'.repeat(64),missingEvidence:(_s,o)=>o.observation_ids=[],
     allowExisting:(_s,o)=>o.input.body.allowExisting=true,wrongRoute:(_s,o)=>o.input.path='/revit/create-sheet',
     noPriorCheck:(_s,o)=>o.verification_operation_ids=[],
     foreignRead:(s,o)=>s.operations[o.verification_operation_ids[0]].result.authority='model',
     invalidatedRead:(s,o)=>s.input_invalidated_operation_ids=[o.verification_operation_ids[0]],
     wrongReadTarget:(s,o)=>s.operations[o.verification_operation_ids[0]].input.body.elementIds=[99],
     changedReadHash:(s,o)=>s.operations[o.verification_operation_ids[0]].result.raw_payload_hash='0'.repeat(64),
     failedLatestRead:(s,o)=>s.operations[o.verification_operation_ids[0]].result.status='failed'
    };
    for(const[name,fault]of Object.entries(faults)){const altered=structuredClone(before),o=altered.operations[draft.operation_id]!;fault(altered,o);assert.equal(committedDraftingIdentityRefreshPlanV2(altered,o),null,name);}
    assert.equal(canonicalJsonV2(before),history,'Read scheduling cannot rewrite historical evidence or claim currentness');
   }
   final=true;
   if(variant==='pause_before_recheck')controlAssignmentExecutionV2({binding,command_id:'pause-final',expected_command_id:null,action:'pause'});
   if(finalCase)await invoke('save-final',{method:'POST',path:'/revit/save-as',body:{filePath:output,overwrite:false,dryRun:false}});
   else await invoke('fresh-old-part',{method:'POST',path:'/revit/inspect-vector-detail',body:{manifestElementId:30,partIndex:0}});
   const after=getAssignmentKernelSnapshotV2(goal.id)!;
   assert.equal(checkedEditIsCurrentV2(after,first.operation_id),variant==='complete_chain'||finalCase&&!finalPaused,'Only a proven same-import continuation can refresh the old part');
   assert.equal(calls.filter(c=>c.path==='/revit/import-vector-annotations').length,3,'No mutation replay');
   if(variant==='complete_chain'){
    const fresh=Object.values(after.operations).filter(o=>o.input.path==='/revit/inspect-vector-detail'&&(o.input.body as any).partIndex===0).sort((a,b)=>b.admitted_assignment_version!-a.admitted_assignment_version!)[0]!;
    assert.equal(fresh.verification_of_operation_id,first.operation_id,'Old part must not verify the newest part merely because they share a manifest');
   }
   if(finalCase){
    const cad=Object.values(after.operations).find(o=>o.input.path==='/revit/link-cad')!;
    if(!finalPaused)assert.equal(checkedEditIsCurrentV2(after,cad.operation_id),variant!=='final_changed_cad','A newer authoritative mismatch cannot hide behind an old passing check');
    assert.equal(calls.filter(c=>c.path==='/revit/link-cad').length,1);assert.equal(calls.filter(c=>c.path==='/revit/save-as').length,1);
    assert.equal(calls.filter(c=>c.path==='/revit/view-owned-detailing').length,finalPaused?3:6,'No old-page reuse, cross-epoch stitching or repeated import');
    const save=Object.values(after.operations).find(o=>o.input.path==='/revit/save-as')!;
    const finalReads=cad.verification_operation_ids.map(id=>after.operations[id]!).filter(o=>o.admitted_assignment_version!>save.settled_assignment_version!);
    assert.equal(finalReads.length,finalPaused?0:3,'Pause retains earlier proof without claiming a completed final cohort');
    if(draftingCase){const draft=Object.values(after.operations).find(o=>o.input.path==='/revit/create-drafting-view')!;
     assert.equal(calls.filter(c=>c.path==='/revit/create-drafting-view').length,1);
     assert.equal(calls.filter(c=>c.path==='/revit/get-element-summary').length,finalPaused||variant==='final_drafting_schema_refused'?1:2,'A final identity read is separate from its historical initial check; schema refusal stays before dispatch');
     assert.equal(checkedEditIsCurrentV2(after,draft.operation_id),variant==='final_drafting_identity','Wrong scale, failed reads and Pause never become final identity proof');
    }
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
});
