import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';import test from 'node:test';
import {storeAttachmentUpload} from '../src/attachments/upload_store.js';
import {readRegisteredPdfAttachment} from '../src/attachments/read_attachment.js';
import {compileDraftingStrokeCad} from '../src/pdf/drafting_curve_cad.js';
import {vectorPdfFixture} from './vector_detail_import.fixtures.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner,__testOnlyResetTeammateLoopState} from '../src/teammate_loop_runtime.js';
import {isReservedVectorPageContinuationV2} from '../src/brains/committed_readback_reservations_v2.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,appliedOperationHasVerifiedPostconditionV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {prepareVectorSourceProofV2,vectorSourceProofRecordV2} from '../src/verification/vector_detail_source_proof_v2.js';
import {readEvidenceRef,readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';
import {operationTargetSelectorV2,verificationCapabilityAdmissionForPathsV2} from '../src/verification/verification_capability_admission_v2.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../src/domain/assignment-kernel/verified_work_targets.js';

test('source CAD selection is exact and leaves ordinary CAD target policy unchanged',()=>{
 const operation={capability_id:'revit_call_tool',method:'POST',path:'/revit/link-cad'};
 const legacy=operationTargetSelectorV2({operation,value:{sourcePath:'examples/other.dwg',viewId:20},fallback_target_tokens:['id:20']});
 assert.equal(legacy.source,'legacy_generic_fallback');assert.deepEqual(legacy.principal_target_tokens,['id:20']);
 const sourcePath='artifacts/drafting-vector/strokes-'+'a'.repeat(64)+'.dxf';
 const source=operationTargetSelectorV2({operation,value:{sourcePath,elementId:32,viewId:20},fallback_target_tokens:['id:20']});
 assert(source.principal_target_tokens.includes('id:32'));assert(!source.principal_target_tokens.includes('id:20'));
 assert(source.contextual_scope_tokens.includes('id:20'));
 const read={viewId:20,cadElementId:32,cadGeometryOffset:0,cadGeometryLimit:1000,includeCadGeometry:true,cadTargetOnly:true};
 assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/link-cad','/revit/view-owned-detailing',{sourcePath},read).admissible,true);
 for(const wrong of [{viewId:20},{...read,cadTargetOnly:false},{...read,cadGeometryLimit:0},{...read,cadGeometryOffset:-1}])
  assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/link-cad','/revit/view-owned-detailing',{sourcePath},wrong).admissible,false);
});

async function fixture(root:string,session:string){
 const upload=storeAttachmentUpload({session_id:session,filename:'diagram.pdf',data_base64:vectorPdfFixture().toString('base64')});
 const read=async(args:unknown)=>JSON.parse(((await readRegisteredPdfAttachment(session,args)).content[0] as {text:string}).text);
 const base={attachment_id:upload.id,mode:'vector',pages:[1]},summary=await read(base);
 const p=await read({...base,vector_section:'stroke_cad',expected_plan_sha256:summary.plan_sha256,native_layout:{paperWidthInches:4,viewScale:100,partSize:50}});
 const plan=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,p.native_plan_artifact.relative_path))).toString()),cad=compileDraftingStrokeCad(plan,plan.nativePlanSha256);
 const point=([x,y,z]:number[])=>({x,y,z});
 const all=cad.selection.map(s=>({kind:'Curve',layerName:s.layer,geometry:s.kind==='line'?{kind:'Line',start:point(s.points[0]),end:point(s.points[1])}
  :{kind:'NurbSpline',degree:3,cyclic:false,rational:false,controlPoints:s.points.map(point),start:point(s.points[0]),end:point(s.points[3]),knots:[0,0,0,0,1,1,1,1],weights:[1,1,1,1],startParameter:0,endParameter:1}}));
 const input={method:'POST',path:'/revit/link-cad',body:{...p.cad_import_inputs,viewId:20}};
 const applied={success:true,mode:'import',isLinked:false,sourceFormat:'dxf',sourcePath:input.body.sourcePath,sourceSha256:input.body.expectedSourceSha256,
  viewId:20,ownerViewId:20,viewType:'DraftingView',viewCreated:false,viewScale:100,elementId:32,elementUniqueId:'import-32',totalTransformScale:1,
  importUnit:'Foot',customScale:1,colorMode:'Preserved',autoCorrectAlmostVHLines:false,
  transaction:{committed:true,status:'committed',added_element_ids:[32,33],modified_element_ids:[],deleted_element_ids:[]}};
 const page=(offset:number,size:number)=>{
  const items=structuredClone(all.slice(offset,offset+size)),next=offset+items.length===all.length?null:offset+items.length;
  return{schema:'revit-operator.cad-geometry-target/v1',scope:'exact_owner_view_cad_target',read_only:true,wholeViewInventoryRead:false,
   requestedViewId:20,requestedCadElementId:32,view:{id:20,uniqueId:'view-20',viewType:'DraftingView',scale:100},targetReadComplete:true,
   target:{elementId:32,uniqueId:'import-32',ownerViewId:20,className:'ImportInstance',cadGeometry:{schema:'revit-operator.cad-geometry/v1',
    elementId:32,uniqueId:'import-32',ownerViewId:20,isLinked:false,coordinateSpace:'host_model_feet',issues:[],returnedCount:items.length,items,
    complete:offset===0&&next===null,page:{schema:'revit-operator.cad-geometry-page/v1',complete:true,offset,totalPrimitiveCount:all.length,
     nextOffset:next,completeGeometrySnapshotSha256:'d'.repeat(64)}}}};
 };
 return{p,plan,all,input,applied,page};
}
const variants=['one_page','multiple_pages','legacy_long_pages','legacy_late_changed_snapshot','legacy_late_read_failure','legacy_late_pause','missing_pdf','tampered_cad','tampered_descriptor','foreign_source','wrong_owner_second','changed_snapshot','skipped_offset',
 'wrong_geometry','read_failure','paused_after_commit','paused_after_first_page','unknown_apply','wrong_import_hash','linked_instead','no_source_proof_forgery',
 'wrong_native_authority','wrong_read_binding','wrong_result_hash','deleted_collateral','new_view_instead','missing_native_stroke'] as const;
for(const variant of variants)test(`ordinary registered vector CAD ${variant} keeps original-source/native paging integral`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-cad-proof-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();__testOnlyResetTeammateLoopState();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=await fixture(root,variant==='foreign_source'?'another-session':'cad-session');
  if(variant==='missing_pdf')fs.unlinkSync(path.join(root,f.p.source_path));
  if(variant==='tampered_cad')fs.appendFileSync(path.join(root,f.p.stroke_cad_artifact.relative_path),'changed');
  if(variant==='tampered_descriptor')fs.appendFileSync(path.join(root,f.p.stroke_cad_source_descriptor.relative_path),' ');
  if(variant==='wrong_import_hash')f.applied.sourceSha256='e'.repeat(64);
  if(variant==='linked_instead')f.applied.isLinked=true;
  if(variant==='deleted_collateral')f.applied.transaction.deleted_element_ids.push(77 as never);
  if(variant==='new_view_instead')f.applied.viewCreated=true;
  const goal=createGoal({title:'Draft this diagram',objective:'Add the attached diagram, including its text, to a sheet.',acceptance_criteria:['The whole diagram and text are delivered.'],status:'active',
   related_session_id:'cad-session',created_by:'cad-principal',work_budget:{requested_effect:'apply',document_fingerprint:'cad-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'cad-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(){},async callTool(_tool:string,args:any,context:any){
   calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const isRead=args.path==='/revit/view-owned-detailing',offset=args.body.cadGeometryOffset;
   if(isRead&&(variant==='read_failure'||variant==='legacy_late_read_failure'&&offset===90))throw Error('native-read-outcome-unknown');
   const payload:any=isRead?f.page(offset,variant==='one_page'?1000:variant.startsWith('legacy_')?15:50):structuredClone(f.applied);
   if(isRead&&offset===90&&variant==='legacy_late_changed_snapshot')payload.target.cadGeometry.page.completeGeometrySnapshotSha256='e'.repeat(64);
   if(isRead&&offset===90&&variant==='legacy_late_pause')controlAssignmentExecutionV2({binding,command_id:'pause-late-page',expected_command_id:null,action:'pause'});
   if(isRead&&variant==='missing_native_stroke'&&payload.target.cadGeometry.page.nextOffset===null){
    const g=payload.target.cadGeometry;g.items.pop();g.returnedCount--;g.page.totalPrimitiveCount--;
   }
   if(isRead&&offset>0&&variant==='wrong_owner_second')payload.view.uniqueId='foreign-view';
   if(isRead&&offset>0&&variant==='changed_snapshot')payload.target.cadGeometry.page.completeGeometrySnapshotSha256='e'.repeat(64);
   if(isRead&&offset>0&&variant==='skipped_offset')payload.target.cadGeometry.page.offset++;
   if(isRead&&offset===0&&variant==='wrong_geometry')payload.target.cadGeometry.items[0].geometry.end.x+=0.1;
   if(!isRead&&variant==='paused_after_commit'||isRead&&variant==='paused_after_first_page')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
   const returned:any={content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{
    schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',
    persistent_effect:!isRead&&variant==='unknown_apply'?'unknown':isRead?'none':'applied',native_transaction_state:!isRead&&variant==='unknown_apply'?'unknown':isRead?'not_applicable':'committed',authority:'native-host',
    affected_target_identities:isRead?['element_id:32']:['element_id:32','element_id:33'],result_schema_id:'operator-native/POST:'+args.path+'/v2',observation_required:true,
    raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
    request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:payload,semantic_facts:[
     {fact_id:'control.domain_succeeded',fact_class:'control',value:true},
     {fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},{fact_id:'verification.vector_original_source_comparison',fact_class:'control',value:'forged producer assertion'}],verification_relevance:['control']}}};
   if(isRead&&variant==='wrong_native_authority')returned.structuredContent.operation_result_v2.authority='mcp';
   if(isRead&&variant==='wrong_read_binding')returned.structuredContent.operation_result_v2.binding={...binding,generation:binding.generation+1};
   if(isRead&&variant==='wrong_result_hash')returned.structuredContent.operation_result_v2.raw_payload_hash='f'.repeat(64);
   return returned;
  }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'cad-task',user_text:goal.objective,
   context:{revit:{source:{live:true},process_id:42,document:{title:'Fixture model',path:'C:/fixture/model.rvt',project_fingerprint:'cad-model'}}},
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation}as any,{canonicalSupervisionOnly:!variant.startsWith('legacy_')});
  try{
   const response=await handleCodexDynamicToolCall(runtime,{id:'source-cad-import',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'cad-turn',tool:'revit_call_tool',arguments:f.input}}as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   const positive=['one_page','multiple_pages','legacy_long_pages','no_source_proof_forgery'].includes(variant);
   assert.equal(calls.filter(c=>c.path==='/revit/link-cad').length,1,'Never replay the import');
   assert.equal(isReservedVectorPageContinuationV2({token:'caller-asserted'},runtime,{id:'forged',method:'item/tool/call',params:{tool:'revit_call_tool',turnId:'cad-turn',arguments:{method:'POST',path:'/revit/view-owned-detailing',body:{viewId:20,cadElementId:32,cadGeometryOffset:90,cadGeometryLimit:1000,cadTargetOnly:true,includeCadGeometry:true}}}}as any,s),false,'JSON cannot impersonate the host reservation');
   if(variant.startsWith('legacy_late_'))assert.equal(calls.length,8,'Late mismatch, failed read or Pause stops after the seventh page');
   if(positive){assert.equal(calls.length,variant==='one_page'?2:variant==='legacy_long_pages'?9:4,'All contiguous native pages must run through normal handler: '+JSON.stringify({response,calls:calls.map(c=>c.body.cadGeometryOffset??'apply'),operations:Object.values(s.operations).map(o=>({id:o.operation_id,verification_of:o.verification_of_operation_id,status:o.result?.status,dispatch:o.dispatch_state,effect:o.persistent_effect})),outcome:s.outcome,blocker:s.progress_blocker}));
    assert.equal(appliedOperationHasVerifiedPostconditionV2(s,apply.operation_id),true,'Original PDF and all native geometry required');
    assert.deepEqual(verifiedNativeWorkTargetIdentitiesV2(s,apply.operation_id),['element_id:32'],'One CAD instance, not its source-stroke count or text');
    const last=apply.verification_operation_ids.map(id=>s.operations[id]!).sort((a,b)=>b.admitted_assignment_version!-a.admitted_assignment_version!)[0]!;
    assert(last.observation_ids.flatMap(id=>s.observations[id]!.facts).some(f=>f.fact_id==='verification.vector_original_source_comparison'&&String(f.value).includes('matched')));
    const fact=last.observation_ids.flatMap(id=>s.observations[id]!.facts).find(f=>f.fact_id==='verification.vector_original_source_comparison')!;
    const reference=readEvidenceRef(JSON.parse(String(fact.value)).evidence_id);
    const record=JSON.parse(readAuthoritativeEvidence(reference,{...binding,attempt_id:last.operation_id}).toString('utf8'));
    assert.equal(record.cad.nativePageCount,variant==='one_page'?1:variant==='legacy_long_pages'?8:3);assert.equal(record.cad.sourceStrokeCount,120);
    assert.equal(record.sourceEntityCount,120);assert.equal(record.sourcePlanEntityCount,121);assert.equal(record.renderer,'embedded_cad_strokes_v1');
    assert.match(record.scope,/not_text_styles_visuals_or_whole_drawing/);
    assert.equal(vectorSourceProofRecordV2({record,evidence:reference}as any,last.result!),null,'Serialized retained proof cannot impersonate an issued proof');
    const shuffled=structuredClone(s);(shuffled.operations[apply.operation_id]!.verification_operation_ids as string[]).reverse();
    const raw={structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:last.result!,observation:{raw_payload:f.page((last.input.body as any).cadGeometryOffset,variant==='one_page'?1000:variant==='legacy_long_pages'?15:50),semantic_facts:[]}}};
    const issued=await prepareVectorSourceProofV2({operation_id:last.operation_id,assignment_id:goal.id,binding},raw,shuffled);
    assert(issued?.record.matches,'Canonical ID-set order must not substitute for admitted operation chronology');
   }else assert.equal(appliedOperationHasVerifiedPostconditionV2(s,apply.operation_id),false,'Incomplete, changed or foreign evidence cannot verify the import');
   if(variant==='paused_after_commit'||variant==='unknown_apply'||variant==='wrong_import_hash'||variant==='linked_instead')assert.equal(calls.length,1);
   if(variant==='paused_after_first_page'||variant==='read_failure')assert.equal(calls.length,2);
   assert.notEqual(s.outcome,'complete','CAD geometry alone does not deliver text, styles, visuals, sheet or saved model');
  }finally{endTeammateLoopOwner(owner);}
 });}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
});
