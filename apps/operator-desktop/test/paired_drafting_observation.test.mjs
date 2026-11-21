import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import fs from 'node:fs';
import {reviewCurrentWork,normalizeVisualReviewRequest,visualWorkReviewModelOutput,VISUAL_WORK_REVIEW_TOOL}from'../visual_work_review.mjs';import {reviewTestPng}from'../../../packages/operator-assistant-ui/fixtures/visual-review-image.mjs';
const bytes=reviewTestPng(40,40),image=bytes.toString('base64'),sha=createHash('sha256').update(bytes).digest('hex');
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'},request={view_id:41,capture_mode:'native_visible_region',checks:[{id:'gap',expected:'No extra blank row below headings; keep visible borders.'}]};
function setup(){let clock=Date.now();const calls={contexts:0,captures:[],providers:[],images:[]};
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Mechanical',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Notes, Symbols & Schedules',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const capture=()=>({image_base64:image,mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'target-unique',viewName:'Notes, Symbols & Schedules',viewType:'DrawingSheet',sheetNumber:'M002',timestamp:new Date(clock).toISOString(),exportMode:'visible_region',widthPx:40,heightPx:40,bytes:bytes.length,sha256:sha,viewport:{source:'UIDocument.ActiveView/UIView.GetZoomCorners',viewId:41,viewType:'DrawingSheet',zoomCornersXyz:[[-1,1,0],[1,-1,0]],coordinateUnits:'feet',displayPlaneOnly:true,placementMappingAvailable:false},canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}});
 const h={prepareFocusedInspection:async r=>({state:'prepared',item_id:r.complete_inspection_item_id}),owner:()=>owner,assertControl:async()=>{},now:()=>clock,readContext:async()=>{throw Error('No screenshot context fallback');},capture:async()=>{throw Error('No UI pixels/tooltips fallback');},readTargetContext:async()=>{calls.contexts++;return context();},captureTarget:async(location,args)=>{calls.captures.push(args);return capture();},retainImage:async pixels=>{calls.images.push(pixels);const b=Buffer.from(pixels,'base64');return{ref:{evidence_id:'ev1_image'+calls.images.length,content_hash:'sha256:'+createHash('sha256').update(b).digest('hex'),byte_count:b.length}};},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Fix blank row in AIR DEVICE SCHEDULE on M002 and preserve borders.',requestResponse:async body=>{calls.providers.push(body);clock+=60000;return{id:'resp_region',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'Synthetic relevant native view pixels.',correction:''}]})};}};
 return{h,calls,context,capture};}

test('an observation refresh restores the retained area and returns fresh pixels without a reviewer',async()=>{
 const f=setup(),focus=[];
 f.h.focusTarget=async t=>{focus.push(t);return {ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements_and_bounds',native_navigation_only:true}};};
 const area={...request,review_mode:'observe',focus_element_ids:[101,102],context_bbox_min_xyz:[-1,-1,0],context_bbox_max_xyz:[1,1,0]};
 const first=await reviewCurrentWork(area,f.h);
 assert.equal(first.state,'observed');
 const pixels={evidence_ref:{evidence_id:first.capture.evidence_id,content_hash:first.capture.content_hash,byte_count:bytes.length,media_type:'image/png'},image_url:'data:image/png;base64,'+image};
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area'},review:first,capture:pixels,reference:null});
 const refreshed=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area'},f.h);
 assert.equal(refreshed.state,'observed',refreshed.reason);
 assert.deepEqual(focus[1],focus[0]);
 assert.equal(f.calls.captures.length,2);
 assert.equal(f.calls.providers.length,0);
 assert.equal(refreshed.native_postcondition_verified,false);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area2'},review:refreshed,capture:{...pixels,evidence_ref:{...pixels.evidence_ref,evidence_id:refreshed.capture.evidence_id}},reference:null});
 const again=await reviewCurrentWork({view_id:41,review_mode:'observe',recheck_evidence_id:'ev1_area2'},f.h);
 assert.equal(again.state,'observed',again.reason);
 assert.deepEqual(focus[2],focus[0]);
 f.h.readBaseline=async()=>({evidence_ref:{evidence_id:'ev1_area'},review:first,capture:pixels,reference:null});
 const shown=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_new'}]})},refreshed,'ev1_new');
 assert(Array.isArray(shown.output));
 assert(shown.output.some(i=>i.type==='input_image'));
 const forbidden=await reviewCurrentWork({view_id:41,recheck_evidence_id:'ev1_area'},f.h);
 assert.equal(forbidden.state,'unavailable');
 assert.equal(f.calls.providers.length,0);
});
