import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import fs from 'node:fs';
import {reviewCurrentWork,normalizeVisualReviewRequest,visualWorkReviewModelOutput,VISUAL_WORK_REVIEW_TOOL}from'./visual_work_review.mjs';import {reviewTestPng}from'./fixtures/visual-review-image.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/visual-review-frame-drift169.json',import.meta.url),'utf8'));
const bytes=reviewTestPng(40,40),image=bytes.toString('base64'),sha=createHash('sha256').update(bytes).digest('hex');
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'},request={view_id:41,capture_mode:fixture.requested_mode,checks:[{id:'gap',expected:'No extra blank row below headings; keep visible borders.'}]};
function setup(){let clock=Date.now();const calls={contexts:0,captures:[],providers:[],images:[]};
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Mechanical',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Notes, Symbols & Schedules',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const capture=()=>({image_base64:image,mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'target-unique',viewName:'Notes, Symbols & Schedules',viewType:'DrawingSheet',sheetNumber:'M002',timestamp:new Date(clock).toISOString(),exportMode:'visible_region',widthPx:40,heightPx:40,bytes:bytes.length,sha256:sha,viewport:{source:'UIDocument.ActiveView/UIView.GetZoomCorners',viewId:41,viewType:'DrawingSheet',zoomCornersXyz:[[-1,1,0],[1,-1,0]],coordinateUnits:'feet',displayPlaneOnly:true,placementMappingAvailable:false},canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}});
 const h={prepareFocusedInspection:async r=>({state:'prepared',item_id:r.complete_inspection_item_id}),owner:()=>owner,assertControl:async()=>{},now:()=>clock,readContext:async()=>{throw Error('No screenshot context fallback');},capture:async()=>{throw Error('No UI pixels/tooltips fallback');},readTargetContext:async()=>{calls.contexts++;return context();},captureTarget:async(location,args)=>{calls.captures.push(args);return capture();},retainImage:async pixels=>{calls.images.push(pixels);const b=Buffer.from(pixels,'base64');return{ref:{evidence_id:'ev1_image'+calls.images.length,content_hash:'sha256:'+createHash('sha256').update(b).digest('hex'),byte_count:b.length}};},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Fix blank row in AIR DEVICE SCHEDULE on M002 and preserve borders.',requestResponse:async body=>{calls.providers.push(body);clock+=60000;return{id:'resp_region',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'Synthetic relevant native view pixels.',correction:''}]})};}};
 return{h,calls,context,capture};}
test('one explicit final review can focus native elements then review without extra owner turns',async()=>{
 const f=setup(),sequence=[];f.h.focusTarget=async t=>{sequence.push(t);return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};};
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101,102]},f.h);
 assert.equal(r.state,'matched');assert.equal(sequence.length,1);assert.deepEqual(sequence[0],{view_id:41,show_element_ids:[101,102]});assert.equal(f.calls.providers.length,1);assert.equal(r.request.complete_inspection_item_id,'inspect');assert.equal(r.capture.frame.export_mode,'visible_region');
});
for(const [name,alter]of Object.entries({wrongMode:r=>r.capture_mode='target_view',empty:r=>r.focus_element_ids=[],duplicate:r=>r.focus_element_ids=[1,1],invalid:r=>r.focus_element_ids=[-1],tooMany:r=>r.focus_element_ids=Array.from({length:201},(_,i)=>i+1),historical:r=>r.recheck_evidence_id='ev1_prior'}))test('focus request rejects '+name+' before any host action',()=>{
 const r={...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]};alter(r);assert.throws(()=>normalizeVisualReviewRequest(r),/visual_review_focus_invalid/);
});

test('ordinary inspection focus has no checklist preparation or completion side effects',async()=>{
 const f=setup();let nav=0;
 f.h.prepareFocusedInspection=async()=>{throw Error('No checklist request was made');};
 f.h.focusTarget=async()=>{nav++;return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};};
 const r=await reviewCurrentWork({...request,focus_element_ids:[101,102]},f.h);
 assert.equal(r.state,'matched');assert.equal(nav,1);assert.equal(f.calls.providers.length,1);
 assert.equal(r.request.complete_inspection_item_id,undefined);assert.equal(r.raw_review_evidence.inspection_preparation,undefined);
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 const output=visualWorkReviewModelOutput({type:'function_call_output',call_id:'call',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev_review'}]})},r,'ev_review');
 const visible=readDeliveredReview(output).evidence_projections[0].visual_work_review;
 assert.equal(visible.state,'matched');assert.equal(visible.whole_task_verified,false);assert.equal(visible.native_postcondition_verified,false);
});

test('retained166 focused inspection request parses without inventing a checklist item',()=>{
 // Exact failed request shape from readonly166. Parsing is not a claim that
 // its model-coordinate bounds are appropriate for the requested sheet.
 const r=normalizeVisualReviewRequest({view_id:1363547,capture_mode:'native_visible_region',image_size:5000,
  focus_element_ids:[1546001,1546027,1485510,1546004,1485080,1546029],context_bbox_min_xyz:[-15,5.5,6],context_bbox_max_xyz:[-8.5,16.5,7.2],checks:[
  {id:'both_damper_symbols_distinguishable',expected:'Both balancing damper symbols are visibly present and can be individually distinguished from each other and from the adjacent ductwork.'},
  {id:'nearby_context_visible',expected:'The close-up includes the connecting 6-inch branch ductwork and nearby room/elevator annotations needed to understand the location near Restroom 106A and Elevator E2.'},
  {id:'symbol_clarity_and_overlap',expected:'Each damper symbol is readable at this sheet scale without being obscured, merged with nearby linework, or confused with an annotation.'}]});
 assert.equal(r.complete_inspection_item_id,undefined);assert.equal(r.focus_element_ids.length,6);
});

for(const change of ['document','epoch','sequence','owner','pause'])test('ordinary focus retains '+change+' guard without a completion item',async()=>{
 const f=setup();let changed=false;f.h.prepareFocusedInspection=async()=>{throw Error('Must not prepare checklist');};
 f.h.focusTarget=async()=>{changed=true;return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};};
 f.h.readTargetContext=async()=>{const c=f.context();if(changed){if(change==='document')c.document.sessionId='other';if(change==='epoch')c.nativeChangeObservations.epoch='other';if(change==='sequence')c.nativeChangeObservations.throughSequence=1;}return c;};
 if(change==='owner')f.h.owner=()=>changed?{...owner,run_id:'foreign'}:owner;
 if(change==='pause')f.h.assertControl=async()=>{if(changed)throw Error('Paused');};
 const r=await reviewCurrentWork({...request,focus_element_ids:[101]},f.h);
 assert.equal(r.state,'unavailable');assert.equal(f.calls.providers.length,0);assert.equal(f.calls.captures.length,0);
});

test('explicit invalid completion item is still rejected before navigation',()=>{
 assert.throws(()=>normalizeVisualReviewRequest({...request,focus_element_ids:[101],complete_inspection_item_id:''}),/visual_review_inspection_item_invalid/);
});

test('model-visible focus instructions distinguish sheet coordinates and optional checklist closeout',async()=>{
 const {NATIVE_VIEW_ACTIVATION_TOOL}=await import('./native_view_activation.mjs');
 const reviewText=JSON.stringify(VISUAL_WORK_REVIEW_TOOL),navigationText=JSON.stringify(NATIVE_VIEW_ACTIVATION_TOOL);
 assert.match(reviewText,/No checklist item is needed for ordinary inspection/);
 for(const text of [reviewText,navigationText]){assert.match(text,/sheet feet/);assert.match(text,/model feet/);assert.match(text,/without bounds/);}
 assert.doesNotMatch(reviewText,/Requires explicit complete_inspection_item_id and/);
});

test('ordinary navigation with an unconfirmed footprint spends no capture or reviewer call',async()=>{
 const f=setup();f.h.focusTarget=async()=>({ok:false,focus_pending:true,error:'Requested contextual bounds exclude a projected native target.'});
 const r=await reviewCurrentWork({...request,focus_element_ids:[101]},f.h);
 assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_focus_unconfirmed');assert.equal(f.calls.captures.length,0);assert.equal(f.calls.providers.length,0);
});
for(const [name,result]of Object.entries({failed:{ok:false},pending:{ok:true,active_view:{id:41},focus:{confirmed:false}},wrongView:{ok:true,active_view:{id:42},focus:{confirmed:true,kind:'elements',native_navigation_only:true}},wrongKind:{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'fit',native_navigation_only:true}}}))test('unconfirmed focus '+name+' spends no reviewer call',async()=>{
 const f=setup();f.h.focusTarget=async()=>result;const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);assert.equal(r.state,'unavailable');assert.equal(f.calls.providers.length,0);assert.equal(f.calls.captures.length,0);
});
for(const change of ['document','epoch','sequence','owner','pause'])test('focus retains '+change+' guard before capture',async()=>{
 const f=setup();let changed=false;f.h.focusTarget=async()=>{changed=true;return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};};
 f.h.readTargetContext=async()=>{const c=f.context();if(changed){if(change==='document')c.document.sessionId='other';if(change==='epoch')c.nativeChangeObservations.epoch='other';if(change==='sequence')c.nativeChangeObservations.throughSequence=1;}return c;};
 if(change==='owner')f.h.owner=()=>changed?{...owner,run_id:'foreign'}:owner;
 if(change==='pause')f.h.assertControl=async()=>{if(changed)throw Error('Paused');};
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);assert.equal(r.state,'unavailable');assert.equal(f.calls.providers.length,0);assert.equal(f.calls.captures.length,0);
});
test('composed focus still rejects image drift after reviewer and cannot claim completion',async()=>{
 const f=setup();f.h.focusTarget=async()=>({ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}});let n=0;
 f.h.captureTarget=async()=>{const c=f.capture();if(++n===2)c.native_result.viewport.zoomCornersXyz[0][0]=-2;return c;};
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);assert.equal(r.reason,'visual_review_visible_frame_changed_during_review');assert.equal(f.calls.providers.length,1);assert.equal(r.whole_task_verified,false);assert.equal(r.native_postcondition_verified,false);
});
test('composed navigation confirms activation before focusing and never repeats a pending activation',async()=>{
 const {focusNativeReviewTarget}=await import('./native_view_activation.mjs');const calls=[];const target={view_id:41,show_element_ids:[101]};
 const h={activeViewId:7,assertCurrent:async()=>{},activate:async r=>{calls.push(r);return{ok:true,active_view:{id:41},...(r.show_element_ids?{focus:{confirmed:true,kind:'elements',native_navigation_only:true}}:{})};}};
 const r=await focusNativeReviewTarget(target,h);assert.equal(r.focus.confirmed,true);assert.deepEqual(calls,[{view_id:41},target]);
 calls.length=0;h.activate=async r=>{calls.push(r);return{ok:false,activation_pending:true};};await focusNativeReviewTarget(target,h);assert.equal(calls.length,1);
});
test('already active view requires only one tracked focus dispatch',async()=>{
 const {focusNativeReviewTarget}=await import('./native_view_activation.mjs');let calls=0;await focusNativeReviewTarget({view_id:41,show_element_ids:[101]},{activeViewId:41,assertCurrent:async()=>{},activate:async()=>{calls++;return{ok:false};}});assert.equal(calls,1);
});

test('explicit contextual bounds and element focus use one native request in the same review call',async()=>{
 const f=setup(),sequence=[];
 f.h.focusTarget=async t=>{sequence.push(t);return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:t.show_element_ids&&t.bbox_min_xyz?'elements_and_bounds':'elements',native_navigation_only:true}};};
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101],context_bbox_min_xyz:[0.05,1.5,0],context_bbox_max_xyz:[1.55,2.45,0]},f.h);
 assert.equal(r.state,'matched');
 assert.deepEqual(sequence,[{view_id:41,show_element_ids:[101],bbox_min_xyz:[0.05,1.5,0],bbox_max_xyz:[1.55,2.45,0]}]);
 assert.equal(f.calls.providers.length,1);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 assert.equal(r.raw_review_evidence.context_navigation.focus.kind,'elements_and_bounds');
});

test('context navigation reuses bounded native activation without another element-only zoom',async()=>{
 const {focusNativeReviewTarget}=await import('./native_view_activation.mjs');const calls=[];
 const target={view_id:41,bbox_min_xyz:[0.05,1.5,0],bbox_max_xyz:[1.55,2.45,0]};
 const r=await focusNativeReviewTarget(target,{activeViewId:41,assertCurrent:async()=>{},activate:async t=>{calls.push(t);return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'bounds',native_navigation_only:true}};}});
 assert.deepEqual(calls,[target]);assert.equal(r.focus.kind,'bounds');
});

for(const [name,alter]of Object.entries({missingMax:r=>delete r.context_bbox_max_xyz,missingMin:r=>delete r.context_bbox_min_xyz,missingIds:r=>delete r.focus_element_ids,reversed:r=>r.context_bbox_min_xyz=[3,3,0],nonfinite:r=>r.context_bbox_max_xyz=[Infinity,3,0],degenerate:r=>r.context_bbox_max_xyz=[.05,1.5,1],pixelObject:r=>r.context_bbox_min_xyz={x:1,y:2},wrongMode:r=>r.capture_mode='target_view',recheck:r=>r.recheck_evidence_id='prior'}))test('context bounds reject '+name+' before navigation',()=>{
 const r={...request,complete_inspection_item_id:'inspect',focus_element_ids:[101],context_bbox_min_xyz:[.05,1.5,0],context_bbox_max_xyz:[1.55,2.45,0]};alter(r);assert.throws(()=>normalizeVisualReviewRequest(r));
});
for(const failure of ['pending','wrong-kind','document','epoch','sequence','owner','pause'])test('context focus keeps '+failure+' rejection before pixels/provider',async()=>{
 const f=setup();let contextMove=false;
 f.h.focusTarget=async t=>{contextMove=!!t.bbox_min_xyz;return{ok:true,active_view:{id:41},focus:{confirmed:!(contextMove&&failure==='pending'),kind:contextMove?(failure==='wrong-kind'?'elements':'elements_and_bounds'):'elements',native_navigation_only:true}};};
 f.h.readTargetContext=async()=>{const c=f.context();if(contextMove){if(failure==='document')c.document.sessionId='foreign';if(failure==='epoch')c.nativeChangeObservations.epoch='other';if(failure==='sequence')c.nativeChangeObservations.throughSequence=1;}return c;};
 if(failure==='owner')f.h.owner=()=>contextMove?{...owner,session_id:'foreign'}:owner;
 if(failure==='pause')f.h.assertControl=async()=>{if(contextMove)throw Error('Paused');};
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101],context_bbox_min_xyz:[.05,1.5,0],context_bbox_max_xyz:[1.55,2.45,0]},f.h);
 assert.equal(r.state,'unavailable');assert.equal(f.calls.captures.length,0);assert.equal(f.calls.providers.length,0);
});
test('successful context navigation cannot promote an uncertain visual verdict',async()=>{
 const f=setup();f.h.focusTarget=async t=>({ok:true,active_view:{id:41},focus:{confirmed:true,kind:t.show_element_ids&&t.bbox_min_xyz?'elements_and_bounds':'elements',native_navigation_only:true}});
 f.h.requestResponse=async()=>({id:'uncertain',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'uncertain',observed:'Required border not visible.',correction:'Obtain the missing context.'}]})});
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101],context_bbox_min_xyz:[.05,1.5,0],context_bbox_max_xyz:[1.55,2.45,0]},f.h);
 assert.equal(r.state,'uncertain');assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
});

test('failed final-inspection preparation never navigates, captures or calls a provider',async()=>{
 const f=setup();let nav=0;f.h.prepareFocusedInspection=async()=>({state:'not_submitted',reason:'native_inspection_candidate_unavailable'});f.h.focusTarget=async()=>nav++;
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);assert.equal(r.reason,'visual_review_final_inspection_not_ready');assert.equal(nav,0);assert.equal(f.calls.captures.length,0);assert.equal(f.calls.providers.length,0);
});

test('real preparation and visual consumer review one region while retaining a multi-view native scope',async()=>{
 const {prepareFocusedInspection}=await import('./reviewed_inspection_closeout.mjs');
 const f=setup(),calls=[];
 const snapshot={current_binding:owner,assignment_version:358,terminal:false,outcome:'active',quiescent:true,
  spec:{work_plan_required:true},in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],
  work_plan:{items:[{item_id:'work',kind:'edit',completed_at:'2026-10-28T05:30:00Z',operation_ids:['apply']},{item_id:'inspect',kind:'inspection',depends_on:['work'],operation_ids:[]}]},
  operations:{read:{requested_effect:'read'}}};
 const status={ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'inspect',validation_required:true,coverage_only:true,existing_element_read_candidates:['read'],
  required_target_ids:['element_id:101','element_id:201','element_id:202','element_id:203','element_id:204','element_id:205','element_id:206','element_id:207','file:result.rvt']}}};
 const before=JSON.stringify({snapshot,status});
 f.h.prepareFocusedInspection=r=>prepareFocusedInspection({binding:owner,itemId:r.complete_inspection_item_id,focusElementIds:r.focus_element_ids,readSnapshot:async()=>snapshot,
  request:async(p,o)=>{calls.push(JSON.parse(o.body));return status;}});
 let nav=0;f.h.focusTarget=async()=>{nav++;return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};};
 const result=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);
 assert.equal(result.state,'matched');assert.equal(nav,1);assert.equal(f.calls.providers.length,1);
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 assert.equal(JSON.stringify({snapshot,status}),before);assert.deepEqual(calls,[{...owner,action:'status'}]);
 const output=visualWorkReviewModelOutput({type:'function_call_output',call_id:'call',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev_review'}]})},result,'ev_review');
 const feedback=readDeliveredReview(output).evidence_projections[0].visual_work_review;
 assert.equal(feedback.state,'matched');assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
});

test('retained schedule focus exclusion remains unavailable but reaches the execution model as its exact cause',async()=>{
 const f=setup();let nav=0;
 // Same preparation shape retained from a real placed-instance versus
 // schedule-view mismatch; the rejected identities are not interchangeable.
 f.h.prepareFocusedInspection=async()=>({state:'not_submitted',reason:'focus_excludes_inspection_targets',required_focus_element_ids:[1422218],native_postcondition_verified:false,whole_task_verified:false});
 f.h.focusTarget=async()=>nav++;
 const r=await reviewCurrentWork({...request,complete_inspection_item_id:'inspect',focus_element_ids:[101]},f.h);
 assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_final_inspection_not_ready');
 assert.equal(r.inspection_preparation?.reason,'focus_excludes_inspection_targets');
 const output=visualWorkReviewModelOutput({type:'function_call_output',call_id:'call',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev-review'}]})},r,'ev-review');
 assert.match(output.output,/focus_excludes_inspection_targets/);
 assert.match(output.output,/"required_focus_element_ids":\[1422218\]/);
 assert.equal(nav,0);assert.equal(f.calls.providers.length,0);assert.equal(r.native_postcondition_verified,false);
});

function readDeliveredReview(wire){assert(Array.isArray(wire.output));assert.equal(wire.output[0].type,"input_text");assert(wire.output.some(b=>b.type==="input_image"&&b.image_url==="data:image/png;base64,"+image));return JSON.parse(wire.output[0].text);}
