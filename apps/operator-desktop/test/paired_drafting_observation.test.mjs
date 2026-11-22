import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import fs from 'node:fs';
import {reviewCurrentWork,normalizeVisualReviewRequest,visualWorkReviewModelOutput,VISUAL_WORK_REVIEW_TOOL}from'../visual_work_review.mjs';
const imageFixture=[new URL('../../packages/operator-assistant-ui/fixtures/visual-review-image.mjs',import.meta.url),new URL('../../../packages/operator-assistant-ui/fixtures/visual-review-image.mjs',import.meta.url)].find(p=>fs.existsSync(p));
assert(imageFixture,'The shared review image fixture must exist in either supported layout');
const {reviewTestPng}=await import(imageFixture.href);
const bytes=reviewTestPng(40,40),image=bytes.toString('base64'),sha=createHash('sha256').update(bytes).digest('hex');
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'},request={view_id:41,capture_mode:'native_visible_region',checks:[{id:'gap',expected:'No extra blank row below headings; keep visible borders.'}]};
function setup(){let clock=Date.now();const calls={contexts:0,captures:[],providers:[],images:[]};
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Mechanical',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Notes, Symbols & Schedules',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const capture=()=>({image_base64:image,mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'target-unique',viewName:'Notes, Symbols & Schedules',viewType:'DrawingSheet',sheetNumber:'M002',timestamp:new Date(clock).toISOString(),exportMode:'visible_region',widthPx:40,heightPx:40,bytes:bytes.length,sha256:sha,viewport:{source:'UIDocument.ActiveView/UIView.GetZoomCorners',viewId:41,viewType:'DrawingSheet',zoomCornersXyz:[[-1,1,0],[1,-1,0]],coordinateUnits:'feet',displayPlaneOnly:true,placementMappingAvailable:false},canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}});
 const h={prepareFocusedInspection:async r=>({state:'prepared',item_id:r.complete_inspection_item_id}),owner:()=>owner,assertControl:async()=>{},now:()=>clock,readContext:async()=>{throw Error('No screenshot context fallback');},capture:async()=>{throw Error('No UI pixels/tooltips fallback');},readTargetContext:async()=>{calls.contexts++;return context();},captureTarget:async(location,args)=>{calls.captures.push(args);return capture();},retainImage:async pixels=>{calls.images.push(pixels);const b=Buffer.from(pixels,'base64');return{ref:{evidence_id:'ev1_image'+calls.images.length,content_hash:'sha256:'+createHash('sha256').update(b).digest('hex'),byte_count:b.length}};},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Fix blank row in AIR DEVICE SCHEDULE on M002 and preserve borders.',requestResponse:async body=>{calls.providers.push(body);clock+=60000;return{id:'resp_region',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'Synthetic relevant native view pixels.',correction:''}]})};}};
 return{h,calls,context,capture};}

test('an observation refresh restores the retained area and returns fresh pixels without a reviewer',async()=>{
 const f=setup(),focus=[];
 f.h.focusTarget=async t=>{focus.push(t);return {ok:true,active_view:{id:41},focus:{confirmed:true,kind:t.show_element_ids?'elements_and_bounds':'bounds',native_navigation_only:true}};};
 const area={...request,review_mode:'observe',focus_element_ids:[101,102],context_bbox_min_xyz:[-1,-1,0],context_bbox_max_xyz:[1,1,0]};
 const first=await reviewCurrentWork(area,f.h);
 assert.equal(first.state,'observed');
 const pixels={evidence_ref:{evidence_id:first.capture.evidence_id,content_hash:first.capture.content_hash,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image};
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area'},review:first,capture:pixels,reference:null});
 const refreshed=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area'},f.h);
 assert.equal(refreshed.state,'observed',refreshed.reason);
 assert.deepEqual(focus[1],{view_id:41,bbox_min_xyz:area.context_bbox_min_xyz,bbox_max_xyz:area.context_bbox_max_xyz});
 assert.equal(f.calls.captures.length,2);
 assert.equal(f.calls.providers.length,0);
 assert.equal(refreshed.native_postcondition_verified,false);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area2'},review:refreshed,capture:{...pixels,evidence_ref:{...pixels.evidence_ref,evidence_id:refreshed.capture.evidence_id}},reference:null});
 const again=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area2'},f.h);
 assert.equal(again.state,'observed',again.reason);
 assert.deepEqual(focus[2],focus[1]);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area'},review:first,capture:pixels,reference:null});
 const shown=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_new'}]})},refreshed,'ev1_new');
 assert(Array.isArray(shown.output));
 assert(shown.output.some(i=>i.type==='input_image'));
 const forbidden=await reviewCurrentWork({view_id:41,recheck_evidence_id:'ev1_area'},f.h);
 assert.equal(forbidden.state,'unavailable');
 assert.equal(f.calls.providers.length,0);
});

test('rechecking a corrected area retains its frame after a previously focused tag was deleted',async()=>{
 const f=setup(),focus=[];let corrected=false;
 f.h.focusTarget=async t=>{focus.push(t);return {ok:true,active_view:{id:41},focus:{confirmed:!corrected||!t.show_element_ids?.includes(101),
  kind:t.show_element_ids?'elements_and_bounds':'bounds',native_navigation_only:true}};};
 const first=await reviewCurrentWork({...request,review_mode:'observe',focus_element_ids:[101,102],context_bbox_min_xyz:[-1,-1,0],context_bbox_max_xyz:[1,1,0]},f.h);
 assert.equal(first.state,'observed');corrected=true;
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_deleted_tag'},review:first,
  capture:{evidence_ref:{evidence_id:first.capture.evidence_id,content_hash:first.capture.content_hash,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image},reference:null});
 const result=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_deleted_tag'},f.h);
 assert.equal(result.state,'observed',result.reason);
 assert.deepEqual(focus[1],{view_id:41,bbox_min_xyz:[-1,-1,0],bbox_max_xyz:[1,1,0]});
 assert.equal(f.calls.captures.length,2);assert.equal(f.calls.providers.length,0);
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
});

test('initial element focus and bounds-less rechecks still require their actual native targets',async()=>{
 const f=setup();let missing=false;
 f.h.focusTarget=async()=>({ok:true,active_view:{id:41},focus:{confirmed:!missing,kind:'elements',native_navigation_only:true}});
 const first=await reviewCurrentWork({...request,review_mode:'observe',focus_element_ids:[101]},f.h);assert.equal(first.state,'observed');missing=true;
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_without_bounds'},review:first,
  capture:{evidence_ref:{evidence_id:first.capture.evidence_id,content_hash:first.capture.content_hash,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image},reference:null});
 const again=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_without_bounds'},f.h);
 assert.equal(again.state,'unavailable');assert.equal(again.reason,'visual_review_focus_unconfirmed');
 const initial=await reviewCurrentWork({...request,review_mode:'observe',focus_element_ids:[101],context_bbox_min_xyz:[-1,-1,0],context_bbox_max_xyz:[1,1,0]},f.h);
 assert.equal(initial.state,'unavailable');assert.equal(f.calls.captures.length,1);assert.equal(f.calls.providers.length,0);
});

for(const checks of [undefined,[]])test('observation recheck preserves optional empty checks: '+(checks===undefined?'omitted':'empty'),async()=>{
 const f=setup();const first=await reviewCurrentWork({...request,review_mode:'observe',checks},f.h);assert.equal(first.state,'observed',first.reason);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_optional_checks'},review:first,capture:{evidence_ref:{evidence_id:first.capture.evidence_id,content_hash:first.capture.content_hash,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image},reference:null});
 const second=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_optional_checks'},f.h);
 assert.equal(second.state,'observed',second.reason);assert.deepEqual(second.request.checks,[]);assert.equal(f.calls.captures.length,2);assert.equal(f.calls.providers.length,0);
 assert.equal(second.native_postcondition_verified,false);assert.equal(second.whole_task_verified,false);
 const independent=await reviewCurrentWork({view_id:41,recheck_evidence_id:'ev1_optional_checks'},f.h);assert.equal(independent.state,'unavailable');assert.equal(f.calls.providers.length,0);
});

test('a later drafting pass can change its working questions while refreshing the same area and reference',async()=>{
 const f=setup(),focus=[];
 f.h.focusTarget=async t=>{focus.push(t);return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:t.show_element_ids?'elements_and_bounds':'bounds',native_navigation_only:true}};};
 const reference={filename:'reference.png',evidence_ref:{evidence_id:'ev1_source',content_hash:'sha256:'+sha,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image};
 f.h.referenceImage=async()=>reference;
 const first=await reviewCurrentWork({...request,review_mode:'observe',reference_filename:'reference.png',focus_element_ids:[101],context_bbox_min_xyz:[-1,-1,0],context_bbox_max_xyz:[1,1,0]},f.h);
 assert.equal(first.state,'observed',first.reason);
 const prior=structuredClone(first);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_geometry_area'},review:first,capture:{evidence_ref:{...first.capture,media_type:'image/png'},image_url:'data:image/png;base64,'+image},reference});
 const questions=[{id:'sizes',expected:'Compare visible duct size labels and their leaders with the reference in this area.'}];
 const second=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_geometry_area',checks:questions},f.h);
 assert.equal(second.state,'observed',second.reason);
 assert.deepEqual(second.request.checks,questions);
 assert.deepEqual(first,prior,'A later working pass cannot rewrite the retained original observation');
 assert.deepEqual(focus[1],{view_id:41,bbox_min_xyz:[-1,-1,0],bbox_max_xyz:[1,1,0]});
 assert.equal(f.calls.captures.length,2);assert.equal(f.calls.providers.length,0);
 assert.equal(second.reference.evidence_id,'ev1_source');
 assert.equal(second.native_postcondition_verified,false);assert.equal(second.whole_task_verified,false);
 const shown=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_later_pass'}]})},second,'ev1_later_pass');
 const images=shown.output.filter(i=>i.type==='input_image');
 assert.equal(images.length,2,'Both actual model and source pixels must reach the actor');
 assert(images.every(i=>i.image_url==='data:image/png;base64,'+image));
});

test('new working questions never change independent-review or observation authority',()=>{
 const check={id:'sizes',expected:'Compare visible size labels.'};
 assert.throws(()=>normalizeVisualReviewRequest({view_id:41,recheck_evidence_id:'ev1_area',checks:[check]}),/recheck_or_checks_invalid/);
 assert.throws(()=>normalizeVisualReviewRequest({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area',checks:[check],complete_inspection_item_id:'final'}),/observation_scope_invalid/);
 assert.throws(()=>normalizeVisualReviewRequest({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area',checks:[check],code_evidence_ids:['ev1_code']}),/observation_scope_invalid/);
 for(const checks of [null,{},'sizes',Array(9).fill(check),[check,check],[{id:'bad',expected:''}]])
  assert.throws(()=>normalizeVisualReviewRequest({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area',checks}),/visual_review_/);
 const omitted=normalizeVisualReviewRequest({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area'});
 assert.equal(Object.hasOwn(omitted,'checks'),false);
 const cleared=normalizeVisualReviewRequest({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area',checks:[]});
 assert.deepEqual(cleared.checks,[]);
});
