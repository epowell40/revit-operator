import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {recordWorkPlanLocationV2,projectWorkPlanLocationV2} from '../src/domain/assignment-kernel/work_plan_location.js';
import {imageInputManifest} from '../src/desktop_image_delivery.js';
import {projectExecutionContinuation} from '../src/assignments/execution_continuation.js';
import {addDraftingReferenceTracking} from '../src/attachments/drafting_reference_tracking.js';
import {projectWorkPlan} from '../src/assignments/work_plan_projection.js';
const at='2026-10-31T21:00:00Z';
function fixture():any{
 const s=JSON.parse(fs.readFileSync('test/fixtures/c43-area-budget-plan.json','utf8'));
 Object.assign(s,{operations:{},provider_calls:{},progress_epochs:[],quiescent:true,outcome:'active',terminal:false,progress_blocker:undefined,
  provider_budget_exhausted:false,provider_usage_hold:undefined,in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],completion_proposal:undefined});
 s.spec.execution_policy={...s.spec.execution_policy,ready_work_handoff:'continue_ready_work_v1'};
 s.spec.created_at=at;
 s.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[{item_id:'branch',description:'West branch',source_basis:'PDF page 1 west',declared_at:at,operation_ids:[]}]};
 return s;
}

test('resource advice survives absent or completed plans without authorizing continuation',()=>{
 for(const plan of [undefined,{schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[]}]){
  const s=fixture();s.work_plan=plan;const before=JSON.stringify(s),c:any=projectExecutionContinuation(s,at);
  assert.equal(c.state,'hold');assert.equal(c.reason,'no_ready_work');assert.deepEqual(c.next_items,[]);
  assert.equal(c.resource_advice_only,true);assert(c.remaining_resources);assert.equal(c.construction_progress,null);assert.equal(c.progress_key,undefined);
  assert.equal(JSON.stringify(s),before);
  s.spec.execution_policy.progress_allowance={mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',
   max_provider_calls:256,max_operations:1024,max_total_tokens:32000000,max_wall_clock_ms:7200000};
  const paced:any=projectExecutionContinuation(s,at);
  assert.equal(paced.state,'hold');assert.equal(paced.reason,'no_ready_work');
  assert.equal(paced.construction_progress.calls_since_construction,0);
  assert.equal(paced.construction_progress.changes_allowance,false);
 }
 const s=fixture();delete s.spec.execution_policy.ready_work_handoff;
 const ordinary:any=projectExecutionContinuation(s,at);assert.equal(ordinary.reason,'ordinary_task_reporting');
 assert.equal(ordinary.resource_advice_only,true);
 for(const patch of [{terminal:true},{outcome:'awaiting_user_input'},{execution_control:{state:'paused'}},
  {provider_usage_hold:{}},{in_flight_provider_call_ids:['pending']},{quiescent:false},
  {unresolved_unknown_operation_ids:['unknown']},{pending_review_ids:['review']},{pending_input_variable_ids:['question']},
  {completion_proposal:{}},{progress_blocker:{code:'no_progress'}},{provider_budget_exhausted:true}]){
  const held:any=projectExecutionContinuation({...s,...patch},at);
  assert.equal(held.state,'hold');assert.equal(held.resource_advice_only,undefined);assert.equal(held.remaining_resources,undefined);
 }
});
test('active actor continuation carries measured token reserve and keeps Pause and unknown holds',()=>{
 const s=fixture();
 s.provider_calls={a:{binding:s.current_binding,admitted_at:at,completed_at:at,state:'completed',usage:{total_tokens:227767}}};
 const before=JSON.stringify(s),c:any=projectExecutionContinuation(s,at);
 assert.equal(c.state,'ready');
 assert.equal(c.token_runway.tokens_per_call,227767);
 assert.equal(c.token_runway.estimated_calls_remaining,Math.floor(c.remaining_resources.total_tokens.remaining/227767));
 assert.equal(JSON.stringify(s),before);
 for(const patch of [{execution_control:{state:'paused'}},{unresolved_unknown_operation_ids:['unknown']},{provider_usage_hold:{reason:'pending'}}]){
  const held:any=projectExecutionContinuation({...s,...patch},at);
  assert.equal(held.state,'hold');assert.equal(held.token_runway,undefined);
 }
});
function hint(s:any):any{return {status:'candidate',reason:'Matched corridor and room boundary.',source:{attachment_id:'pdf',filename:'source.pdf',sha256:'a'.repeat(64),page:1,page_count:1,region:{min_u:.1,min_v:.2,max_u:.4,max_v:.5}},
 native:{document_fingerprint:s.current_binding.document_fingerprint,view_id:20,view_name:'Plan'},
 drafting:{pass:'geometry',stage:'drafted',element_ids:[42],read_operation_ids:[],next_action:'Connect the branch outlet.',remaining:'Outlet and annotation.',boundary_context:'Main continues east beyond crop.'}};}
test('branch tracking survives JSON recovery without completing or dropping parent scope',()=>{
 const s=fixture(),h=hint(s);s.work_plan=recordWorkPlanLocationV2(s,'branch',h,at);
 const restored=JSON.parse(JSON.stringify(s)),p=projectWorkPlanLocationV2(restored.work_plan.items[0],restored)!;
 assert.equal(p.drafting!.stage,'drafted');assert.equal(p.drafting!.next_action,'Connect the branch outlet.');
 assert.deepEqual(p.drafting!.element_ids,[42]);assert.equal(p.verified,false);assert.equal(restored.work_plan.items[0].completed_at,undefined);
 assert.equal(p.drafting_passes[0]!.host_certified,false);
});
test('a successful write alone cannot be checked; native current read and distinct images are required',()=>{
 const s=fixture(),h=hint(s);h.drafting.stage='checked';
 assert.throws(()=>recordWorkPlanLocationV2(s,'branch',h,at),/Backchecking/);
 Object.assign(h.drafting,{source_image_sha256:'b'.repeat(64),model_image_sha256:'c'.repeat(64),read_operation_ids:['read']});
 assert.throws(()=>recordWorkPlanLocationV2(s,'branch',h,at),/native readback/);
 s.operations.read={requested_effect:'read',persistent_effect:'none',settlement_state:'settled',binding:s.current_binding,opened_at:'2026-10-31T20:59:00Z',result:{authority:'native-host',status:'succeeded',binding:s.current_binding,completed_at:at}};
 s.work_plan=recordWorkPlanLocationV2(s,'branch',h,at);
 assert.equal(projectWorkPlanLocationV2(s.work_plan.items[0],s)!.drafting_passes[0]!.needs_recheck,false);
 const progress=(projectExecutionContinuation(s,at) as any).progress_key;
 s.work_plan=recordWorkPlanLocationV2(s,'branch',h,at);
 assert.equal((projectExecutionContinuation(s,at) as any).progress_key,progress,'Repeated checkoff is not another progress cycle.');
 const moved=structuredClone(h);moved.drafting.pass='annotations';moved.drafting.stage='drafted';moved.source.region.max_u=.6;
 const relocated={...s,work_plan:recordWorkPlanLocationV2(s,'branch',moved,at)};
 assert.equal(projectWorkPlanLocationV2(relocated.work_plan.items[0],relocated)!.drafting_passes[0]!.needs_recheck,true,
   'Expanding a source region cannot paint earlier checks as coverage of the newly included area.');
 s.operations.later={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-31T21:01:00Z',result:{completed_at:'2026-10-31T21:01:01Z',affected_target_identities:['element_id:42']}};
 assert.equal(projectWorkPlanLocationV2(s.work_plan.items[0],s)!.drafting_passes[0]!.needs_recheck,true);
 assert.throws(()=>recordWorkPlanLocationV2(s,'branch',h,'2026-10-31T21:02:00Z'),/native readback/);
});
test('source/element/readback records cannot inject completion authority or foreign native identity',()=>{
 const s=fixture();for(const change of [(h:any)=>h.drafting.host_certified=true,(h:any)=>h.native.document_fingerprint='foreign',(h:any)=>h.drafting.element_ids=[42,42],(h:any)=>h.drafting.pass='everything',(h:any)=>delete h.source.region]){
  const h=hint(s);change(h);assert.throws(()=>recordWorkPlanLocationV2(s,'branch',h,at));
 }
});

test('mixed pre/post-SaveAs C# reads identify stale evidence and preserve usable current readback',()=>{
 const s=fixture(),h=hint(s),binding=s.current_binding;
 const read=(opened:string)=>({capability_id:'operator_run_dynamic_revit_program',input:{mode:'read'},requested_effect:'read',persistent_effect:'none',settlement_state:'settled',binding:{...binding},opened_at:opened,result:{authority:'native-host',status:'succeeded',binding:{...binding},completed_at:opened}});
 s.operations.before=read('2026-10-31T20:57:00Z');s.operations.current=read('2026-10-31T20:59:00Z');
 s.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-31T20:58:00Z',result:{completed_at:'2026-10-31T20:58:10Z'}};
 Object.assign(h.drafting,{stage:'checked',source_image_sha256:'b'.repeat(64),model_image_sha256:'c'.repeat(64),read_operation_ids:['current','before']});
 assert.throws(()=>recordWorkPlanLocationV2(s,'branch',h,at),e=>{
  assert.match((e as Error).message,/before: predates_latest_effect/);assert.match((e as Error).message,/Current eligible native reads: current/);return true;
 });
 const original=structuredClone(s);h.drafting.read_operation_ids=['current'];
 const plan=recordWorkPlanLocationV2(s,'branch',h,at);
 assert.equal(plan.items[0]!.location_history!.at(-1)!.drafting!.stage,'checked');assert.deepEqual(s,original);
 for(const fault of ['failed','foreign','pending','invalidated','unknown','write','future']){
  const bad=structuredClone(s);if(fault==='failed')bad.operations.current.result.status='failed';if(fault==='foreign')bad.operations.current.result.binding.run_id='other';
  if(fault==='pending')bad.in_flight_operation_ids=['pending'];if(fault==='invalidated')bad.input_invalidated_operation_ids=['current'];if(fault==='unknown')bad.unresolved_unknown_operation_ids=['unknown'];
  if(fault==='write')bad.operations.current.requested_effect='apply';if(fault==='future')bad.operations.current.result.completed_at='2026-10-31T21:01:00Z';
  assert.throws(()=>recordWorkPlanLocationV2(bad,'branch',h,at),/native readback/,fault);
 }
});
test('only real image input blocks count as delivered pixels, never textual paths, IDs or escaped JSON',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,AQID'};
 assert.equal(imageInputManifest([{role:'user',content:[image]}]).length,1);
 assert.equal(imageInputManifest([{type:'function_call_output',output:[image]}]).length,1);
 assert.equal(imageInputManifest([{type:'function_call_output',output:JSON.stringify(image)},{role:'user',content:[{type:'input_text',text:'C:/image.png attachment-1'}]}]).length,0);
});
test('highlighted reference keeps clean pixels and transforms source regions into crop coordinates',async()=>{
 const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(100,100);canvas.getContext('2d').fillRect(0,0,100,100);
 const image={type:'image',mimeType:'image/png',data:canvas.toBuffer('image/png').toString('base64')};
 const s=fixture();s.work_plan=recordWorkPlanLocationV2(s,'branch',hint(s),at);
 const metadata={page:1,sha256:'a'.repeat(64),attachment_id:'pdf',image_geometry:{pixel_to_normalized_page:{u_offset:0,v_offset:0,u_per_pixel:.01,v_per_pixel:.01}}};
 const result=await addDraftingReferenceTracking({content:[{type:'text',text:JSON.stringify(metadata)},image]},s);
 assert.deepEqual(result.content[1],image);assert.equal(result.content.filter((v:any)=>v.type==='image').length,2);
 const tracking=JSON.parse(result.content[2].text).drafting_tracking;
 assert.equal(tracking.marks[0].item_id,'branch');assert.match(tracking.legend,/Unmarked areas remain undiscovered/);
 assert.equal(tracking.marks[0].passes[0].linked_element_count,1);
 assert.match(tracking.legend,/linked subset/);
 const checked=hint(s);
 s.operations.read={requested_effect:'read',persistent_effect:'none',settlement_state:'settled',binding:s.current_binding,opened_at:'2026-10-31T20:59:00Z',
  result:{authority:'native-host',status:'succeeded',binding:s.current_binding,completed_at:at}};
 Object.assign(checked.drafting,{stage:'checked',source_image_sha256:'b'.repeat(64),model_image_sha256:'c'.repeat(64),read_operation_ids:['read']});
 s.work_plan=recordWorkPlanLocationV2(s,'branch',checked,at);
 const annotations=hint(s);annotations.drafting.pass='annotations';annotations.drafting.element_ids=[];
 s.work_plan=recordWorkPlanLocationV2(s,'branch',annotations,at);
 const mixed=await addDraftingReferenceTracking({content:[{type:'text',text:JSON.stringify(metadata)},image]},s);
 assert.deepEqual(mixed.content[1],image);
 assert.deepEqual(JSON.parse(mixed.content[2].text).drafting_tracking.marks[0].passes
  .map((p:any)=>[p.pass,p.stage,p.linked_element_count]),[['geometry','checked',1],['annotations','drafted',0]]);
 assert.equal(s.work_plan.items[0].completed_at,undefined);
 const foreign=await addDraftingReferenceTracking({content:[{type:'text',text:JSON.stringify({...metadata,sha256:'f'.repeat(64)})},image]},s);
 assert.equal(foreign.content.length,2);
});

test('dense reference tracking stays within the clean-image pairing limit and reports omitted marks',async()=>{
 const {createCanvas}=await import('@napi-rs/canvas'),s=fixture();
 for(const pass of ['geometry','sizes_properties','connections','elevation','annotations','coverage']){
  const h=hint(s);h.drafting.pass=pass;
  s.work_plan=recordWorkPlanLocationV2(s,'branch',h,at);
 }
 const item=s.work_plan.items[0];
 s.work_plan.items=Array.from({length:128},(_,n)=>({...item,item_id:'area_'+n}));
 const metadata={page:1,sha256:'a'.repeat(64),attachment_id:'pdf',image_geometry:{pixel_to_normalized_page:{u_offset:0,v_offset:0,u_per_pixel:.01,v_per_pixel:.01}}};
 const image={type:'image',mimeType:'image/png',data:createCanvas(100,100).toBuffer('image/png').toString('base64')};
 const overlay=await addDraftingReferenceTracking({content:[{type:'text',text:JSON.stringify(metadata)},image]},s);
 assert.deepEqual(overlay.content[1],image);
 assert.equal(overlay.content.filter((v:any)=>v.type==='image').length,2);
 assert(Buffer.byteLength(overlay.content[2].text,'utf8')<32768);
 const tracking=JSON.parse(overlay.content[2].text).drafting_tracking;
 assert(tracking.omitted_visible_mark_count>0);
 assert.equal(tracking.marks.length+tracking.omitted_visible_mark_count,128);
});
test('execution continuation honors every ordinary stop and never counts repeated reads as construction progress',()=>{
 const s=fixture(),first=projectExecutionContinuation(s,at);assert.equal(first.state,'ready');
 s.operations.read={operation_id:'read',requested_effect:'read',persistent_effect:'none',settlement_state:'settled',opened_at:at,settled_at:at};
 assert.equal((projectExecutionContinuation(s,at) as any).progress_key,(first as any).progress_key);
 for(const patch of [{terminal:true},{outcome:'blocked'},{execution_control:{state:'paused'}},{provider_usage_hold:{}},
 {in_flight_provider_call_ids:['pending']},{quiescent:false},{in_flight_operation_ids:['pending']},{unresolved_unknown_operation_ids:['unknown']},
 {pending_input_variable_ids:['input']},{pending_review_ids:['review']},{completion_proposal:{}},{progress_blocker:{code:'no_progress'}},{provider_budget_exhausted:true}])
 assert.equal(projectExecutionContinuation({...s,...patch},at).state,'hold');
});

test('six drafting passes and a long branch record cannot stall bounded status pagination',()=>{
 const s=fixture();s.work_plan.items[0].description='d'.repeat(800);s.work_plan.items[0].source_basis='s'.repeat(800);
 for(const pass of ['geometry','sizes_properties','connections','elevation','annotations','coverage']){
  const h=hint(s);h.drafting.pass=pass;h.drafting.element_ids=Array.from({length:64},(_,i)=>2147483000+i);
  h.drafting.next_action='n'.repeat(240);h.drafting.remaining='r'.repeat(400);
  s.work_plan=recordWorkPlanLocationV2(s,'branch',h,at);
 }
 const p=projectWorkPlan(s.work_plan,0,0,s)!;
 assert.equal(p.scope.items.length,1);assert.equal(p.scope.next_start,null);
 assert(Buffer.byteLength(JSON.stringify(p.scope.items))<=4000);
 const location=p.scope.items[0]!.location_hint as any;
 assert.equal(location.drafting.element_count,64);assert.equal(location.drafting.element_ids.length,16);
 assert.equal(location.drafting_passes.length,6);assert.equal(s.work_plan.items[0].location_history.length,6);
});
