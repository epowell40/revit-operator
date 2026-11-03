import test from 'node:test';
const modelText = output => Array.isArray(output) ? output.find(item => item.type === 'input_text').text : output;
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reviewCurrentWork,visualWorkReviewModelOutput,normalizeVisualReviewRequest,VISUAL_WORK_REVIEW_TOOL} from './visual_work_review.mjs';
import {reviewTestPng} from './fixtures/visual-review-image.mjs';
import {nativeSheetRenderState,sameNativeSheetRendering} from './native_sheet_render_state.mjs';
const names=['ExplodedView','PreviewFamilyVisibility','RevealConstraints','RevealHiddenElements','TemporaryHideIsolate','TemporaryViewProperties','WorksharingDisplay'];
const render=()=>({schema:'operator.sheet-render-state.v1',state:'available',scope:'sheet_and_placed_views',viewId:41,viewUniqueId:'sheet',modeNames:names,
 views:[{viewId:41,viewUniqueId:'sheet',customizedTemporaryMode:false,temporaryModes:names.map(name=>({name,active:false}))},
 {viewId:51,viewUniqueId:'placed',customizedTemporaryMode:false,temporaryModes:names.map(name=>({name,active:false}))}],activeViewportCornersXyz:[[0,0,0],[4,3,0]]});
function fixture(mode='target_view'){
 const owner={assignment_id:'a',session_id:'s',run_id:'r',generation:1,document_fingerprint:'project'};
 let paid=false,captures=0;const now=Date.now(),images=[],contexts=[];
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Model',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Sheet',type:'DrawingSheet',sheetRenderState:render()}},
 nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,documentSessionId:'doc',epoch:'epoch',throughSequence:2,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},
 canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const host={owner:()=>owner,assertControl:async()=>{},now:()=>now,readTargetContext:async()=>{const c=context();contexts.push(c);return c;},
 captureTarget:async(_location,args)=>{const captureMode=args?.capture_mode??mode;const bytes=reviewTestPng(80,60,captures++?240:255),hash=createHash('sha256').update(bytes).digest('hex');
 return{image_base64:bytes.toString('base64'),mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'sheet',viewName:'Sheet',viewType:'DrawingSheet',sheetNumber:'S1',
 timestamp:new Date(now).toISOString(),exportMode:captureMode==='target_view'?'full_view':'visible_region',widthPx:80,heightPx:60,bytes:bytes.length,sha256:hash,sheetRenderState:render(),
 viewport:captureMode==='target_view'?null:{source:'UIDocument.ActiveView/UIView.GetZoomCorners',viewId:41,viewType:'DrawingSheet',zoomCornersXyz:[[0,0,0],[4,3,0]],coordinateUnits:'feet',displayPlaneOnly:true,placementMappingAvailable:false},
 canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}};},
 retainImage:async image=>{const b=Buffer.from(image,'base64');images.push(b);return{ref:{evidence_id:'ev1_'+images.length,content_hash:'sha256:'+createHash('sha256').update(b).digest('hex'),byte_count:b.length}};},
 settings:()=>({model:'approved-test-model',reasoning_effort:'medium'}),userRequest:()=> 'Make the schedule legible and clear of neighboring content.',
 requestResponse:async()=>{paid=true;return{id:'resp_review',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'clear',status:'matched',observed:'The captured artifact shows the schedule clear of its neighbor.',correction:''}]})};}};
 return{host,context,owner,images,contexts,paid:()=>paid,captures:()=>captures,request:{view_id:41,capture_mode:mode,checks:[{id:'clear',expected:'Schedule clear of its neighbor.'}]}};
}

for(const mode of ['target_view','native_visible_region'])test(mode+' reviews one retained artifact with current native render state, not another regenerated timestamp',async()=>{
 const f=fixture(mode),r=await reviewCurrentWork(f.request,f.host);
 assert.equal(r.state,'matched');assert.equal(f.captures(),1);assert.equal(f.images.length,1);
 assert.equal(r.raw_review_evidence.capture_recheck.method,'native_revision_and_sheet_render_state');
 assert.equal(r.raw_review_evidence.capture_recheck.pixels_reexported,false);assert.equal(r.raw_review_evidence.capture_recheck.pixels_unchanged,null);
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 const out=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev_review'}]})},r,'ev_review');
 assert.match(modelText(out.output),/immutable_native_sheet_artifact_with_current_native_revision_and_render_state/);
 assert(!modelText(out.output).includes('"native_postcondition_verified":true'));
});

const negatives={
 epoch:c=>c.nativeChangeObservations.epoch='new',sequence:c=>c.nativeChangeObservations.throughSequence++,
 session:c=>{c.document.sessionId='other';c.nativeChangeObservations.documentSessionId='other';},project:c=>c.document.projectIdentity.fingerprint='other',
 view:c=>c.document.activeView.id=42,unknown:c=>c.outcome_unknown=true,
 temporary:c=>c.document.activeView.sheetRenderState.views[1].temporaryModes[0].active=true,
 customized:c=>c.document.activeView.sheetRenderState.views[1].customizedTemporaryMode=true,
 lostObservation:c=>delete c.document.activeView.sheetRenderState,
 replacedPlacedView:c=>c.document.activeView.sheetRenderState.views[1].viewUniqueId='replacement'
};
for(const [name,mutate]of Object.entries(negatives))test('immutable artifact still rejects '+name+' after the reviewer',async()=>{
 const f=fixture(),read=f.host.readTargetContext;f.host.readTargetContext=async()=>{const c=await read();if(f.paid())mutate(c);return c;};
 const r=await reviewCurrentWork(f.request,f.host);assert.equal(r.state,'unavailable');assert.deepEqual(r.checks,[]);
 assert.equal(f.captures(),1,'changed currentness must not silently retry or export again');
});
for(const stop of ['pause','owner','direction'])test('immutable artifact retains '+stop+' control',async()=>{
 const f=fixture();if(stop==='pause')f.host.assertControl=async()=>{if(f.paid())throw Error('Paused');};
 if(stop==='owner')f.host.owner=()=>f.paid()?{...f.owner,generation:2}:f.owner;
 if(stop==='direction')f.host.userRequest=()=>f.paid()?'Changed instruction':'Original instruction';
 assert.equal((await reviewCurrentWork(f.request,f.host)).state,'unavailable');
});
test('old or incomplete native observations keep pixel-recheck behavior and do not gain snapshot authority',async()=>{
 const f=fixture(),read=f.host.readTargetContext;f.host.readTargetContext=async()=>{const c=await read();delete c.document.activeView.sheetRenderState;return c;};
 const r=await reviewCurrentWork(f.request,f.host);assert.equal(r.reason,'visual_review_visible_frame_changed_during_review');assert.equal(f.captures(),2);
});
test('a changed visible-region viewport rejects even if the persistent model is unchanged',async()=>{
 const f=fixture('native_visible_region'),read=f.host.readTargetContext;
 f.host.readTargetContext=async()=>{const c=await read();if(f.paid())c.document.activeView.sheetRenderState.activeViewportCornersXyz[0][0]=-1;return c;};
 assert.equal((await reviewCurrentWork(f.request,f.host)).reason,'visual_review_render_state_changed_during_review');assert.equal(f.captures(),1);
});
test('an uncertain or mismatch reviewer is never promoted by stable native render inputs',async()=>{
 for(const state of ['uncertain','mismatch']){
  const f=fixture();f.host.requestResponse=async()=>({id:'review',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'clear',status:state,observed:'Content is clipped or not clear enough.',correction:'Inspect the affected region.'}]})});
  assert.equal((await reviewCurrentWork(f.request,f.host)).state,state);assert.equal(f.captures(),1);
 }
});
test('render observations reject incomplete modes, unknown flags, duplicate and foreign views',()=>{
 for(const mutate of [r=>r.modeNames=[],r=>r.views[0].temporaryModes.pop(),r=>r.views[0].temporaryModes[0].active=null,r=>r.views.push(r.views[0]),r=>r.views[0].viewUniqueId='other',r=>r.state='unavailable']){
  const r=structuredClone(render());mutate(r);assert.equal(nativeSheetRenderState(r,41,'sheet'),null);
 }
 const a=nativeSheetRenderState(render(),41,'sheet'),b=structuredClone(a);b.activeViewportCornersXyz[0][0]=-1;
 assert.equal(sameNativeSheetRendering(a,b,'full_view'),true);assert.equal(sameNativeSheetRendering(a,b,'visible_region'),false);
});

test('one image carries all requested visual checks without sending the host render guard inventory as model input',async()=>{
 const f=fixture('native_visible_region');let providerCalls=0;
 f.request.checks=[{id:'readable',expected:'Schedule text readable.'},{id:'clearance',expected:'Schedule and required neighboring border are separated.'}];
 f.host.requestResponse=async body=>{
  providerCalls++;const content=body.input[0].content,request=JSON.parse(content.find(x=>x.type==='input_text').text);
  assert.equal(content.filter(x=>x.type==='input_image').length,1);
  assert.deepEqual(request.checks,f.request.checks);
  assert.equal(request.location.sheet_render_state,undefined);assert.equal(request.capture.frame.sheet_render_state,undefined);
  assert.equal(request.capture.frame.view_id,41);assert.equal(request.capture.frame.viewport.viewId,41);
  assert.equal(request.capture.frame.pixel_to_model_mapping,false);
  return{id:'review',status:'completed',output:[],output_text:JSON.stringify({checks:f.request.checks.map(c=>({id:c.id,status:'matched',observed:c.expected,correction:''}))})};
 };
 const r=await reviewCurrentWork(f.request,f.host);assert.equal(r.state,'matched');assert.equal(providerCalls,1);assert.equal(f.captures(),1);
 assert(r.raw_review_evidence.capture_frame.sheet_render_state,'Full host guard observations remain retained.');
});

test('explicit detail and sheet context use one reviewer call with two independently bound current images',async()=>{
 const f=fixture('native_visible_region');let calls=0;
 f.request.include_sheet_context=true;
 f.host.requestResponse=async body=>{
  calls++;const content=body.input[0].content,metadata=JSON.parse(content[0].text);
  assert.equal(content.filter(x=>x.type==='input_image').length,2);
  assert.equal(metadata.sheet_context.relationship,'same_native_sheet_state');
  assert.equal(metadata.sheet_context.frame.export_mode,'full_view');
  assert.equal(metadata.sheet_context.frame.sheet_render_state,undefined);
  assert.equal(metadata.capture.frame.export_mode,'visible_region');
  assert.notEqual(metadata.sheet_context.evidence_id,metadata.capture.evidence_id);
  assert.match(metadata.limits,/together/);
  return{id:'review',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'clear',status:'matched',observed:'Both current images supply the requested context and detail.',correction:''}]})};
 };
 const result=await reviewCurrentWork(f.request,f.host);
 assert.equal(result.state,'matched');assert.equal(calls,1);assert.equal(f.captures(),2);assert.equal(f.images.length,2);
 assert.equal(result.sheet_context.frame.view_id,41);assert.equal(result.sheet_context.frame.pixel_to_model_mapping,false);
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 const projected=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'review'}]})},result,'review');
 const feedback=JSON.parse(modelText(projected.output)).evidence_projections[0].visual_work_review;
 assert.equal(feedback.sheet_context.content_hash,result.sheet_context.content_hash);assert.equal(feedback.sheet_context.pixel_aligned,false);
 assert.equal(feedback.native_postcondition_verified,false);assert(!modelText(projected.output).includes('temporaryModes'));assert(Buffer.byteLength(modelText(projected.output))<=8192);
});

test('sheet context is explicit and rejects unsupported modes, rechecks and nonbooleans before any call',()=>{
 assert.equal(VISUAL_WORK_REVIEW_TOOL.parameters.properties.include_sheet_context.type,'boolean');
 const f=fixture('native_visible_region');
 for(const value of ['true',1,null,{}])assert.throws(()=>normalizeVisualReviewRequest({...f.request,include_sheet_context:value}));
 for(const mode of ['visible_work','target_view',undefined])assert.throws(()=>normalizeVisualReviewRequest({...f.request,capture_mode:mode,include_sheet_context:true}));
 assert.throws(()=>normalizeVisualReviewRequest({view_id:41,capture_mode:'native_visible_region',include_sheet_context:true,recheck_evidence_id:'prior'}));
 assert.deepEqual(normalizeVisualReviewRequest({...f.request,include_sheet_context:false}),normalizeVisualReviewRequest(f.request));
});

for(const [name,mutate]of Object.entries(negatives))test('paired context rejects '+name+' after reviewer without another export or call',async()=>{
 const f=fixture('native_visible_region');f.request.include_sheet_context=true;
 const read=f.host.readTargetContext;f.host.readTargetContext=async()=>{const c=await read();if(f.paid())mutate(c);return c;};
 const result=await reviewCurrentWork(f.request,f.host);
 assert.equal(result.state,'unavailable');assert.deepEqual(result.checks,[]);assert.equal(f.captures(),2);
});

for(const [name,mutate]of Object.entries({
 foreignView:v=>v.native_result.viewId=42,foreignDocument:v=>v.native_result.documentSessionId='other',foreignProcess:v=>v.native_result.processId=999,
 foreignProject:v=>v.native_result.projectFingerprint='other',unknown:v=>v.native_result.canonical_attempt_settlement.outcome_unknown=true,
 badHash:v=>v.native_result.sha256='0'.repeat(64),lostRender:v=>delete v.native_result.sheetRenderState,
 temporary:v=>v.native_result.sheetRenderState.views[1].temporaryModes[0].active=true,
 wrongMode:v=>v.native_result.exportMode='visible_region',oldCapture:v=>v.native_result.timestamp='2020-01-01T00:00:00Z'
}))test('paired context refuses '+name+' before spending reviewer usage',async()=>{
 const f=fixture('native_visible_region');f.request.include_sheet_context=true;const capture=f.host.captureTarget;
 f.host.captureTarget=async(l,args)=>{const value=await capture(l,args);if(args.capture_mode==='target_view')mutate(value);return value;};
 const result=await reviewCurrentWork(f.request,f.host);assert.equal(result.state,'unavailable');assert.equal(f.paid(),false);assert.equal(f.captures(),2);
});

test('pair requires complete render inputs instead of silently replacing a legacy screenshot or native fallback',async()=>{
 const f=fixture('native_visible_region');f.request.include_sheet_context=true;const read=f.host.readTargetContext;
 f.host.readTargetContext=async()=>{const c=await read();delete c.document.activeView.sheetRenderState;return c;};
 const result=await reviewCurrentWork(f.request,f.host);assert.equal(result.reason,'visual_review_sheet_context_render_state_required');assert.equal(f.paid(),false);assert.equal(f.captures(),1);
});

for(const stop of ['pause','owner','direction'])test('paired context retains '+stop+' control',async()=>{
 const f=fixture('native_visible_region');f.request.include_sheet_context=true;
 if(stop==='pause')f.host.assertControl=async()=>{if(f.paid())throw Error('Paused');};
 if(stop==='owner')f.host.owner=()=>f.paid()?{...f.owner,generation:2}:f.owner;
 if(stop==='direction')f.host.userRequest=()=>f.paid()?'Changed instruction':'Original instruction';
 assert.equal((await reviewCurrentWork(f.request,f.host)).state,'unavailable');
});

test('paired images preserve uncertain and mismatch verdicts without retries',async()=>{
 for(const state of ['uncertain','mismatch']){
  const f=fixture('native_visible_region');f.request.include_sheet_context=true;let count=0;
  f.host.requestResponse=async()=>{count++;return{id:'review',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'clear',status:state,observed:'Evidence is insufficient or visibly wrong.',correction:'Inspect or correct only the required scope.'}]})};};
  const result=await reviewCurrentWork(f.request,f.host);assert.equal(result.state,state);assert.equal(count,1);assert.equal(f.captures(),2);
 }
});

test('context retained-byte mismatch never reaches the model',async()=>{
 const f=fixture('native_visible_region');f.request.include_sheet_context=true;const retain=f.host.retainImage;
 f.host.retainImage=async(image,meta)=>{const r=await retain(image,meta);if(meta.capture_role==='sheet_context')r.ref.content_hash='sha256:'+'0'.repeat(64);return r;};
 const result=await reviewCurrentWork(f.request,f.host);assert.equal(result.reason,'visual_review_sheet_context_retention_mismatch');assert.equal(f.paid(),false);
});
