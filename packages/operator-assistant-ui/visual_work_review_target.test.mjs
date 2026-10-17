import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import fs from 'node:fs';import {reviewTestPng}from'./fixtures/visual-review-image.mjs';
import {reviewCurrentWork,normalizeVisualReviewRequest,visualWorkReviewModelOutput}from'./visual_work_review.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC';
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'};
const request={view_id:41,capture_mode:'target_view',checks:[{id:'gap',expected:'No extra blank row below headings.'}]};
function setup(status='mismatch'){
 let clock=Date.parse('2026-10-17T16:00:00Z');const calls={contexts:0,captures:0,providers:[],images:[]};
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Mechanical',projectIdentity:{fingerprint:'project'},activeView:{id:7,name:'Cover Sheet',type:'DrawingSheet'}},
  nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},
  canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const capture=()=>({image_base64:image,mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:7,viewUniqueId:'target-unique',viewName:'Notes, Symbols & Schedules',viewType:'DrawingSheet',sheetNumber:'M002',
  timestamp:new Date(clock).toISOString(),exportMode:'full_view',widthPx:40,heightPx:40,bytes:Buffer.from(image,'base64').length,sha256:createHash('sha256').update(Buffer.from(image,'base64')).digest('hex'),
  canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}});
 const h={owner:()=>owner,assertControl:async()=>{},now:()=>clock,readContext:async()=>{throw Error('Must not substitute current-screen context');},capture:async()=>{throw Error('Must not capture unrelated screen');},
  readTargetContext:async()=>{calls.contexts++;return context();},captureTarget:async()=>{calls.captures++;return capture();},
  retainImage:async(pixels,metadata)=>{calls.images.push({pixels,metadata});return{ref:{evidence_id:'ev1_capture'+calls.images.length,content_hash:'sha256:'+createHash('sha256').update(Buffer.from(pixels,'base64')).digest('hex'),byte_count:Buffer.from(pixels,'base64').length}};},
  settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Remove the extra blank row from AIR DEVICE SCHEDULE on M002.',
  requestResponse:async body=>{calls.providers.push(body);clock+=60000;return{id:'resp_target',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status,observed:'An extra blank band is visible below headings.',correction:status==='mismatch'?'Remove only the blank data row.':''}]})};}};
 return{h,calls,context,capture};
}
test('native target review examines actual inactive M002 pixels and keeps sheet identity through long reviewer latency',async()=>{
 const {h,calls}=setup(),result=await reviewCurrentWork(request,h);assert.equal(result.state,'mismatch');assert.equal(calls.contexts,4);assert.equal(calls.captures,2);assert.equal(calls.images.length,1);
 assert.equal(result.location.view_id,41);assert.equal(result.location.sheet_number,'M002');assert.equal(result.location.active_view_id,7);assert.equal(result.location.view_unique_id,'target-unique');
 assert.equal(result.capture.frame.kind,'native_target_view');assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 const body=calls.providers[0];assert.deepEqual(body.tools,[]);assert.equal(body.previous_response_id,undefined);assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,'+image);
 const prompt=JSON.parse(body.input[0].content[0].text);assert.match(prompt.limits,/need not be active/);assert.equal(prompt.location.sheet_number,'M002');assert.equal(prompt.capture.content_hash,result.capture.content_hash);
 const projected=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})},result,'ev1_review');
 const feedback=JSON.parse(projected.output).evidence_projections[0].visual_work_review;assert.equal(feedback.location.sheet_number,'M002');assert.equal(feedback.capture.width,40);assert(Buffer.byteLength(projected.output)<=8192);
});
test('unrelated active view may change, but model, project, process, session and sequence cannot change during target review',async()=>{
 const allowed=setup();allowed.h.readTargetContext=async()=>{const c=allowed.context();c.document.activeView.id=++allowed.calls.contexts;return c;};assert.equal((await reviewCurrentWork(request,allowed.h)).state,'mismatch');
 for(const alter of [c=>{c.nativeChangeObservations.throughSequence=1;},c=>{c.document.sessionId='other';c.nativeChangeObservations.documentSessionId='other';},c=>{c.process_id=456;c.nativeChangeObservations.processId=456;},c=>{c.nativeChangeObservations.epoch='other';},c=>{c.document.projectIdentity.fingerprint='foreign';}]){
  const f=setup();f.h.readTargetContext=async()=>{const c=f.context();if(++f.calls.contexts>=3)alter(c);return c;};const result=await reviewCurrentWork(request,f.h);assert.equal(result.state,'unavailable');assert.equal(f.calls.providers.length,1);assert.equal(result.whole_task_verified,false);
 }
});
test('failed standalone schedule export, wrong target, missing native settlement, corrupt pixels and old capture fail without a reviewer or UI fallback',async()=>{
 for(const alter of [c=>{c.native_result={error:'some of the views is not exportable'};},c=>{c.native_result.viewId=7;},c=>{c.native_result.documentSessionId='foreign';},c=>{c.native_result.projectFingerprint='foreign';},c=>{c.native_result.processId=456;},c=>{delete c.native_result.canonical_attempt_settlement;},c=>{c.native_result.sha256='a'.repeat(64);},c=>{c.native_result.timestamp='2020-01-01T00:00:00Z';}]){
  const f=setup();f.h.captureTarget=async()=>{const c=f.capture();alter(c);return c;};const result=await reviewCurrentWork(request,f.h);assert.equal(result.state,'unavailable');assert.equal(f.calls.providers.length,0);assert.equal(result.raw_review_evidence.native_target_exports.length,1);
 }
 for(const alter of [c=>{c.document=null;},c=>{c.canonical_attempt_settlement.effect_state='unknown';}]){const f=setup();f.h.readTargetContext=async()=>{const c=f.context();alter(c);return c;};assert.equal((await reviewCurrentWork(request,f.h)).state,'unavailable');assert.equal(f.calls.captures,0);assert.equal(f.calls.providers.length,0);}
});
test('changed target pixels retain both images and invalidate the review rather than reporting a match',async()=>{
 const f=setup('matched');f.h.captureTarget=async()=>{const c=f.capture();if(++f.calls.captures===2){const bytes=Buffer.from(c.image_base64,'base64');bytes[bytes.length-1]^=1;c.image_base64=bytes.toString('base64');c.native_result.sha256=createHash('sha256').update(bytes).digest('hex');}return c;};
 const result=await reviewCurrentWork(request,f.h);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_visible_frame_changed_during_review');assert.equal(f.calls.images.length,2);assert.equal(result.raw_review_evidence.capture_recheck.evidence_ref.evidence_id,'ev1_capture2');assert.notEqual(f.calls.images[0].pixels,f.calls.images[1].pixels);
});
test('retained pixels must match native image identity; modes and resolution are bounded, actor image/path injection stays forbidden',async()=>{
 const f=setup();f.h.retainImage=async()=>({ref:{evidence_id:'ev1_wrong',content_hash:'sha256:'+'a'.repeat(64),byte_count:1}});assert.equal((await reviewCurrentWork(request,f.h)).reason,'visual_review_target_retention_mismatch');assert.equal(f.calls.providers.length,0);
 assert.equal(normalizeVisualReviewRequest(request).image_size,4000);
 for(const bad of [{...request,capture_mode:'auto'},{...request,image_size:100000},{...request,image_size:1023},{...request,path:'other.png'},{...request,image_base64:image}])assert.throws(()=>normalizeVisualReviewRequest(bad));
});

const retained167=JSON.parse(fs.readFileSync(new URL('./fixtures/visual-review-resolution167.json',import.meta.url),'utf8'));
test('exact167 visible-work request tolerates an unused valid export-size hint without weakening screen checks',()=>{
 const normalized=normalizeVisualReviewRequest(retained167.next_request);assert.equal(normalized.capture_mode,'visible_work');assert.equal(normalized.image_size,undefined);
 assert.throws(()=>normalizeVisualReviewRequest({...retained167.next_request,capture_mode:'auto'}));
});
test('exact167 high-resolution target is bounded once and its effective resolution is reused for the fresh recheck',async()=>{
 const f=setup(),sizes=[],cache=new Map();f.h.captureTarget=async(location,args)=>{sizes.push(args.image_size);const width=args.image_size,height=Math.floor(width*retained167.native_dimensions.heightPx/retained167.native_dimensions.widthPx);
  if(!cache.has(width))cache.set(width,reviewTestPng(width,height));const bytes=cache.get(width),c=f.capture();c.image_base64=bytes.toString('base64');Object.assign(c.native_result,{widthPx:width,heightPx:height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});return c;};
 const result=await reviewCurrentWork({...request,image_size:6000},f.h);assert.equal(result.state,'mismatch');assert.equal(sizes.length,3);assert.equal(sizes[0],6000);assert(sizes[1]<6000&&sizes[1]>=1024);assert.equal(sizes[1],sizes[2]);
 assert(result.capture.frame.width*result.capture.frame.height<=24000000);assert.equal(result.capture_resolution.requested_width,6000);assert.equal(result.capture_resolution.effective_width,sizes[1]);assert.equal(result.raw_review_evidence.native_target_exports.length,3);assert.equal(f.calls.providers.length,1);assert.equal(result.native_postcondition_verified,false);
});
test('oversized wrong-document image never gets a resolution retry or reviewer call',async()=>{
 const f=setup();let captures=0;f.h.captureTarget=async()=>{captures++;const bytes=reviewTestPng(6000,4285),c=f.capture();c.image_base64=bytes.toString('base64');Object.assign(c.native_result,{documentSessionId:'other',widthPx:6000,heightPx:4285,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});return c;};
 const r=await reviewCurrentWork({...request,image_size:6000},f.h);assert.equal(r.state,'unavailable');assert.equal(captures,1);assert.equal(f.calls.providers.length,0);
});
test('resolution adjustment is read-only and refuses scene changes, changed target identity or a second oversized export',async()=>{
 const bytes=reviewTestPng(6000,4285),digest=createHash('sha256').update(bytes).digest('hex');
 for(const issue of ['scene','target','still-oversized']){const f=setup();let captures=0,contexts=0;f.h.readTargetContext=async()=>{const c=f.context();if(issue==='scene'&&++contexts===2)c.nativeChangeObservations.throughSequence=1;return c;};
  f.h.captureTarget=async()=>{const c=f.capture();if(++captures===1||issue==='still-oversized'){c.image_base64=bytes.toString('base64');Object.assign(c.native_result,{widthPx:6000,heightPx:4285,bytes:bytes.length,sha256:digest});}else if(issue==='target')c.native_result.viewUniqueId='different-target';return c;};
  const r=await reviewCurrentWork({...request,image_size:6000},f.h);assert.equal(r.state,'unavailable',issue);assert.equal(captures,issue==='scene'?1:2,issue);assert.equal(f.calls.providers.length,0,issue);
  assert.match(r.reason,/scene_changed_before_resolution|target_identity_changed|pixel_limit_exceeded/);
 }
});
test('extreme target aspect ratio asks for a focused view instead of spinning on exports',async()=>{
 const f=setup();let captures=0;f.h.captureTarget=async()=>{captures++;const bytes=reviewTestPng(1024,25000),c=f.capture();c.image_base64=bytes.toString('base64');Object.assign(c.native_result,{widthPx:1024,heightPx:25000,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});return c;};
 const r=await reviewCurrentWork({...request,image_size:1024},f.h);assert.equal(r.reason,'visual_review_target_aspect_ratio_requires_focused_view');assert.equal(captures,1);assert.equal(f.calls.providers.length,0);
});
