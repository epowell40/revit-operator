import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reviewTestPng} from './fixtures/visual-review-image.mjs';
import {reviewCurrentWork, normalizeVisualReviewRequest, validateVisualReviewBaseline, visualWorkReviewModelOutput, VISUAL_WORK_REVIEW_TOOL} from './visual_work_review.mjs';

const bytes=reviewTestPng(40,40), image=bytes.toString('base64'), hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
function envelopeText(value){
 if(typeof value==='string')return value;
 assert(Array.isArray(value));const texts=value.filter(block=>block.type==='input_text');
 assert.equal(texts.length,1);assert.equal(typeof texts[0].text,'string');return texts[0].text;
}
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1};
const checks=[{id:'note',expected:'The review note is readable.'},{id:'clearance',expected:'The note is inside the printed border and clear of nearby content.'}];
const location={process_id:123,document_session_id:'doc',epoch:'epoch',through_sequence:2,view_id:41,view_type:'DrawingSheet',view_unique_id:'sheet-unique'};
function fixture(){
 const now=Date.now(), rectangle={x:0,y:0,width:40,height:40};
 const captureFrame={schema:'operator.visual_review_capture.v1',kind:'revit_view',process_id:123,view_id:41,main_window_handle:'0x123',foreground_window_handle:'0x123',rectangle,captured_at_utc:new Date(now).toISOString(),selection_authority:'native_view_or_owned_modal',occlusion_check:'nine_point_screen_grid_not_pixel_exhaustive'};
 const ref={evidence_id:'ev1_detail',content_hash:hash,byte_count:bytes.length,media_type:'image/png'};
 const baseline={evidence_ref:{evidence_id:'ev1_review'},review:{schema:'operator.visual_work_review.v1',ok:true,state:'uncertain',authority:'supporting_visual_assessment',native_postcondition_verified:false,whole_task_verified:false,owner,location:{...location},request:{view_id:41,capture_mode:'native_visible_region',checks},capture:{...ref,frame:{schema:'operator.visual_review_target_capture.v1',kind:'native_target_view',selection_authority:'authorized_native_target_export',process_id:123,document_session_id:'doc',view_id:41,view_unique_id:'sheet-unique',view_type:'DrawingSheet'}},reference:null},capture:{evidence_ref:ref,image_url:'data:image/png;base64,'+image},reference:null};
 const context=()=>({process_id:123,document:{sessionId:'doc',title:'Drawing',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Cover Sheet',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:2,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'},visual_capture_context:{main_window_handle:'0x123',view_rectangle:rectangle}});
 const calls={provider:[],focus:[],exports:0};
 const host={owner:()=>owner,assertControl:async()=>{},now:()=>now,
  readContext:async()=>({schema:'revit-operator.ui-context/v1',authority:'ui_identity_only',state:'available',revision:1,captured_at_utc:new Date(now).toISOString(),context:context()}),readTargetContext:async()=>context(),
  prepareFocusedInspection:async r=>({state:'prepared',item_id:r.complete_inspection_item_id}),
  focusTarget:async r=>{calls.focus.push(r);return{ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}};},
  capture:async()=>({image_base64:image,frame:captureFrame}),captureTarget:async()=>{calls.exports++;throw Error('No implicit export or fallback');},
  retainImage:async p=>{const b=Buffer.from(p,'base64');return{ref:{evidence_id:'ev1_current',content_hash:'sha256:'+createHash('sha256').update(b).digest('hex'),byte_count:b.length}};},
  settings:()=>({model:'gpt-6.1-terra',reasoning_effort:'medium'}),userRequest:()=> 'Add a review note inside the printed border, clear of other content.',readBaseline:async()=>baseline,
  requestResponse:async body=>{calls.provider.push(body);return{id:'resp_screen',status:'completed',output:[],output_text:JSON.stringify({checks:checks.map(c=>({id:c.id,status:'matched',observed:'Synthetic current pixels show the condition.',correction:''}))})};}};
 return{host,calls,baseline,captureFrame,context};
}
const recheck={view_id:41,capture_mode:'visible_work',recheck_evidence_id:'ev1_review'};

test('render guard inventories stay in retained baseline evidence, not the reviewer prompt or model handoff',async()=>{
 const f=fixture(),guard={schema:'operator.sheet-render-state.v1',state:'available',views:Array.from({length:24},(_,i)=>({viewId:i+1,viewUniqueId:'view-'+i,temporaryModes:{RevealHiddenElements:false,TemporaryHideIsolate:false},customized:false}))};
 f.baseline.review.location.sheet_render_state=guard;f.baseline.review.capture.frame.sheet_render_state=guard;
 const r=await reviewCurrentWork(recheck,f.host);assert.equal(r.state,'matched');
 assert.deepEqual(r.baseline.location.sheet_render_state,guard);assert.deepEqual(r.baseline.frame.sheet_render_state,guard);
 const meta=JSON.parse(f.calls.provider[0].input[0].content[0].text);assert.equal(meta.baseline.location.sheet_render_state,undefined);assert.equal(meta.baseline.frame.sheet_render_state,undefined);
 // The complementary path additionally retains its separately checked native state.
 r.baseline.native_state={...location,sheet_render_state:guard};r.baseline.relationship='same_model_state_complementary';r.baseline.pixel_aligned=false;
 const before=JSON.stringify(r),envelope={schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_current_review',content_hash:hash}]};
 const wire=visualWorkReviewModelOutput({output:JSON.stringify(envelope)},r,'ev1_current_review').output,feedback=JSON.parse(envelopeText(wire)).evidence_projections[0].visual_work_review;
 assert(Buffer.byteLength(envelopeText(wire))<=8192);assert.deepEqual(feedback.checks,r.checks);assert.equal(feedback.coverage.complete,true);
 for(const key of ['location','frame','native_state']){const {sheet_render_state,...expected}=r.baseline[key];assert.deepEqual(feedback.baseline[key],expected);}
 assert.equal(feedback.baseline.evidence_id,r.baseline.evidence_id);assert.deepEqual(feedback.baseline.capture,r.baseline.capture);assert.equal(feedback.baseline.relationship,r.baseline.relationship);assert.equal(feedback.baseline.pixel_aligned,false);
 assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);assert.equal(JSON.stringify(r),before);
});
test('explicit native close-up to actual-screen sheet overview keeps original checks and bound before pixels',async()=>{
 const f=fixture(),r=await reviewCurrentWork(recheck,f.host);
 assert.equal(r.state,'matched');assert.equal(f.calls.exports,0);assert.equal(f.calls.provider.length,1);
 assert.deepEqual(r.request.checks,checks);assert.equal(r.capture.frame.kind,'revit_view');
 const content=f.calls.provider[0].input[0].content,meta=JSON.parse(content[0].text);
 assert.equal(content.filter(c=>c.type==='input_image').length,2);assert.equal(content[2].image_url,f.baseline.capture.image_url);
 assert.equal(meta.baseline.frame.kind,'native_target_view');assert.match(meta.limits,/historical/);
 const projected=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_current_review'}]})},r,'ev1_current_review');
 const feedback=JSON.parse(envelopeText(projected.output)).evidence_projections[0].visual_work_review;assert.equal(feedback.capture.kind,'revit_view');assert.equal(feedback.baseline.frame.kind,'native_target_view');assert.equal(feedback.coverage.complete,true);assert.deepEqual(feedback.checks.map(c=>c.expected),checks.map(c=>c.expected));assert.equal(feedback.whole_task_verified,false);
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
});
test('final inspection can explicitly focus and review actual-screen pixels without regenerating a plot timestamp',async()=>{
 const f=fixture(),request={view_id:41,capture_mode:'visible_work',complete_inspection_item_id:'inspect',focus_element_ids:[101,102],checks};
 assert.equal(normalizeVisualReviewRequest(request).capture_mode,'visible_work');
 const r=await reviewCurrentWork(request,f.host);assert.equal(r.state,'matched');assert.equal(f.calls.exports,0);
 assert.deepEqual(f.calls.focus,[{view_id:41,show_element_ids:[101,102]}]);assert.equal(f.calls.provider.length,1);
});
test('cross-capture transition rejects dialogs, foreign ownership/scene, forged source, failed review and corrupt pixels',()=>{
 for(const mutate of [f=>f.captureFrame.kind='revit_dialog',f=>f.baseline.review.location={...location,epoch:'other'},f=>f.baseline.review.owner={...owner,run_id:'foreign'},f=>f.baseline.review.location={...location,view_id:42},f=>f.baseline.review.location={...location,through_sequence:3},f=>f.baseline.review.capture.frame.selection_authority='caller',f=>f.baseline.review.request.capture_mode='visible_work',f=>f.baseline.review.capture.frame.process_id=456,f=>f.baseline.review.capture.frame.document_session_id='foreign',f=>f.baseline.review.capture.frame.view_unique_id='other',f=>f.baseline.review.location={...location,view_type:'Schedule'},f=>f.baseline.review.ok=false,f=>f.baseline.review.state='unavailable',f=>f.baseline.capture.evidence_ref={...f.baseline.capture.evidence_ref,content_hash:'sha256:'+'f'.repeat(64)}]){
  const f=fixture();mutate(f);assert.throws(()=>validateVisualReviewBaseline(f.baseline,recheck,owner,location,f.captureFrame));
 }
});
test('actual-screen recheck still refuses changed pixels, scene, direction and Pause',async()=>{
 for(const problem of ['pixels','scene','direction','pause']){
  const f=fixture();let reviewed=false;const response=f.host.requestResponse;
  f.host.requestResponse=async b=>{const r=await response(b);reviewed=true;return r;};
  if(problem==='pixels')f.host.capture=async()=>({image_base64:reviewed?reviewTestPng(40,40,254).toString('base64'):image,frame:f.captureFrame});
  if(problem==='scene'){const read=f.host.readContext;f.host.readContext=async()=>{const c=await read();if(reviewed)c.context.nativeChangeObservations.throughSequence=3;return c;};}
  if(problem==='direction')f.host.userRequest=()=>reviewed?'Changed task':'Add review note';
  if(problem==='pause')f.host.assertControl=async()=>{if(reviewed)throw Error('Paused');};
  const r=await reviewCurrentWork(recheck,f.host);assert.equal(r.state,'unavailable',problem);assert.equal(f.calls.provider.length,1,problem);assert.equal(r.whole_task_verified,false);
 }
});
test('screen focus fails closed on native-to-screen process/session/sequence mismatch',async()=>{
 for(const property of ['process_id','session','sequence']){const f=fixture(),read=f.host.readContext;f.host.readContext=async()=>{const s=await read();if(property==='process_id'){s.context.process_id=456;s.context.nativeChangeObservations.processId=456;}if(property==='session'){s.context.document.sessionId='other';s.context.nativeChangeObservations.documentSessionId='other';}if(property==='sequence')s.context.nativeChangeObservations.throughSequence=3;return s;};
  const r=await reviewCurrentWork({view_id:41,capture_mode:'visible_work',complete_inspection_item_id:'inspect',focus_element_ids:[101],checks},f.host);assert.equal(r.state,'unavailable');assert.equal(f.calls.provider.length,0);
 }
});
test('discovery prefers adequate current pixels and preserves explicit recheck identity and uncertainty',()=>{
 assert.match(VISUAL_WORK_REVIEW_TOOL.description,/not automatically both a whole-sheet image and a close-up/);assert.match(VISUAL_WORK_REVIEW_TOOL.description,/visible_work/);assert.match(VISUAL_WORK_REVIEW_TOOL.description,/recheck_evidence_id/);assert.match(VISUAL_WORK_REVIEW_TOOL.description,/do not rewrite checks to obtain a match/);assert.match(VISUAL_WORK_REVIEW_TOOL.description,/Uncertain or unavailable is not a mismatch/);
});

function complementaryFixture(){
 const f=fixture();
 Object.assign(f.baseline.review.location,{project_fingerprint:'project',identity_authority:'authorized_native_read'});
 Object.assign(f.baseline.review.capture.frame,{captured_at_utc:new Date(f.host.now()-1000).toISOString(),native_image_sha256:hash.slice(7)});
 return f;
}
test('unchanged native sheet detail and current overview are reassessed together without importing prior verdicts',async()=>{
 const f=complementaryFixture();let reads=0;const read=f.host.readTargetContext;f.host.readTargetContext=async()=>{reads++;return read();};
 f.baseline.review.checks=[{id:'note',status:'matched',observed:'Never copy this old verdict'}];
 const r=await reviewCurrentWork(recheck,f.host),body=f.calls.provider[0],meta=JSON.parse(body.input[0].content[0].text);
 assert.equal(r.state,'matched');assert.equal(meta.baseline.relationship,'same_model_state_complementary');
 assert.match(meta.limits,/Reassess both actual images/);assert.equal(meta.baseline.pixel_aligned,false);
 assert(!JSON.stringify(body).includes('Never copy this old verdict'));assert.equal(reads,2);
 assert.equal(r.whole_task_verified,false);assert.equal(r.native_postcondition_verified,false);
 const projected=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review2'}]})},r,'ev1_review2');
 assert.equal(JSON.parse(envelopeText(projected.output)).evidence_projections[0].visual_work_review.baseline.relationship,'same_model_state_complementary');
});
test('fresh native state change during complementary review prevents a matched result',async()=>{
 const f=complementaryFixture();let reads=0;const read=f.host.readTargetContext;
 f.host.readTargetContext=async()=>{const c=await read();if(++reads===2)c.nativeChangeObservations.throughSequence=3;return c;};
 const r=await reviewCurrentWork(recheck,f.host);assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_complementary_state_changed');assert.equal(f.calls.provider.length,1);
});
test('older observations, missing native provenance and stale images remain historical, never complementary',async()=>{
 for(const mutate of [f=>f.baseline.review.location.through_sequence=1,f=>delete f.baseline.review.location.project_fingerprint,f=>delete f.baseline.review.location.identity_authority,f=>f.baseline.review.capture.frame.captured_at_utc=new Date(f.host.now()-300001).toISOString(),f=>f.baseline.review.capture.frame.captured_at_utc=new Date(f.host.now()+1).toISOString(),f=>delete f.baseline.review.capture.frame.native_image_sha256,f=>delete f.host.readTargetContext]){
  const f=complementaryFixture();mutate(f);const r=await reviewCurrentWork(recheck,f.host);
  assert.equal(r.state,'matched');const meta=JSON.parse(f.calls.provider[0].input[0].content[0].text);
  assert.equal(meta.baseline.relationship,undefined);assert.match(meta.limits,/historical before-image/);
 }
});
test('complementary source requires fresh native process, session, epoch, sequence, project and active view',async()=>{
 for(const mutate of [c=>c.process_id=456,c=>c.document.sessionId='foreign',c=>c.nativeChangeObservations.epoch='foreign',c=>c.nativeChangeObservations.throughSequence=3,c=>c.document.projectIdentity.fingerprint='foreign',c=>c.document.activeView.id=42,c=>c.canonical_attempt_settlement.effect_state='unknown']){
  const f=complementaryFixture(),read=f.host.readTargetContext;f.host.readTargetContext=async()=>{const c=await read();mutate(c);return c;};
  const r=await reviewCurrentWork(recheck,f.host);assert.equal(r.state,'unavailable');assert.equal(f.calls.provider.length,0);assert.equal(r.whole_task_verified,false);
 }
});
test('complementary review still refuses Pause, changed current pixels and revised user direction',async()=>{
 for(const problem of ['pause','pixels','direction']){
  const f=complementaryFixture();let reviewed=false;const response=f.host.requestResponse;
  f.host.requestResponse=async b=>{const r=await response(b);reviewed=true;return r;};
  if(problem==='pause')f.host.assertControl=async()=>{if(reviewed)throw Error('Paused');};
  if(problem==='pixels')f.host.capture=async()=>({image_base64:reviewed?reviewTestPng(40,40,254).toString('base64'):image,frame:f.captureFrame});
  if(problem==='direction')f.host.userRequest=()=>reviewed?'Revised request':'Original request';
  const r=await reviewCurrentWork(recheck,f.host);assert.equal(r.state,'unavailable',problem);assert.equal(r.whole_task_verified,false);
 }
});
